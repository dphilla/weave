// Message transports expose discrete payloads. These adapters intentionally
// erase those boundaries and present one bounded, reliable byte stream.

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export const DEFAULT_MAX_BUFFERED_BYTES = 72 * 1024 * 1024;
export const DEFAULT_MAX_WRITE_BYTES = 64 * 1024 * 1024;

const DEFAULT_HIGH_WATER_MARK = 1024 * 1024;
const DEFAULT_DRAIN_TIMEOUT_MS = 120_000;
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_DATA_CHANNEL_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_DATA_CHANNEL_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_DATA_CHANNEL_CHUNK_BYTES = 16 * 1024;

function asError(value, fallback) {
  if (value instanceof Error) return value;
  return new Error(fallback);
}

function abortError() {
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted", "AbortError");
  }
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function copyBytes(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new TypeError("byte-stream write expects an ArrayBuffer or typed array");
}

async function messageBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new TypeError("byte-stream transport received a non-binary message");
}

function addListener(target, type, listener) {
  if (typeof target.addEventListener === "function") {
    target.addEventListener(type, listener);
    return () => target.removeEventListener(type, listener);
  }
  if (typeof target.on === "function") {
    target.on(type, listener);
    return () => target.off?.(type, listener);
  }
  throw new TypeError("transport is not an EventTarget");
}

function assertFiniteNonNegative(name, value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}

function readSizeError(n, maxBufferedBytes) {
  if (!Number.isSafeInteger(n) || n < 0) {
    return new RangeError("readExact size must be a non-negative safe integer");
  }
  if (n > maxBufferedBytes) {
    return new RangeError(
      `readExact size exceeds the ${maxBufferedBytes} byte receive-buffer limit`,
    );
  }
  return null;
}

/**
 * Adapt an open or connecting WebSocket to a bounded byte-stream API.
 * Message boundaries are not retained.
 */
export class WebSocketByteStream {
  constructor(socket, options = {}) {
    if (!socket || typeof socket.send !== "function") {
      throw new TypeError("WebSocketByteStream requires a WebSocket");
    }

    this.socket = socket;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.maxWriteBytes = options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
    this.highWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS;
    this.chunks = [];
    this.chunkOffset = 0;
    this.bufferedBytes = 0;
    this.waiters = [];
    this.error = null;
    this._incomingTail = Promise.resolve();
    this._writeTail = Promise.resolve();
    this._removeListeners = [];
    this._closedSettled = false;

    for (const [name, value] of [
      ["maxBufferedBytes", this.maxBufferedBytes],
      ["maxWriteBytes", this.maxWriteBytes],
      ["highWaterMark", this.highWaterMark],
      ["drainTimeoutMs", this.drainTimeoutMs],
      ["connectTimeoutMs", this.connectTimeoutMs],
    ]) {
      assertFiniteNonNegative(name, value);
    }

    try {
      socket.binaryType = "arraybuffer";
    } catch {
      // Compatible test doubles may expose a read-only binaryType.
    }

    this.opened = new Promise((resolve, reject) => {
      this._resolveOpened = resolve;
      this._rejectOpened = reject;
    });
    // Transport failures are reported by readExact/write. `closed` always
    // resolves so callers can use it as a lifecycle notification.
    this.closed = new Promise((resolve) => { this._resolveClosed = resolve; });

    this._removeListeners.push(
      addListener(socket, "open", () => this._onOpen()),
      addListener(socket, "message", (event) => this._onMessage(event?.data ?? event)),
      addListener(socket, "error", (event) => this._onError(event)),
      addListener(socket, "close", (event) => this._onClose(event)),
    );

    if (socket.readyState === OPEN) queueMicrotask(() => this._onOpen());
    if (socket.readyState === CLOSED) {
      queueMicrotask(() => this._onClose({ code: 1006, reason: "already closed" }));
    }

    this._connectTimer = this.connectTimeoutMs > 0
      ? setTimeout(() => {
        if (socket.readyState !== OPEN) {
          this._fail(new Error(
            `WebSocket handshake timed out after ${this.connectTimeoutMs} ms`,
          ));
          this._closeSocket(1000, "connect timeout");
        }
      }, this.connectTimeoutMs)
      : null;

    this._signal = options.signal;
    this._abortListener = null;
    if (this._signal) {
      this._abortListener = () => {
        this._fail(abortError());
        this._closeSocket(1000, "aborted");
      };
      if (this._signal.aborted) queueMicrotask(this._abortListener);
      else this._signal.addEventListener("abort", this._abortListener, { once: true });
    }
  }

  _onOpen() {
    if (this.error) return;
    if (this._connectTimer !== null) clearTimeout(this._connectTimer);
    this._connectTimer = null;
    this._resolveOpened(this);
  }

  _onMessage(value) {
    // Blob conversion is asynchronous. Serialize it to retain message order.
    this._incomingTail = this._incomingTail
      .then(async () => {
        if (this.error) return;
        const bytes = await messageBytes(value);
        if (bytes.length === 0) return;
        // Enforce the limit before adding data or satisfying a waiting read.
        // Otherwise a large waiter could consume bytes before the post-pump
        // buffer size was checked.
        if (bytes.length > this.maxBufferedBytes - this.bufferedBytes) {
          this._fail(new Error(
            `WebSocket receive buffer exceeded ${this.maxBufferedBytes} bytes`,
          ));
          this._closeSocket(1009, "receive buffer limit");
          return;
        }
        this.chunks.push(bytes);
        this.bufferedBytes += bytes.length;
        this._pump();
      })
      .catch((error) => {
        this._fail(asError(error, "failed to decode WebSocket message"));
        this._closeSocket(1003, "binary messages required");
      });
  }

  _onError(event) {
    const error = event?.error instanceof Error
      ? event.error
      : new Error("WebSocket connection error");
    this._fail(error);
  }

  _onClose(event = {}) {
    if (this._connectTimer !== null) clearTimeout(this._connectTimer);
    this._connectTimer = null;
    const code = event.code ?? 1006;
    const reason = event.reason || "connection closed";
    // Drain already-delivered Blob conversions before surfacing EOF.
    this._incomingTail.finally(() => {
      const error = this.error ?? new Error(`WebSocket closed (${code}): ${reason}`);
      this._fail(error);
      this._settleClosed({ code, reason, error: this.error });
    });
  }

  _settleClosed(info) {
    if (this._closedSettled) return;
    this._closedSettled = true;
    if (this._signal && this._abortListener) {
      this._signal.removeEventListener("abort", this._abortListener);
    }
    for (const remove of this._removeListeners.splice(0)) remove();
    this._resolveClosed(info);
  }

  _fail(error) {
    if (this.error) return;
    this.error = error;
    if (this._connectTimer !== null) clearTimeout(this._connectTimer);
    this._connectTimer = null;
    this._rejectOpened(error);
    this._pump();
  }

  _pump() {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      if (this.bufferedBytes >= waiter.n) {
        this.waiters.shift();
        waiter.resolve(this._take(waiter.n));
      } else if (this.error) {
        this.waiters.shift();
        waiter.reject(this.error);
      } else {
        break;
      }
    }
  }

  _take(n) {
    const result = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      const head = this.chunks[0];
      const available = head.length - this.chunkOffset;
      const take = Math.min(available, n - written);
      result.set(head.subarray(this.chunkOffset, this.chunkOffset + take), written);
      written += take;
      this.chunkOffset += take;
      this.bufferedBytes -= take;
      if (this.chunkOffset === head.length) {
        this.chunks.shift();
        this.chunkOffset = 0;
      }
    }
    return result;
  }

  readExact(n) {
    const error = readSizeError(n, this.maxBufferedBytes);
    if (error) return Promise.reject(error);
    if (n === 0) return Promise.resolve(new Uint8Array(0));
    return new Promise((resolve, reject) => {
      this.waiters.push({ n, resolve, reject });
      this._pump();
    });
  }

  write(value) {
    let bytes;
    try {
      bytes = copyBytes(value);
    } catch (error) {
      return Promise.reject(error);
    }
    if (bytes.length > this.maxWriteBytes) {
      return Promise.reject(new RangeError(
        `WebSocket write exceeds ${this.maxWriteBytes} byte limit`,
      ));
    }

    const operation = this._writeTail.then(async () => {
      await this.opened;
      this._throwIfUnwritable();
      await this._waitForDrain();
      this._throwIfUnwritable();
      this.socket.send(bytes);
      await this._waitForDrain();
    });
    this._writeTail = operation.catch(() => {});
    return operation;
  }

  _throwIfUnwritable() {
    if (this.error) throw this.error;
    if (this.socket.readyState !== OPEN) {
      throw new Error(`WebSocket is not open (readyState ${this.socket.readyState})`);
    }
  }

  async _waitForDrain() {
    if (this.socket.bufferedAmount <= this.highWaterMark) return;
    const started = Date.now();
    while (this.socket.bufferedAmount > this.highWaterMark) {
      this._throwIfUnwritable();
      if (this.drainTimeoutMs > 0 && Date.now() - started >= this.drainTimeoutMs) {
        throw new Error(
          `WebSocket output remained backpressured for ${this.drainTimeoutMs} ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
  }

  _closeSocket(code, reason) {
    if (this.socket.readyState >= CLOSING) return;
    try {
      this.socket.close(code, reason);
    } catch {
      // Closing a socket whose constructor failed can itself throw.
    }
  }

  /** Gracefully close after queued writes have reached the WebSocket API. */
  async close(code = 1000, reason = "") {
    await this._writeTail;
    if (this.socket.readyState < CLOSING) this._closeSocket(code, reason);
    if (this.socket.readyState === CLOSED && !this._closedSettled) {
      this._onClose({ code, reason });
    }
    return this.closed;
  }
}

/** Construct, open, and adapt a WebSocket. No subprotocol is requested by default. */
export async function connectWebSocket(url, options = {}) {
  const WebSocketCtor = options.WebSocket ?? globalThis.WebSocket;
  if (typeof WebSocketCtor !== "function") {
    throw new Error("this environment does not provide WebSocket");
  }
  const protocols = options.protocols;
  const hasProtocols = protocols !== undefined
    && protocols !== null
    && protocols !== ""
    && (!Array.isArray(protocols) || protocols.length > 0);
  const socket = hasProtocols
    ? new WebSocketCtor(url, protocols)
    : new WebSocketCtor(url);
  const stream = new WebSocketByteStream(socket, options);
  await stream.opened;
  return stream;
}

/**
 * Adapt an RTCDataChannel to a bounded byte-stream API.
 *
 * Only ordered, fully reliable channels are accepted. Message boundaries are
 * erased on reads, and logical writes are fragmented into conservative SCTP
 * messages. This class adapts an existing channel; it does not establish a
 * peer connection or perform signaling.
 */
export class RTCDataChannelByteStream {
  constructor(channel, options = {}) {
    if (!channel || typeof channel.send !== "function") {
      throw new TypeError("RTCDataChannelByteStream requires an RTCDataChannel");
    }
    if (channel.ordered === false) {
      throw new TypeError("byte streams require an ordered RTCDataChannel");
    }
    if (channel.maxRetransmits !== null && channel.maxRetransmits !== undefined) {
      throw new TypeError(
        "byte streams require a fully reliable RTCDataChannel (maxRetransmits must be unset)",
      );
    }
    if (channel.maxPacketLifeTime !== null && channel.maxPacketLifeTime !== undefined) {
      throw new TypeError(
        "byte streams require a fully reliable RTCDataChannel (maxPacketLifeTime must be unset)",
      );
    }

    const requiredProtocol = options.requiredProtocol;
    if (requiredProtocol !== undefined && requiredProtocol !== null) {
      if (typeof requiredProtocol !== "string") {
        throw new TypeError("requiredProtocol must be a string or null");
      }
      if (channel.protocol !== requiredProtocol) {
        throw new TypeError(
          `RTCDataChannel protocol must be ${requiredProtocol}, got ${channel.protocol || "<empty>"}`,
        );
      }
    }

    this.channel = channel;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.maxWriteBytes = options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
    const requestedChunkBytes = options.maxChunkBytes ?? DEFAULT_DATA_CHANNEL_CHUNK_BYTES;
    const negotiatedMessageSize = options.maxMessageSize;
    this.maxChunkBytes = negotiatedMessageSize === undefined
      || negotiatedMessageSize === null
      || negotiatedMessageSize === 0
      || negotiatedMessageSize === Infinity
      ? requestedChunkBytes
      : Math.min(requestedChunkBytes, negotiatedMessageSize);
    this.highWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_DATA_CHANNEL_CLOSE_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs
      ?? DEFAULT_DATA_CHANNEL_CONNECT_TIMEOUT_MS;
    this.chunks = [];
    this.chunkOffset = 0;
    this.bufferedBytes = 0;
    this.waiters = [];
    this.error = null;
    this._incomingTail = Promise.resolve();
    this._writeTail = Promise.resolve();
    this._removeListeners = [];
    this._closedSettled = false;
    this._closeTimer = null;

    for (const [name, value] of [
      ["maxBufferedBytes", this.maxBufferedBytes],
      ["maxWriteBytes", this.maxWriteBytes],
      ["highWaterMark", this.highWaterMark],
      ["drainTimeoutMs", this.drainTimeoutMs],
      ["closeTimeoutMs", this.closeTimeoutMs],
      ["connectTimeoutMs", this.connectTimeoutMs],
    ]) {
      assertFiniteNonNegative(name, value);
    }
    if (!Number.isSafeInteger(requestedChunkBytes) || requestedChunkBytes <= 0) {
      throw new RangeError("maxChunkBytes must be a positive safe integer");
    }
    if (
      negotiatedMessageSize !== undefined
      && negotiatedMessageSize !== null
      && negotiatedMessageSize !== Infinity
      && (!Number.isSafeInteger(negotiatedMessageSize) || negotiatedMessageSize < 0)
    ) {
      throw new RangeError(
        "maxMessageSize must be zero, Infinity, or a positive safe integer",
      );
    }

    try {
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = this.highWaterMark;
    } catch {
      // Compatible test doubles and older implementations may be read-only.
    }

    this.opened = new Promise((resolve, reject) => {
      this._resolveOpened = resolve;
      this._rejectOpened = reject;
    });
    this.closed = new Promise((resolve) => { this._resolveClosed = resolve; });

    this._removeListeners.push(
      addListener(channel, "open", () => this._onOpen()),
      addListener(channel, "message", (event) => this._onMessage(event?.data ?? event)),
      addListener(channel, "error", (event) => this._onError(event)),
      addListener(channel, "close", () => this._onClose()),
    );

    if (channel.readyState === "open") queueMicrotask(() => this._onOpen());
    if (channel.readyState === "closed") queueMicrotask(() => this._onClose());

    this._connectTimer = this.connectTimeoutMs > 0
      ? setTimeout(() => {
        if (channel.readyState !== "open") {
          this._fail(new Error(
            `RTCDataChannel open timed out after ${this.connectTimeoutMs} ms`,
          ));
          this._closeChannel();
        }
      }, this.connectTimeoutMs)
      : null;

    this._signal = options.signal;
    this._abortListener = null;
    if (this._signal) {
      this._abortListener = () => {
        this._fail(abortError());
        this._closeChannel();
      };
      if (this._signal.aborted) queueMicrotask(this._abortListener);
      else this._signal.addEventListener("abort", this._abortListener, { once: true });
    }
  }

  _onOpen() {
    if (this.error) return;
    if (this._connectTimer !== null) clearTimeout(this._connectTimer);
    this._connectTimer = null;
    this._resolveOpened(this);
  }

  _onMessage(value) {
    this._incomingTail = this._incomingTail
      .then(async () => {
        if (this.error) return;
        const bytes = await messageBytes(value);
        if (bytes.length === 0) return;
        if (bytes.length > this.maxBufferedBytes - this.bufferedBytes) {
          this._fail(new Error(
            `RTCDataChannel receive buffer exceeded ${this.maxBufferedBytes} bytes`,
          ));
          this._closeChannel();
          return;
        }
        this.chunks.push(bytes);
        this.bufferedBytes += bytes.length;
        this._pump();
      })
      .catch((error) => {
        this._fail(asError(error, "failed to decode RTCDataChannel message"));
        this._closeChannel();
      });
  }

  _onError(event) {
    const error = event?.error instanceof Error
      ? event.error
      : new Error("RTCDataChannel connection error");
    this._fail(error);
    this._closeChannel();
  }

  _onClose() {
    if (this._connectTimer !== null) clearTimeout(this._connectTimer);
    this._connectTimer = null;
    if (this._closeTimer !== null) clearTimeout(this._closeTimer);
    this._closeTimer = null;
    this._incomingTail.finally(() => {
      this._fail(this.error ?? new Error("RTCDataChannel closed"));
      this._settleClosed({ error: this.error });
    });
  }

  _settleClosed(info) {
    if (this._closedSettled) return;
    this._closedSettled = true;
    if (this._closeTimer !== null) clearTimeout(this._closeTimer);
    this._closeTimer = null;
    if (this._signal && this._abortListener) {
      this._signal.removeEventListener("abort", this._abortListener);
    }
    for (const remove of this._removeListeners.splice(0)) remove();
    this._resolveClosed(info);
  }

  _fail(error) {
    if (this.error) return;
    this.error = error;
    if (this._connectTimer !== null) clearTimeout(this._connectTimer);
    this._connectTimer = null;
    this._rejectOpened(error);
    this._pump();
  }

  _pump() {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      if (this.bufferedBytes >= waiter.n) {
        this.waiters.shift();
        waiter.resolve(this._take(waiter.n));
      } else if (this.error) {
        this.waiters.shift();
        waiter.reject(this.error);
      } else {
        break;
      }
    }
  }

  _take(n) {
    const result = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      const head = this.chunks[0];
      const available = head.length - this.chunkOffset;
      const take = Math.min(available, n - written);
      result.set(head.subarray(this.chunkOffset, this.chunkOffset + take), written);
      written += take;
      this.chunkOffset += take;
      this.bufferedBytes -= take;
      if (this.chunkOffset === head.length) {
        this.chunks.shift();
        this.chunkOffset = 0;
      }
    }
    return result;
  }

  readExact(n) {
    const error = readSizeError(n, this.maxBufferedBytes);
    if (error) return Promise.reject(error);
    if (n === 0) return Promise.resolve(new Uint8Array(0));
    return new Promise((resolve, reject) => {
      this.waiters.push({ n, resolve, reject });
      this._pump();
    });
  }

  write(value) {
    let bytes;
    try {
      bytes = copyBytes(value);
    } catch (error) {
      return Promise.reject(error);
    }
    if (bytes.length > this.maxWriteBytes) {
      return Promise.reject(new RangeError(
        `RTCDataChannel write exceeds ${this.maxWriteBytes} byte limit`,
      ));
    }

    const operation = this._writeTail
      .then(async () => {
        await this.opened;
        for (let offset = 0; offset < bytes.length; offset += this.maxChunkBytes) {
          this._throwIfUnwritable();
          await this._waitForDrain(this.highWaterMark);
          this._throwIfUnwritable();
          this.channel.send(bytes.subarray(offset, offset + this.maxChunkBytes));
        }
        await this._waitForDrain(this.highWaterMark);
      })
      .catch((error) => {
        const failure = asError(error, "RTCDataChannel write failed");
        this._fail(failure);
        this._closeChannel();
        throw failure;
      });
    this._writeTail = operation.catch(() => {});
    return operation;
  }

  _throwIfUnwritable() {
    if (this.error) throw this.error;
    if (this.channel.readyState !== "open") {
      throw new Error(
        `RTCDataChannel is not open (readyState ${this.channel.readyState})`,
      );
    }
  }

  async _waitForDrain(limit) {
    if (this.channel.bufferedAmount <= limit) return;
    try {
      this.channel.bufferedAmountLowThreshold = limit;
    } catch {
      // Some compatible implementations expose a read-only threshold.
    }
    const started = Date.now();
    while (this.channel.bufferedAmount > limit) {
      this._throwIfUnwritable();
      if (this.drainTimeoutMs > 0 && Date.now() - started >= this.drainTimeoutMs) {
        throw new Error(
          `RTCDataChannel output remained backpressured for ${this.drainTimeoutMs} ms`,
        );
      }
      // Prefer the native low-water event, with a watchdog for compatible
      // implementations that only update bufferedAmount.
      await new Promise((resolve) => {
        const remove = addListener(this.channel, "bufferedamountlow", done);
        const timer = setTimeout(done, 8);
        function done() {
          clearTimeout(timer);
          remove();
          resolve();
        }
      });
    }
  }

  _closeChannel() {
    if (this.channel.readyState !== "closing" && this.channel.readyState !== "closed") {
      try {
        this.channel.close();
      } catch {
        // The channel may already have failed.
      }
    }
    if (this.channel.readyState === "closed") {
      if (!this._closedSettled) queueMicrotask(() => this._onClose());
      return;
    }
    if (this.closeTimeoutMs > 0 && this._closeTimer === null) {
      this._closeTimer = setTimeout(() => {
        const error = this.error ?? new Error(
          `RTCDataChannel close timed out after ${this.closeTimeoutMs} ms`,
        );
        this._fail(error);
        this._settleClosed({ error });
      }, this.closeTimeoutMs);
    }
  }

  /** Gracefully close after queued writes have left the browser send queue. */
  async close() {
    let failure = null;
    try {
      await this._writeTail;
      if (this.channel.readyState === "open") await this._waitForDrain(0);
    } catch (error) {
      failure = asError(error, "RTCDataChannel close failed");
      this._fail(failure);
    } finally {
      this._closeChannel();
    }
    if (failure) throw failure;
    return this.closed;
  }
}
