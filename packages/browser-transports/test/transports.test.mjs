import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  RTCDataChannelByteStream,
  WebSocketByteStream,
  connectWebSocket,
} from "../src/index.mjs";

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.binaryType = "blob";
    this.sent = [];
    this.closeInfo = null;
  }

  open() {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(value) {
    this.emit("message", { data: value });
  }

  send(value) {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(new Uint8Array(value).slice());
  }

  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeInfo = { code, reason };
    this.emit("close", this.closeInfo);
  }
}

class FakeDataChannel extends EventEmitter {
  constructor(options = {}) {
    super();
    this.readyState = "connecting";
    this.ordered = options.ordered ?? true;
    this.maxRetransmits = options.maxRetransmits ?? null;
    this.maxPacketLifeTime = options.maxPacketLifeTime ?? null;
    this.protocol = options.protocol ?? "";
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.binaryType = "blob";
    this.sent = [];
  }

  open() {
    this.readyState = "open";
    this.emit("open", {});
  }

  message(value) {
    this.emit("message", { data: value });
  }

  send(value) {
    if (this.readyState !== "open") throw new Error("not open");
    this.sent.push(new Uint8Array(value).slice());
  }

  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.emit("close", {});
  }
}

class BufferedDataChannel extends FakeDataChannel {
  send(value) {
    super.send(value);
    this.bufferedAmount += value.byteLength;
  }

  drain() {
    this.bufferedAmount = 0;
    this.emit("bufferedamountlow", {});
  }
}

class DelayedBlob extends Blob {
  constructor(bytes, delayMs) {
    super([bytes]);
    this.delayMs = delayMs;
  }

  async arrayBuffer() {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return super.arrayBuffer();
  }
}

test("WebSocketByteStream coalesces messages and serializes copied writes", async () => {
  const socket = new FakeWebSocket();
  const stream = new WebSocketByteStream(socket, { connectTimeoutMs: 0 });
  socket.open();

  const reading = stream.readExact(5);
  socket.message(Uint8Array.of(1, 2).buffer);
  socket.message(Uint8Array.of(3, 4, 5, 6));
  assert.deepEqual([...await reading], [1, 2, 3, 4, 5]);
  assert.deepEqual([...await stream.readExact(1)], [6]);

  const mutable = Uint8Array.of(7, 8, 9);
  const first = stream.write(mutable);
  mutable.fill(0);
  const second = stream.write(Uint8Array.of(10));
  await Promise.all([first, second]);
  assert.deepEqual(socket.sent.map((part) => [...part]), [[7, 8, 9], [10]]);
});

test("WebSocketByteStream preserves Blob arrival order", async () => {
  const socket = new FakeWebSocket();
  const stream = new WebSocketByteStream(socket, { connectTimeoutMs: 0 });
  socket.open();

  const reading = stream.readExact(2);
  socket.message(new DelayedBlob(Uint8Array.of(1), 15));
  socket.message(new DelayedBlob(Uint8Array.of(2), 0));
  assert.deepEqual([...await reading], [1, 2]);
});

test("connectWebSocket requests no subprotocol unless explicitly configured", async () => {
  const calls = [];
  class AutoOpenWebSocket extends FakeWebSocket {
    constructor(...args) {
      super();
      calls.push(args);
      queueMicrotask(() => this.open());
    }
  }

  await connectWebSocket("ws://example.test/one", { WebSocket: AutoOpenWebSocket });
  await connectWebSocket("ws://example.test/two", {
    WebSocket: AutoOpenWebSocket,
    protocols: null,
  });
  await connectWebSocket("ws://example.test/three", {
    WebSocket: AutoOpenWebSocket,
    protocols: [],
  });
  await connectWebSocket("ws://example.test/four", {
    WebSocket: AutoOpenWebSocket,
    protocols: "",
  });
  await connectWebSocket("ws://example.test/five", {
    WebSocket: AutoOpenWebSocket,
    protocols: ["example.v1"],
  });

  assert.deepEqual(calls.map((args) => args.length), [1, 1, 1, 1, 2]);
  assert.deepEqual(calls[4][1], ["example.v1"]);
});

test("WebSocketByteStream enforces receive bounds before pumping waiters", async () => {
  const socket = new FakeWebSocket();
  const stream = new WebSocketByteStream(socket, {
    connectTimeoutMs: 0,
    maxBufferedBytes: 3,
  });
  socket.open();

  const pending = stream.readExact(3);
  socket.message(Uint8Array.of(1, 2));
  socket.message(Uint8Array.of(3, 4));

  await assert.rejects(pending, /receive buffer exceeded 3 bytes/);
  await stream.closed;
  assert.equal(socket.closeInfo.code, 1009);
  assert.equal(stream.bufferedBytes, 2);
});

test("both adapters reject reads larger than their receive budget", async () => {
  const socket = new FakeWebSocket();
  const webSocketStream = new WebSocketByteStream(socket, {
    connectTimeoutMs: 0,
    maxBufferedBytes: 3,
  });
  socket.open();
  await assert.rejects(webSocketStream.readExact(4), /receive-buffer limit/);

  const channel = new FakeDataChannel();
  const dataChannelStream = new RTCDataChannelByteStream(channel, {
    connectTimeoutMs: 0,
    maxBufferedBytes: 3,
  });
  channel.open();
  await assert.rejects(dataChannelStream.readExact(4), /receive-buffer limit/);
});

test("RTC protocol validation is opt-in and exact when requested", () => {
  assert.doesNotThrow(() => new RTCDataChannelByteStream(
    new FakeDataChannel({ protocol: "any.application" }),
    { connectTimeoutMs: 0 },
  ));
  assert.doesNotThrow(() => new RTCDataChannelByteStream(
    new FakeDataChannel({ protocol: "any.application" }),
    { connectTimeoutMs: 0, requiredProtocol: null },
  ));
  assert.doesNotThrow(() => new RTCDataChannelByteStream(
    new FakeDataChannel({ protocol: "example.v1" }),
    { connectTimeoutMs: 0, requiredProtocol: "example.v1" },
  ));
  assert.throws(
    () => new RTCDataChannelByteStream(
      new FakeDataChannel({ protocol: "other.v1" }),
      { requiredProtocol: "example.v1" },
    ),
    /protocol must be example\.v1/,
  );
});

test("RTCDataChannelByteStream requires ordered, fully reliable channels", () => {
  assert.throws(
    () => new RTCDataChannelByteStream(new FakeDataChannel({ ordered: false })),
    /ordered RTCDataChannel/,
  );
  assert.throws(
    () => new RTCDataChannelByteStream(new FakeDataChannel({ maxRetransmits: 0 })),
    /fully reliable/,
  );
  assert.throws(
    () => new RTCDataChannelByteStream(new FakeDataChannel({ maxPacketLifeTime: 10 })),
    /fully reliable/,
  );
});

test("RTCDataChannelByteStream removes boundaries and clamps write chunks", async () => {
  const channel = new FakeDataChannel({ protocol: "files.v1" });
  const stream = new RTCDataChannelByteStream(channel, {
    connectTimeoutMs: 0,
    maxChunkBytes: 16,
    maxMessageSize: 3,
    requiredProtocol: "files.v1",
  });
  channel.open();

  const reading = stream.readExact(5);
  channel.message(Uint8Array.of(1, 2));
  channel.message(Uint8Array.of(3, 4, 5, 6));
  assert.deepEqual([...await reading], [1, 2, 3, 4, 5]);
  assert.deepEqual([...await stream.readExact(1)], [6]);

  const mutable = Uint8Array.of(7, 8, 9, 10, 11, 12, 13);
  const writing = stream.write(mutable);
  mutable.fill(0);
  await writing;
  assert.deepEqual(channel.sent.map((part) => [...part]), [
    [7, 8, 9],
    [10, 11, 12],
    [13],
  ]);
  await stream.close();
});

test("RTCDataChannelByteStream pauses and resumes at bufferedAmount", async () => {
  const channel = new BufferedDataChannel();
  const stream = new RTCDataChannelByteStream(channel, {
    connectTimeoutMs: 0,
    maxChunkBytes: 3,
    highWaterMark: 2,
  });
  channel.open();

  const writing = stream.write(Uint8Array.of(1, 2, 3, 4, 5, 6));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(channel.sent.length, 1);
  channel.drain();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(channel.sent.length, 2);
  channel.drain();
  await writing;
  await stream.close();
});

test("AbortSignal fails pending operations and closes both transports", async () => {
  const webSocketController = new AbortController();
  const socket = new FakeWebSocket();
  const webSocketStream = new WebSocketByteStream(socket, {
    connectTimeoutMs: 0,
    signal: webSocketController.signal,
  });
  const webSocketOpened = webSocketStream.opened;
  webSocketController.abort();
  await assert.rejects(webSocketOpened, { name: "AbortError" });
  assert.equal(socket.closeInfo.reason, "aborted");

  const dataChannelController = new AbortController();
  const channel = new FakeDataChannel();
  const dataChannelStream = new RTCDataChannelByteStream(channel, {
    connectTimeoutMs: 0,
    signal: dataChannelController.signal,
  });
  const dataChannelOpened = dataChannelStream.opened;
  dataChannelController.abort();
  await assert.rejects(dataChannelOpened, { name: "AbortError" });
  assert.equal(channel.readyState, "closed");
});
