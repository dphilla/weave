// Demo-local transport adapter. This carries real Weave protocol bytes over a
// same-origin BroadcastChannel; the migration library itself is unchanged.
const PACKET_BYTES = 16 * 1024;
const MAX_QUEUED_OPERATIONS = 64;
const MAX_BUFFERED_PACKETS = 4096;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

export class TabByteStream {
  constructor({ room, operationId, localId, remoteId, channelFactory,
    timeoutMs = 12_000, maxBufferedBytes = 8 * 1024 * 1024,
    maxWriteBytes = 4 * 1024 * 1024 } = {}) {
    for (const [name, value] of Object.entries({ room, operationId, localId, remoteId })) {
      if (typeof value !== "string" || !value.length || value.length > 256) {
        throw new TypeError(`${name} must be a non-empty string of at most 256 characters`);
      }
    }
    if (localId === remoteId) throw new TypeError("a tab stream requires distinct peer IDs");
    this.timeoutMs = positiveInteger(timeoutMs, "timeoutMs");
    this.maxBufferedBytes = positiveInteger(maxBufferedBytes, "maxBufferedBytes");
    this.maxWriteBytes = positiveInteger(maxWriteBytes, "maxWriteBytes");
    this.operationId = operationId;
    this.localId = localId;
    this.remoteId = remoteId;
    this.buffers = [];
    this.bufferedBytes = 0;
    this.readers = [];
    this.sendSequence = 0;
    this.receiveSequence = 0;
    this.pendingAck = null;
    this.writeTail = Promise.resolve();
    this.queuedWriteBytes = 0;
    this.queuedWrites = new Set();
    this.error = null;
    this.remoteEnded = false;
    this.ready = false;
    this.opening = deferred();
    this.opened = this.opening.promise;
    this.openedPromise = this.opened;
    this.closing = deferred();
    // Closing is a notification, not an unhandled rejection when a caller is
    // already observing the failed read/write that caused it.
    this.closed = this.closing.promise;
    const factory = channelFactory ?? ((name) => new BroadcastChannel(name));
    this.channel = factory(`weave-pi-bytes-v1-${room}-${operationId}`);
    this.onMessage = (event) => this.receive(event.data);
    this.onMessageError = () => this.fail(new Error("tab stream message could not be decoded"));
    this.channel.addEventListener("message", this.onMessage);
    this.channel.addEventListener("messageerror", this.onMessageError);
    this.openTimer = setTimeout(() => this.fail(new Error("tab stream connection timed out")), timeoutMs);
    this.helloTimer = setInterval(() => this.send({ kind: "hello" }), Math.max(5, Math.min(250, timeoutMs / 4)));
    this.send({ kind: "hello" });
  }

  send(message) {
    if (this.error) return false;
    try {
      this.channel.postMessage({ version: 1, operationId: this.operationId,
        from: this.localId, to: this.remoteId, ...message });
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)), false);
      return false;
    }
  }

  markReady() {
    if (this.ready || this.error) return;
    this.ready = true;
    clearTimeout(this.openTimer);
    clearInterval(this.helloTimer);
    this.opening.resolve(this);
  }

  receive(message) {
    if (this.error) return;
    // Other tabs on the same origin are not peers. This is routing/isolation,
    // not authentication against another script running on that origin.
    if (!message || typeof message !== "object"
      || message.from !== this.remoteId || message.to !== this.localId
      || message.operationId !== this.operationId) return;
    if (message.version !== 1) return this.fail(new Error("invalid tab stream version"));
    if (message.kind === "hello") {
      this.send({ kind: "ready" });
      this.markReady();
    } else if (message.kind === "ready") {
      this.markReady();
    } else if (message.kind === "close") {
      this.fail(new Error("tab stream peer closed"), false, true);
    } else if (message.kind === "data") {
      if (!this.ready || !Number.isSafeInteger(message.sequence)
        || message.sequence !== this.receiveSequence
        || !(message.bytes instanceof Uint8Array) || message.bytes.length === 0
        || message.bytes.length > PACKET_BYTES) {
        return this.fail(new Error("invalid tab stream data packet or sequence"));
      }
      if (message.bytes.length > this.maxBufferedBytes - this.bufferedBytes
        || this.buffers.length >= MAX_BUFFERED_PACKETS) {
        return this.fail(new Error("tab stream receive buffer limit exceeded"));
      }
      this.receiveSequence++;
      this.buffers.push(new Uint8Array(message.bytes));
      this.bufferedBytes += message.bytes.length;
      this.pump();
      this.send({ kind: "ack", sequence: message.sequence });
    } else if (message.kind === "ack") {
      if (!this.pendingAck || !Number.isSafeInteger(message.sequence)
        || message.sequence !== this.pendingAck.sequence) {
        return this.fail(new Error("invalid tab stream acknowledgement sequence"));
      }
      const pending = this.pendingAck;
      this.pendingAck = null;
      pending.resolve();
    } else {
      this.fail(new Error("invalid tab stream message kind"));
    }
  }

  readExact(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.maxBufferedBytes) {
      return Promise.reject(new RangeError("invalid tab stream read size"));
    }
    if (this.error && (!this.remoteEnded || length > this.bufferedBytes)) return Promise.reject(this.error);
    if (length === 0) return Promise.resolve(new Uint8Array());
    if (this.readers.length >= MAX_QUEUED_OPERATIONS) {
      this.fail(new Error("too many queued tab stream reads"));
      return Promise.reject(this.error);
    }
    const reader = { ...deferred(), length };
    reader.timer = setTimeout(() => this.fail(new Error("tab stream read timed out")), this.timeoutMs);
    this.readers.push(reader);
    this.pump();
    return reader.promise;
  }

  pump() {
    while (this.readers.length) {
      const reader = this.readers[0];
      if (this.bufferedBytes < reader.length) {
        if (this.error) {
          this.readers.shift();
          clearTimeout(reader.timer);
          reader.reject(this.error);
          continue;
        }
        return;
      }
      this.readers.shift();
      clearTimeout(reader.timer);
      const result = new Uint8Array(reader.length);
      let offset = 0;
      while (offset < result.length) {
        const head = this.buffers[0];
        const take = Math.min(head.length, result.length - offset);
        result.set(head.subarray(0, take), offset);
        if (take === head.length) this.buffers.shift();
        else this.buffers[0] = head.subarray(take);
        offset += take;
        this.bufferedBytes -= take;
      }
      reader.resolve(result);
    }
  }

  write(bytes) {
    if (!(bytes instanceof Uint8Array)) return Promise.reject(new TypeError("tab stream writes require Uint8Array"));
    if (this.error) return Promise.reject(this.error);
    if (bytes.length > this.maxWriteBytes) return Promise.reject(new RangeError("tab stream write size limit exceeded"));
    if (this.queuedWrites.size >= MAX_QUEUED_OPERATIONS
      || bytes.length > this.maxBufferedBytes - this.queuedWriteBytes) {
      this.fail(new Error("tab stream queued write limit exceeded"));
      return Promise.reject(this.error);
    }
    // Copy before the first await, so callers can immediately reuse their
    // backing buffer without changing queued migration bytes.
    const owned = new Uint8Array(bytes);
    const job = { ...deferred(), length: owned.length };
    this.queuedWrites.add(job);
    this.queuedWriteBytes += job.length;
    job.timer = setTimeout(() => this.fail(new Error("tab stream write acknowledgement timed out")), this.timeoutMs);
    const operation = this.writeTail.then(async () => {
      await this.opened;
      if (this.error) throw this.error;
      for (let offset = 0; offset < owned.length; offset += PACKET_BYTES) {
        if (this.error) throw this.error;
        const ack = { ...deferred(), sequence: this.sendSequence++ };
        this.pendingAck = ack;
        this.send({ kind: "data", sequence: ack.sequence, bytes: owned.slice(offset, offset + PACKET_BYTES) });
        await ack.promise;
      }
    });
    this.writeTail = operation.catch(() => {});
    const complete = (error) => {
      clearTimeout(job.timer);
      this.queuedWrites.delete(job);
      this.queuedWriteBytes -= job.length;
      if (error) job.reject(error);
      else job.resolve();
    };
    void operation.then(() => complete(null), complete);
    return job.promise;
  }

  fail(error, notify = true, remoteEnded = false) {
    if (this.error) return;
    // Notify before closing the channel, but never wait for a missing ACK or
    // queued write: cancellation must remain bounded with a frozen peer.
    if (notify) {
      try {
        this.channel.postMessage({ version: 1, operationId: this.operationId,
          from: this.localId, to: this.remoteId, kind: "close" });
      } catch { /* already disconnected */ }
    }
    this.error = error;
    this.remoteEnded = remoteEnded;
    clearTimeout(this.openTimer);
    clearInterval(this.helloTimer);
    this.channel.removeEventListener("message", this.onMessage);
    this.channel.removeEventListener("messageerror", this.onMessageError);
    this.channel.close();
    this.opening.reject(error);
    this.pendingAck?.reject(error);
    this.pendingAck = null;
    for (const job of this.queuedWrites) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    if (!remoteEnded) {
      this.buffers = [];
      this.bufferedBytes = 0;
    }
    this.pump();
    this.closing.resolve(error);
  }

  close() {
    this.fail(new Error("tab stream closed locally"));
    return Promise.resolve();
  }
}
