// weave-browser.mjs — browser transport helpers for Weave.
//
// WebSocket is message-oriented while Weave's wire protocol is a byte stream.
// WebSocketByteStream removes those message boundaries and implements the
// { readExact(n), write(bytes) } contract consumed by weave.mjs. It also puts
// finite bounds on queued input and output so a slow or malicious peer cannot
// grow a tab without limit.

export const WEAVE_WEBSOCKET_PROTOCOL = "weave.v2";

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const DEFAULT_MAX_BUFFERED_BYTES = 72 * 1024 * 1024;
const DEFAULT_MAX_WRITE_BYTES = 64 * 1024 * 1024 + 5;

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
  throw new TypeError("WebSocketByteStream.write expects an ArrayBuffer or typed array");
}

async function messageBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new TypeError("Weave WebSocket received a non-binary message");
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
  throw new TypeError("socket is not a WebSocket-like EventTarget");
}

/**
 * Adapt an open or connecting browser WebSocket to Weave's byte-stream API.
 *
 * Options:
 *   maxBufferedBytes  maximum unread inbound data (default 72 MiB)
 *   maxWriteBytes     maximum size of one write (default protocol max + header)
 *   highWaterMark     wait when socket.bufferedAmount exceeds this (default 1 MiB)
 *   drainTimeoutMs    maximum output-backpressure wait (default 120 s)
 *   connectTimeoutMs  maximum handshake wait (default 15 s, 0 disables)
 *   signal            AbortSignal for the lifetime of the stream
 */
export class WebSocketByteStream {
  constructor(socket, options = {}) {
    if (!socket || typeof socket.send !== "function") {
      throw new TypeError("WebSocketByteStream requires a WebSocket");
    }

    this.socket = socket;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.maxWriteBytes = options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
    this.highWaterMark = options.highWaterMark ?? 1024 * 1024;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 120_000;
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
    ]) {
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative finite number`);
      }
    }

    try {
      socket.binaryType = "arraybuffer";
    } catch {
      // Some WebSocket-compatible test doubles expose a read-only binaryType.
    }

    this.opened = new Promise((resolve, reject) => {
      this._resolveOpened = resolve;
      this._rejectOpened = reject;
    });
    // A closing connection is a normal terminal state, so this promise always
    // resolves. readExact/write carry the actual failure to callers.
    this.closed = new Promise((resolve) => { this._resolveClosed = resolve; });

    this._removeListeners.push(
      addListener(socket, "open", () => this._onOpen()),
      addListener(socket, "message", (event) => this._onMessage(event?.data ?? event)),
      addListener(socket, "error", (event) => this._onError(event)),
      addListener(socket, "close", (event) => this._onClose(event)),
    );

    if (socket.readyState === OPEN) queueMicrotask(() => this._onOpen());
    if (socket.readyState === CLOSED) queueMicrotask(() => this._onClose({ code: 1006, reason: "already closed" }));

    const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this._connectTimer = connectTimeoutMs > 0
      ? setTimeout(() => {
        if (socket.readyState !== OPEN) {
          this._fail(new Error(`WebSocket handshake timed out after ${connectTimeoutMs} ms`));
          this._closeSocket(1000, "connect timeout");
        }
      }, connectTimeoutMs)
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
    // Blob.arrayBuffer() is asynchronous. Chaining conversions preserves the
    // browser's message order even when blobs take different times to decode.
    this._incomingTail = this._incomingTail
      .then(async () => {
        if (this.error) return;
        const bytes = await messageBytes(value);
        if (bytes.length === 0) return;
        this.chunks.push(bytes);
        this.bufferedBytes += bytes.length;
        this._pump();
        if (this.bufferedBytes > this.maxBufferedBytes) {
          const error = new Error(
            `WebSocket receive buffer exceeded ${this.maxBufferedBytes} bytes`,
          );
          this._fail(error);
          this._closeSocket(1009, "receive buffer limit");
        }
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
    // Drain already-delivered Blob messages before surfacing EOF.
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
    if (!Number.isSafeInteger(n) || n < 0) {
      return Promise.reject(new RangeError("readExact size must be a non-negative integer"));
    }
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
    // Keep the serialization chain usable without hiding this operation's
    // rejection from its caller.
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
        throw new Error(`WebSocket output remained backpressured for ${this.drainTimeoutMs} ms`);
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

  /** Gracefully close after queued writes have been handed to the browser. */
  async close(code = 1000, reason = "") {
    await this._writeTail;
    if (this.socket.readyState < CLOSING) this._closeSocket(code, reason);
    if (this.socket.readyState === CLOSED && !this._closedSettled) {
      this._onClose({ code, reason });
    }
    return this.closed;
  }
}

/** Open a WebSocket and return it as a Weave byte stream. */
export async function connectWebSocket(url, options = {}) {
  const WebSocketCtor = options.WebSocket ?? globalThis.WebSocket;
  if (typeof WebSocketCtor !== "function") {
    throw new Error("this environment does not provide WebSocket");
  }
  const protocols = options.protocols ?? [WEAVE_WEBSOCKET_PROTOCOL];
  const socket = protocols === null || protocols.length === 0
    ? new WebSocketCtor(url)
    : new WebSocketCtor(url, protocols);
  const stream = new WebSocketByteStream(socket, options);
  await stream.opened;
  return stream;
}

function relayUrl(baseUrl, route, options) {
  const base = new URL(baseUrl, globalThis.location?.href);
  if (base.protocol === "http:") base.protocol = "ws:";
  else if (base.protocol === "https:") base.protocol = "wss:";
  if (base.protocol !== "ws:" && base.protocol !== "wss:") {
    throw new TypeError("relay URL must use http(s) or ws(s)");
  }
  base.pathname = route;
  base.search = "";
  base.hash = "";
  if (options.token) base.searchParams.set("token", options.token);
  return base.href;
}

/** Connect a browser source to a named TCP target configured on the relay. */
export function connectRelay(baseUrl, target, options = {}) {
  if (!target || target.includes("/")) throw new TypeError("invalid relay target name");
  const url = relayUrl(baseUrl, `/v1/connect/${encodeURIComponent(target)}`, options);
  return connectWebSocket(url, options);
}

/** Register a browser target to accept the relay's next TCP ingress peer. */
export function acceptRelay(baseUrl, options = {}) {
  const url = relayUrl(baseUrl, "/v1/accept", options);
  return connectWebSocket(url, options);
}
