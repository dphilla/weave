// Bounded TCP byte-stream adapter for the Node runner. A socket is paused when
// unread input reaches the high-water mark and resumed only after consumers
// drain it below the low-water mark. The hard cap is above the protocol's
// largest legal frame so a peer cannot stream arbitrary data into process RAM.

import net from "node:net";

export const DEFAULT_MAX_TCP_BUFFERED_BYTES = 72 * 1024 * 1024;
export const DEFAULT_TCP_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_TCP_READ_TIMEOUT_MS = 120_000;
export const DEFAULT_TCP_WRITE_TIMEOUT_MS = 120_000;
export const DEFAULT_SOCKET_CLASSIFICATION_TIMEOUT_MS = 15_000;

function positiveTimeout(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export class TcpTransport {
  constructor(socket, options = {}) {
    this.socket = socket;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_TCP_BUFFERED_BYTES;
    this.pauseBytes = options.pauseBytes ?? 64 * 1024 * 1024;
    this.resumeBytes = options.resumeBytes ?? 32 * 1024 * 1024;
    this.writeTimeoutMs = positiveTimeout(
      options.writeTimeoutMs ?? DEFAULT_TCP_WRITE_TIMEOUT_MS,
      "writeTimeoutMs",
    );
    this.readTimeoutMs = positiveTimeout(
      options.readTimeoutMs ?? DEFAULT_TCP_READ_TIMEOUT_MS,
      "readTimeoutMs",
    );
    for (const [name, value] of [
      ["maxBufferedBytes", this.maxBufferedBytes],
      ["pauseBytes", this.pauseBytes],
      ["resumeBytes", this.resumeBytes],
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`);
      }
    }
    if (this.resumeBytes > this.pauseBytes || this.pauseBytes > this.maxBufferedBytes) {
      throw new RangeError("TCP buffer thresholds must satisfy resumeBytes <= pauseBytes <= maxBufferedBytes");
    }

    this.chunks = [];
    this.len = 0;
    this.waiters = [];
    this.err = null;
    this.paused = false;
    socket.on("data", (buf) => this._onData(buf));
    socket.on("error", (error) => this._fail(error));
    socket.on("close", () => this._fail(new Error("connection closed")));
  }

  _onData(buf) {
    if (this.err) return;
    if (buf.length > this.maxBufferedBytes - this.len) {
      const error = new Error(
        `TCP receive buffer exceeded ${this.maxBufferedBytes} bytes`,
      );
      this._fail(error);
      try { this.socket.destroy(error); } catch { /* failure is already published */ }
      return;
    }
    this.chunks.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice());
    this.len += buf.length;
    this._pump();
  }

  _fail(error) {
    if (this.err) return;
    this.err = error instanceof Error ? error : new Error(String(error));
    this._pump();
  }

  _updateFlow() {
    if (this.err) return;
    if (!this.paused && this.len >= this.pauseBytes) {
      this.socket.pause();
      this.paused = true;
    } else if (this.paused && this.len <= this.resumeBytes) {
      this.paused = false;
      this.socket.resume();
    }
  }

  _pump() {
    while (this.waiters.length) {
      const waiter = this.waiters[0];
      if (this.len >= waiter.n) {
        this.waiters.shift();
        waiter.resolve(this._take(waiter.n));
      } else if (this.err) {
        this.waiters.shift();
        waiter.reject(this.err);
      } else {
        break;
      }
    }
    this._updateFlow();
  }

  _take(n) {
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const head = this.chunks[0];
      const take = Math.min(head.length, n - offset);
      out.set(head.subarray(0, take), offset);
      offset += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
      this.len -= take;
    }
    return out;
  }

  readExact(n) {
    if (!Number.isSafeInteger(n) || n < 0) {
      return Promise.reject(new RangeError("readExact size must be a non-negative safe integer"));
    }
    if (n > this.maxBufferedBytes) {
      return Promise.reject(new RangeError(
        `readExact size exceeds TCP receive buffer limit ${this.maxBufferedBytes}`,
      ));
    }
    if (n === 0) return Promise.resolve(new Uint8Array(0));
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const waiter = {
        n,
        resolve: (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      };
      timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        const error = new Error(`TCP read timed out after ${this.readTimeoutMs} ms`);
        waiter.reject(error);
        this._fail(error);
        try { this.socket.destroy(); } catch { /* timeout is already published */ }
      }, this.readTimeoutMs);
      this.waiters.push(waiter);
      this._pump();
    });
  }

  write(bytes) {
    return new Promise((resolve, reject) => {
      if (this.err) {
        reject(this.err);
        return;
      }
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        const error = new Error(`TCP write timed out after ${this.writeTimeoutMs} ms`);
        this._fail(error);
        try { this.socket.destroy(); } catch { /* timeout is already published */ }
        finish(error);
      }, this.writeTimeoutMs);
      try {
        this.socket.write(Buffer.from(bytes), finish);
      } catch (error) {
        finish(error);
      }
    });
  }

  close() {
    // Destroy rather than half-close: a timed-out read may otherwise keep the
    // process alive forever waiting for a malicious peer's FIN.
    try { this.socket.destroy(); } catch { /* already closed */ }
  }
}

/** Read and restore the first byte used to classify data vs control sockets. */
export function readFirstSocketByte(
  socket,
  timeoutMs = DEFAULT_SOCKET_CLASSIFICATION_TIMEOUT_MS,
) {
  positiveTimeout(timeoutMs, "classificationTimeoutMs");
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("readable", onReadable);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const finish = (error, first) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(first);
    };
    const onReadable = () => {
      const first = socket.read(1);
      if (first === null) return;
      socket.unshift(first);
      finish(null, first[0]);
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error("connection closed before protocol classification"));
    const timer = setTimeout(() => {
      const error = new Error(`socket classification timed out after ${timeoutMs} ms`);
      finish(error);
      try { socket.destroy(); } catch { /* timeout is already published */ }
    }, timeoutMs);
    socket.on("readable", onReadable);
    socket.once("error", onError);
    socket.once("close", onClose);
    // Account for bytes that arrived before listeners were installed.
    onReadable();
  });
}

/** Dial a TCP target with a finite deadline and return its bounded transport. */
export function connectTcp(host, port, options = {}) {
  const timeoutMs = positiveTimeout(
    options.connectTimeoutMs ?? DEFAULT_TCP_CONNECT_TIMEOUT_MS,
    "connectTimeoutMs",
  );
  const dial = options.dial ?? ((address) => net.connect(address));
  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket?.off("connect", onConnect);
      socket?.off("error", onError);
      socket?.off("close", onClose);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { socket?.destroy(); } catch { /* failure is already published */ }
      reject(error);
    };
    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(new TcpTransport(socket, options.transportOptions));
      } catch (error) {
        try { socket.destroy(); } catch { /* constructor error is primary */ }
        reject(error);
      }
    };
    const onError = (error) => fail(error);
    const onClose = () => fail(new Error("connection closed before TCP connect completed"));
    const timer = setTimeout(
      () => fail(new Error(`TCP connect timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    try {
      socket = dial({ host, port, noDelay: true });
      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("close", onClose);
    } catch (error) {
      fail(error);
    }
  });
}
