import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  connectTcp,
  readFirstSocketByte,
  TcpTransport,
} from "./weave-node-transport.mjs";

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.pauseCount = 0;
    this.resumeCount = 0;
    this.destroyCount = 0;
    this.destroyError = null;
    this.writes = [];
    this.readBuffer = Buffer.alloc(0);
    this.stallWrites = false;
  }

  pause() { this.pauseCount++; }
  resume() { this.resumeCount++; }
  destroy(error) { this.destroyCount++; this.destroyError = error; }
  read(n) {
    if (this.readBuffer.length < n) return null;
    const value = this.readBuffer.subarray(0, n);
    this.readBuffer = this.readBuffer.subarray(n);
    return value;
  }
  unshift(bytes) {
    this.readBuffer = Buffer.concat([Buffer.from(bytes), this.readBuffer]);
  }
  write(bytes, callback) {
    this.writes.push(Buffer.from(bytes));
    if (!this.stallWrites) callback();
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("TcpTransport pauses and resumes around bounded unread input", async () => {
  const socket = new FakeSocket();
  const transport = new TcpTransport(socket, {
    maxBufferedBytes: 8,
    pauseBytes: 4,
    resumeBytes: 1,
  });

  socket.emit("data", Buffer.from([1, 2, 3, 4]));
  assert.equal(socket.pauseCount, 1);
  assert.equal(transport.len, 4);
  assert.deepEqual([...await transport.readExact(3)], [1, 2, 3]);
  assert.equal(socket.resumeCount, 1);
  assert.equal(transport.len, 1);
});

test("TcpTransport destroys a peer that exceeds the hard receive cap", async () => {
  const socket = new FakeSocket();
  const transport = new TcpTransport(socket, {
    maxBufferedBytes: 4,
    pauseBytes: 3,
    resumeBytes: 1,
  });
  const waiting = transport.readExact(4);
  socket.emit("data", Buffer.from([1, 2, 3, 4, 5]));
  await assert.rejects(waiting, /TCP receive buffer exceeded 4 bytes/);
  assert.match(socket.destroyError.message, /receive buffer exceeded/);
  await assert.rejects(transport.readExact(5), /readExact size exceeds/);
});

test("TcpTransport coalesces reads and preserves writes", async () => {
  const socket = new FakeSocket();
  const transport = new TcpTransport(socket, {
    maxBufferedBytes: 16,
    pauseBytes: 12,
    resumeBytes: 4,
  });
  const reading = transport.readExact(4);
  socket.emit("data", Buffer.from([1, 2]));
  socket.emit("data", Buffer.from([3, 4, 5]));
  assert.deepEqual([...await reading], [1, 2, 3, 4]);
  assert.deepEqual([...await transport.readExact(1)], [5]);
  await transport.write(Uint8Array.of(6, 7));
  assert.deepEqual([...socket.writes[0]], [6, 7]);
  transport.close();
  assert.equal(socket.destroyCount, 1);
});

test("TcpTransport bounds stalled reads and writes", async () => {
  const readSocket = new FakeSocket();
  const reading = new TcpTransport(readSocket, { readTimeoutMs: 10 });
  await assert.rejects(reading.readExact(1), /TCP read timed out after 10 ms/);
  assert.equal(readSocket.destroyCount, 1);

  const writeSocket = new FakeSocket();
  writeSocket.stallWrites = true;
  const writing = new TcpTransport(writeSocket, { writeTimeoutMs: 10 });
  await assert.rejects(writing.write(Uint8Array.of(1)), /TCP write timed out after 10 ms/);
  assert.equal(writeSocket.destroyCount, 1);
});

test("silent socket classification is finite and a byte clears its timer", async () => {
  const silent = new FakeSocket();
  await assert.rejects(readFirstSocketByte(silent, 10), /classification timed out after 10 ms/);
  assert.equal(silent.destroyCount, 1);

  const classified = new FakeSocket();
  const first = readFirstSocketByte(classified, 10);
  classified.readBuffer = Buffer.from([17]);
  classified.emit("readable");
  assert.equal(await first, 17);
  assert.deepEqual([...classified.readBuffer], [17], "classifier must restore the protocol byte");
  await delay(15);
  assert.equal(classified.destroyCount, 0, "classification timer must be cleared");
});

test("TCP dialing has a finite deadline and hands off connected sockets", async () => {
  const stalled = new FakeSocket();
  await assert.rejects(
    connectTcp("target", 1234, {
      connectTimeoutMs: 10,
      dial: () => stalled,
    }),
    /TCP connect timed out after 10 ms/,
  );
  assert.equal(stalled.destroyCount, 1);

  const connected = new FakeSocket();
  const connecting = connectTcp("target", 1234, {
    connectTimeoutMs: 20,
    dial: () => connected,
  });
  queueMicrotask(() => connected.emit("connect"));
  const transport = await connecting;
  assert.ok(transport instanceof TcpTransport);
  await delay(25);
  assert.equal(connected.destroyCount, 0, "connect timer must be cleared on handoff");
  transport.close();
});
