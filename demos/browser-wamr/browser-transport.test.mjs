import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import {
  RTCDataChannelByteStream,
  WebSocketByteStream,
} from "../../js/weave-browser.mjs";

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
    this.protocol = options.protocol ?? "weave.v2";
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

class StuckCloseDataChannel extends FakeDataChannel {
  close() { this.readyState = "closing"; }
}

test("WebSocketByteStream coalesces and splits binary messages", async () => {
  const socket = new FakeWebSocket();
  const stream = new WebSocketByteStream(socket, { connectTimeoutMs: 0 });
  socket.open();
  await stream.opened;

  const first = stream.readExact(5);
  socket.message(Uint8Array.of(1, 2).buffer);
  socket.message(Uint8Array.of(3, 4, 5, 6));
  assert.deepEqual([...await first], [1, 2, 3, 4, 5]);
  assert.deepEqual([...await stream.readExact(1)], [6]);
  assert.equal(stream.bufferedBytes, 0);
});

test("WebSocketByteStream preserves write bytes and order", async () => {
  const socket = new FakeWebSocket();
  const stream = new WebSocketByteStream(socket, { connectTimeoutMs: 0 });
  socket.open();

  const mutable = Uint8Array.of(7, 8, 9);
  const one = stream.write(mutable);
  mutable.fill(0);
  const two = stream.write(Uint8Array.of(10));
  await Promise.all([one, two]);
  assert.deepEqual(socket.sent.map((part) => [...part]), [[7, 8, 9], [10]]);
});

test("WebSocketByteStream drains delivered bytes before surfacing close", async () => {
  const socket = new FakeWebSocket();
  const stream = new WebSocketByteStream(socket, { connectTimeoutMs: 0 });
  socket.open();

  socket.message(Uint8Array.of(11, 12));
  const delivered = stream.readExact(2);
  socket.close(1000, "done");
  assert.deepEqual([...await delivered], [11, 12]);
  await assert.rejects(stream.readExact(1), /WebSocket closed \(1000\): done/);
});

test("WebSocketByteStream bounds unread input", async () => {
  const socket = new FakeWebSocket();
  const stream = new WebSocketByteStream(socket, {
    connectTimeoutMs: 0,
    maxBufferedBytes: 3,
  });
  socket.open();

  socket.message(Uint8Array.of(1, 2, 3, 4));
  await stream.closed;
  assert.equal(socket.closeInfo.code, 1009);
  await assert.rejects(stream.readExact(1), /receive buffer exceeded/);
});

test("RTCDataChannelByteStream removes message boundaries and chunks writes", async () => {
  const channel = new FakeDataChannel();
  const stream = new RTCDataChannelByteStream(channel, {
    connectTimeoutMs: 0,
    maxChunkBytes: 3,
  });
  channel.open();

  const first = stream.readExact(5);
  channel.message(Uint8Array.of(1, 2));
  channel.message(Uint8Array.of(3, 4, 5, 6).buffer);
  assert.deepEqual([...await first], [1, 2, 3, 4, 5]);
  assert.deepEqual([...await stream.readExact(1)], [6]);

  const mutable = Uint8Array.of(7, 8, 9, 10, 11, 12, 13);
  const write = stream.write(mutable);
  mutable.fill(0);
  await write;
  assert.deepEqual(channel.sent.map((part) => [...part]), [
    [7, 8, 9],
    [10, 11, 12],
    [13],
  ]);
  await stream.close();
});

test("RTCDataChannelByteStream refuses unordered or partially reliable channels", () => {
  assert.throws(
    () => new RTCDataChannelByteStream(new FakeDataChannel({ ordered: false })),
    /ordered RTCDataChannel/,
  );
  assert.throws(
    () => new RTCDataChannelByteStream(new FakeDataChannel({ maxRetransmits: 0 })),
    /fully reliable/,
  );
  assert.throws(
    () => new RTCDataChannelByteStream(new FakeDataChannel({ maxPacketLifeTime: 1000 })),
    /fully reliable/,
  );
  assert.throws(
    () => new RTCDataChannelByteStream(new FakeDataChannel({ protocol: "another.protocol" })),
    /protocol must be weave\.v2/,
  );
  assert.doesNotThrow(
    () => new RTCDataChannelByteStream(
      new FakeDataChannel({ protocol: "another.protocol" }),
      { connectTimeoutMs: 0, requiredProtocol: null },
    ),
  );
});

test("RTCDataChannelByteStream bounds unread input", async () => {
  const channel = new FakeDataChannel();
  const stream = new RTCDataChannelByteStream(channel, {
    connectTimeoutMs: 0,
    maxBufferedBytes: 3,
  });
  channel.open();
  channel.message(Uint8Array.of(1, 2, 3, 4));

  await stream.closed;
  assert.equal(channel.readyState, "closed");
  await assert.rejects(stream.readExact(1), /receive buffer exceeded/);
});

test("RTCDataChannelByteStream applies the receive bound before satisfying a large waiter", async () => {
  const channel = new FakeDataChannel();
  const stream = new RTCDataChannelByteStream(channel, {
    connectTimeoutMs: 0,
    maxBufferedBytes: 3,
  });
  channel.open();
  const pending = stream.readExact(3);
  channel.message(Uint8Array.of(1, 2, 3, 4));

  await assert.rejects(pending, /receive buffer exceeded/);
  assert.equal(channel.readyState, "closed");
});

test("RTCDataChannelByteStream clamps writes to the negotiated SCTP ceiling", async () => {
  const channel = new FakeDataChannel();
  const stream = new RTCDataChannelByteStream(channel, {
    connectTimeoutMs: 0,
    maxChunkBytes: 16,
    maxMessageSize: 3,
  });
  channel.open();
  await stream.write(Uint8Array.of(1, 2, 3, 4, 5, 6, 7));
  assert.deepEqual(channel.sent.map((part) => [...part]), [[1, 2, 3], [4, 5, 6], [7]]);
  await stream.close();
});

test("RTCDataChannelByteStream closes and settles after a transport error", async () => {
  const channel = new FakeDataChannel();
  const stream = new RTCDataChannelByteStream(channel, { connectTimeoutMs: 0 });
  channel.open();
  channel.emit("error", { error: new Error("association failed") });

  const closed = await stream.closed;
  assert.equal(channel.readyState, "closed");
  assert.match(closed.error.message, /association failed/);
  await assert.rejects(stream.readExact(1), /association failed/);
});

test("RTCDataChannelByteStream pauses and resumes at bufferedAmount backpressure", async () => {
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

test("RTCDataChannelByteStream bounds backpressure and asynchronous close waits", async () => {
  const blocked = new FakeDataChannel();
  blocked.bufferedAmount = 10;
  const blockedStream = new RTCDataChannelByteStream(blocked, {
    connectTimeoutMs: 0,
    highWaterMark: 1,
    drainTimeoutMs: 1,
  });
  blocked.open();
  await assert.rejects(blockedStream.write(Uint8Array.of(1)), /remained backpressured/);
  assert.equal(blocked.readyState, "closed");
  await blockedStream.closed;

  const stuck = new StuckCloseDataChannel();
  const stuckStream = new RTCDataChannelByteStream(stuck, {
    connectTimeoutMs: 0,
    closeTimeoutMs: 5,
  });
  stuck.open();
  const closed = await stuckStream.close();
  assert.equal(stuck.readyState, "closing");
  assert.match(closed.error.message, /close timed out/);
});
