import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import { WebSocketByteStream } from "../../js/weave-browser.mjs";

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
  await assert.rejects(stream.readExact(5), /receive buffer exceeded/);
});
