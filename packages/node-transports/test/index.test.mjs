import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import test from "node:test";

import {
  connectTcp,
  readFirstSocketByte,
  TcpTransport,
} from "../src/index.mjs";

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
  read(size) {
    if (this.readBuffer.length < size) return null;
    const value = this.readBuffer.subarray(0, size);
    this.readBuffer = this.readBuffer.subarray(size);
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

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("TcpTransport validates buffer thresholds and timeouts", () => {
  const socket = new FakeSocket();
  assert.throws(
    () => new TcpTransport(socket, { maxBufferedBytes: 4, pauseBytes: 5 }),
    /resumeBytes <= pauseBytes <= maxBufferedBytes/,
  );
  assert.throws(
    () => new TcpTransport(socket, { readTimeoutMs: 0 }),
    /readTimeoutMs must be a positive safe integer/,
  );
});

test("TcpTransport pauses and resumes around bounded unread input", async () => {
  const socket = new FakeSocket();
  const transport = new TcpTransport(socket, {
    maxBufferedBytes: 8,
    pauseBytes: 4,
    resumeBytes: 1,
  });

  socket.emit("data", Buffer.from([1, 2, 3, 4]));
  assert.equal(socket.pauseCount, 1);
  assert.deepEqual([...await transport.readExact(3)], [1, 2, 3]);
  assert.equal(socket.resumeCount, 1);
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

test("TcpTransport coalesces reads, splits chunks, and preserves writes", async () => {
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
  assert.deepEqual([...await transport.readExact(0)], []);
  await transport.write(Uint8Array.of(6, 7));
  assert.deepEqual([...socket.writes[0]], [6, 7]);

  transport.close();
  assert.equal(socket.destroyCount, 1);
});

test("TcpTransport gives stalled reads and writes finite deadlines", async () => {
  const readSocket = new FakeSocket();
  const reading = new TcpTransport(readSocket, { readTimeoutMs: 20 });
  await assert.rejects(reading.readExact(1), /TCP read timed out after 20 ms/);
  assert.equal(readSocket.destroyCount, 1);

  const writeSocket = new FakeSocket();
  writeSocket.stallWrites = true;
  const writing = new TcpTransport(writeSocket, { writeTimeoutMs: 20 });
  await assert.rejects(writing.write(Uint8Array.of(1)), /TCP write timed out after 20 ms/);
  assert.equal(writeSocket.destroyCount, 1);
});

test("readFirstSocketByte restores the byte and clears its timer", async () => {
  const socket = new FakeSocket();
  const first = readFirstSocketByte(socket, 20);
  socket.readBuffer = Buffer.from([17]);
  socket.emit("readable");

  assert.equal(await first, 17);
  assert.deepEqual([...socket.readBuffer], [17]);
  await delay(30);
  assert.equal(socket.destroyCount, 0, "classification timer must be cleared");
});

test("readFirstSocketByte times out and rejects premature close", async () => {
  const silent = new FakeSocket();
  await assert.rejects(readFirstSocketByte(silent, 20), /classification timed out after 20 ms/);
  assert.equal(silent.destroyCount, 1);

  const closed = new FakeSocket();
  const classification = readFirstSocketByte(closed, 50);
  closed.emit("close");
  await assert.rejects(classification, /connection closed before protocol classification/);
});

test("connectTcp times out and hands a connected socket to TcpTransport", async () => {
  const stalled = new FakeSocket();
  await assert.rejects(
    connectTcp("target.test", 1234, {
      connectTimeoutMs: 20,
      dial: () => stalled,
    }),
    /TCP connect timed out after 20 ms/,
  );
  assert.equal(stalled.destroyCount, 1);

  const connected = new FakeSocket();
  const connecting = connectTcp("target.test", 1234, {
    connectTimeoutMs: 50,
    dial: (options) => {
      assert.deepEqual(options, { host: "target.test", port: 1234, noDelay: true });
      return connected;
    },
    maxBufferedBytes: 32,
    pauseBytes: 24,
    resumeBytes: 8,
    transportOptions: {
      maxBufferedBytes: 16,
      pauseBytes: 12,
      resumeBytes: 4,
    },
  });
  queueMicrotask(() => connected.emit("connect"));

  const transport = await connecting;
  assert.ok(transport instanceof TcpTransport);
  assert.equal(transport.maxBufferedBytes, 16, "nested options take precedence");
  await delay(60);
  assert.equal(connected.destroyCount, 0, "connect timer must be cleared on handoff");
  transport.close();
});

test("connectTcp accepts transport settings directly", async () => {
  const connected = new FakeSocket();
  const connecting = connectTcp("target.test", 1234, {
    connectTimeoutMs: 50,
    dial: () => connected,
    maxBufferedBytes: 24,
    pauseBytes: 18,
    resumeBytes: 6,
    readTimeoutMs: 70,
    writeTimeoutMs: 80,
  });
  queueMicrotask(() => connected.emit("connect"));

  const transport = await connecting;
  assert.equal(transport.maxBufferedBytes, 24);
  assert.equal(transport.pauseBytes, 18);
  assert.equal(transport.resumeBytes, 6);
  assert.equal(transport.readTimeoutMs, 70);
  assert.equal(transport.writeTimeoutMs, 80);
  transport.close();
});

test("connectTcp exchanges bytes with a real loopback TCP peer", async () => {
  let accept;
  const accepted = new Promise((resolve) => { accept = resolve; });
  const server = net.createServer((socket) => accept(socket));
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  let client;
  let peer;
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    [client, peer] = await Promise.all([
      connectTcp("127.0.0.1", address.port, {
        connectTimeoutMs: 1_000,
        maxBufferedBytes: 64,
        pauseBytes: 48,
        resumeBytes: 16,
        readTimeoutMs: 1_000,
        writeTimeoutMs: 1_000,
      }),
      accepted.then((socket) => new TcpTransport(socket, {
        maxBufferedBytes: 64,
        pauseBytes: 48,
        resumeBytes: 16,
        readTimeoutMs: 1_000,
        writeTimeoutMs: 1_000,
      })),
    ]);

    await client.write(Uint8Array.of(1, 2, 3));
    assert.deepEqual([...await peer.readExact(3)], [1, 2, 3]);
    await peer.write(Uint8Array.of(4, 5, 6, 7));
    assert.deepEqual([...await client.readExact(2)], [4, 5]);
    assert.deepEqual([...await client.readExact(2)], [6, 7]);
  } finally {
    client?.close();
    peer?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
