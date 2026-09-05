import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import net from "node:net";
import test from "node:test";

import { connectTcp, TcpTransport } from "../src/index.mjs";

// Unlike a plain EventEmitter fake, this socket really withholds incoming
// chunks after pause(). This makes read-progress assertions deterministic.
class FlowSocket extends EventEmitter {
  paused = false;
  destroyed = false;
  pauseCount = 0;
  resumeCount = 0;
  destroyCount = 0;
  incoming = [];
  flushing = false;
  pause() { this.paused = true; this.pauseCount++; this.emit("pause"); }
  resume() { this.paused = false; this.resumeCount++; this.flush(); }
  receive(bytes) { this.incoming.push(Buffer.from(bytes)); this.flush(); }
  flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (!this.paused && !this.destroyed && this.incoming.length) {
        this.emit("data", this.incoming.shift());
      }
    } finally { this.flushing = false; }
  }
  destroy(error) {
    if (this.destroyed) return;
    this.destroyed = true; this.destroyCount++; this.incoming.length = 0;
    if (error) this.emit("error", error);
    this.emit("close");
  }
  write(_bytes, callback) { callback(this.destroyed ? new Error("socket destroyed") : undefined); }
}

function fixture(t, overrides = {}) {
  const socket = new FlowSocket();
  const transport = new TcpTransport(socket, {
    maxBufferedBytes: 16, pauseBytes: 8, resumeBytes: 4, readTimeoutMs: 500,
    ...overrides,
  });
  t.after(() => transport.close());
  return { socket, transport };
}
function read(transport, size) {
  const promise = transport.readExact(size);
  // Preserve the public rejection while avoiding stray rejections if an
  // earlier assertion fails and test cleanup closes still-pending readers.
  void promise.catch(() => {});
  return promise;
}
const bytes = (start, size) => Uint8Array.from({ length: size }, (_, i) => start + i);

test("an active exact read keeps receiving above the soft pause threshold", async t => {
  const { socket, transport } = fixture(t);
  const result = read(transport, 12);
  socket.receive(bytes(0, 8));
  assert.equal(socket.paused, false, "an incomplete 12-byte read must not pause at 8 bytes");
  socket.receive(bytes(8, 4));
  assert.deepEqual(await result, bytes(0, 12));
  assert.equal(socket.destroyed, false);
});

test("a read started after idle buffering resumes an already-paused socket", async t => {
  const { socket, transport } = fixture(t);
  socket.receive(bytes(0, 8));
  assert.equal(socket.paused, true);
  socket.receive(bytes(8, 4)); // held by the simulated socket, not yet delivered
  const result = read(transport, 12);
  assert.equal(socket.resumeCount, 1, "pending read must override idle pause");
  assert.equal(transport.waiters.length, 0);
  assert.deepEqual(await result, bytes(0, 12));
});

test("a synchronous pause listener can request more input without stranding the read", async t => {
  const { socket, transport } = fixture(t);
  let result;
  socket.once("pause", () => { result = read(transport, 12); });
  socket.receive(bytes(0, 8));
  assert.equal(transport.paused, false, "internal pause state must reflect the reentrant resume");
  assert.equal(socket.paused, false);
  assert.equal(socket.resumeCount, 1);
  socket.receive(bytes(8, 4));
  assert.deepEqual(await result, bytes(0, 12));
});

test("multiple exact readers remain FIFO while the oldest demands more input", async t => {
  const { socket, transport } = fixture(t);
  const first = read(transport, 12), second = read(transport, 4);
  socket.receive(bytes(0, 8));
  assert.equal(transport.waiters.length, 2, "later small reader must not steal buffered bytes");
  socket.receive(bytes(8, 8));
  assert.equal(transport.waiters.length, 0, "both FIFO readers should make progress");
  assert.deepEqual(await first, bytes(0, 12));
  assert.deepEqual(await second, bytes(12, 4));
});

test("a fragmented exact read equal to the hard receive cap completes", async t => {
  const { socket, transport } = fixture(t);
  const result = read(transport, 16);
  for (let offset = 0; offset < 16; offset += 2) socket.receive(bytes(offset, 2));
  assert.equal(transport.waiters.length, 0);
  assert.deepEqual(await result, bytes(0, 16));
  assert.equal(transport.len, 0);
});

test("read demand does not bypass the hard cap or consume oversized incoming chunks", async t => {
  const { socket, transport } = fixture(t);
  const first = read(transport, 16), second = read(transport, 16);
  socket.receive(bytes(0, 7));
  socket.receive(bytes(7, 10));
  await assert.rejects(first, /TCP receive buffer exceeded 16 bytes/);
  await assert.rejects(second, /TCP receive buffer exceeded 16 bytes/);
  assert.equal(transport.len, 7, "oversized chunk must not be retained or pumped first");
  assert.equal(socket.destroyCount, 1);
  await assert.rejects(transport.write(bytes(0, 1)), /receive buffer exceeded/);
});

test("hard-cap violation still fails while pending demand has crossed the soft limit", async t => {
  const { socket, transport } = fixture(t);
  const result = read(transport, 16);
  socket.receive(bytes(0, 8));
  socket.receive(bytes(8, 9));
  assert.equal(socket.destroyed, true, "soft override must retain the 16-byte hard bound");
  await assert.rejects(result, /TCP receive buffer exceeded 16 bytes/);
});

test("finishing a read re-enables idle pause for remaining buffered bytes", async t => {
  const { socket, transport } = fixture(t);
  const result = read(transport, 4);
  socket.receive(bytes(0, 12));
  assert.deepEqual(await result, bytes(0, 4));
  assert.equal(transport.len, 8);
  assert.equal(socket.paused, true);
  assert.deepEqual(await read(transport, 3), bytes(4, 3));
  assert.equal(socket.paused, true, "retain hysteresis above the low-water mark");
  assert.deepEqual(await read(transport, 1), bytes(7, 1));
  assert.equal(socket.paused, false, "resume at the low-water mark");
});

test("zero-length and rejected oversized reads do not force an idle socket to resume", async t => {
  const { socket, transport } = fixture(t);
  socket.receive(bytes(0, 8));
  assert.deepEqual(await read(transport, 0), new Uint8Array());
  await assert.rejects(read(transport, 17), /readExact size exceeds/);
  assert.equal(socket.paused, true); assert.equal(socket.resumeCount, 0);
  assert.equal(transport.waiters.length, 0);
});

test("zero soft thresholds still permit positive bounded reads and pause only when idle", async t => {
  const { socket, transport } = fixture(t, { maxBufferedBytes: 2, pauseBytes: 0, resumeBytes: 0 });
  const first = read(transport, 2);
  socket.receive([1]);
  assert.equal(socket.paused, false);
  socket.receive([2]);
  assert.deepEqual(await first, Uint8Array.of(1, 2));
  assert.equal(socket.paused, true);
  socket.receive([3]);
  const second = read(transport, 1);
  assert.equal(transport.waiters.length, 0);
  assert.deepEqual(await second, Uint8Array.of(3));
});

test("timeout rejects every incomplete queued reader and never resumes a failed socket", async t => {
  const { socket, transport } = fixture(t, { readTimeoutMs: 25 });
  const first = read(transport, 12), second = read(transport, 12);
  socket.receive(bytes(0, 8));
  await assert.rejects(first, /TCP read timed out after 25 ms/);
  await assert.rejects(second, /TCP read timed out after 25 ms/);
  const resumes = socket.resumeCount;
  assert.equal(socket.destroyCount, 1); assert.equal(transport.waiters.length, 0);
  await assert.rejects(read(transport, 12), /TCP read timed out/);
  assert.equal(socket.resumeCount, resumes);
});

test("explicit close cancels incomplete queued reads during soft-limit override", async t => {
  const { socket, transport } = fixture(t);
  const first = read(transport, 12), second = read(transport, 12);
  socket.receive(bytes(0, 8)); transport.close();
  await assert.rejects(first, /connection closed/); await assert.rejects(second, /connection closed/);
  assert.equal(socket.destroyCount, 1); assert.equal(transport.waiters.length, 0);
});

test("connection EOF rejects an incomplete read while preserving a complete buffered read", async t => {
  const { socket, transport } = fixture(t);
  const first = read(transport, 4), incomplete = read(transport, 12);
  socket.receive(bytes(0, 8)); socket.destroy();
  assert.deepEqual(await first, bytes(0, 4));
  await assert.rejects(incomplete, /connection closed/);
  assert.equal(transport.waiters.length, 0);
});

for (const prebuffered of [false, true]) {
  test(`real loopback progresses across pause threshold (${prebuffered ? "already buffered" : "reader first"})`, { timeout: 5000 }, async () => {
    const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
    let client, peer;
    try {
      const connection = once(server, "connection");
      client = await connectTcp("127.0.0.1", server.address().port, {
        maxBufferedBytes: 16384, pauseBytes: 8192, resumeBytes: 4096, readTimeoutMs: 1000,
      });
      [peer] = await connection;
      const firstArrival = new Promise(resolve => {
        let received = 0;
        const onData = chunk => { received += chunk.length; if (received >= 8192) { client.socket.off("data", onData); resolve(); } };
        client.socket.on("data", onData);
      });
      let result = prebuffered ? null : read(client, 12000);
      peer.write(Buffer.alloc(8192, 1)); await firstArrival;
      if (prebuffered) {
        assert.equal(client.paused, true);
        result = read(client, 12000);
      }
      peer.write(Buffer.alloc(3808, 2));
      const value = await result;
      assert.equal(value.length, 12000);
      assert(value.subarray(0, 8192).every(byte => byte === 1));
      assert(value.subarray(8192).every(byte => byte === 2));
      assert.equal(client.err, null);
    } finally { client?.close(); peer?.destroy(); await new Promise(resolve => server.close(resolve)); }
  });
}
