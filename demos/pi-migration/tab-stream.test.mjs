import assert from "node:assert/strict";
import test from "node:test";
import { TabByteStream } from "./tab-stream.mjs";

class Channels {
  constructor() { this.channels = new Set(); this.messages = []; this.drop = () => false; }

  factory = (name) => {
    const channel = {
      name, listeners: new Map(), closed: false,
      addEventListener(kind, handler) {
        const handlers = this.listeners.get(kind) ?? new Set();
        handlers.add(handler);
        this.listeners.set(kind, handlers);
      },
      removeEventListener(kind, handler) { this.listeners.get(kind)?.delete(handler); },
      postMessage: (message) => {
        if (channel.closed) throw new Error("channel already closed");
        this.messages.push(structuredClone(message));
        if (this.drop(message)) return;
        for (const peer of this.channels) {
          if (peer === channel || peer.name !== name || peer.closed) continue;
          const copy = structuredClone(message);
          queueMicrotask(() => {
            if (!peer.closed) for (const listener of peer.listeners.get("message") ?? []) listener({ data: copy });
          });
        }
      },
      close: () => { channel.closed = true; this.channels.delete(channel); },
    };
    this.channels.add(channel);
    return channel;
  };

  inject(stream, message) {
    stream.receive({ version: 1, operationId: "operation", from: stream.remoteId,
      to: stream.localId, ...message });
  }
}

function make(hub, localId, options = {}) {
  return new TabByteStream({ room: "room", operationId: "operation", localId,
    remoteId: localId === "source" ? "target" : "source", channelFactory: hub.factory,
    timeoutMs: 250, ...options });
}

async function pair(t, options = {}, hub = new Channels()) {
  const target = make(hub, "target", options);
  const source = make(hub, "source", options);
  t.after(async () => { await source.close(); await target.close(); assert.equal(hub.channels.size, 0); });
  await Promise.all([source.opened, target.opened]);
  return { hub, source, target };
}

test("tab byte stream carries fragmented, concurrent writes into exact FIFO reads", async (t) => {
  const { hub, source, target } = await pair(t);
  const first = Uint8Array.from({ length: 50_001 }, (_, index) => index % 251);
  const second = Uint8Array.of(250, 249, 248);
  const reads = [target.readExact(3), target.readExact(49_999), target.readExact(2)];
  await Promise.all([source.write(first), source.write(second)]);
  const chunks = await Promise.all(reads);
  const actual = new Uint8Array(50_004);
  let offset = 0;
  for (const chunk of chunks) { actual.set(chunk, offset); offset += chunk.length; }
  const expected = new Uint8Array(50_004);
  expected.set(first);
  expected.set(second, first.length);
  assert.deepEqual(actual, expected);
  assert.ok(hub.messages.filter((message) => message.kind === "data").every((message) => message.bytes.length <= 16 * 1024));
  assert.equal(target.bufferedBytes, 0);
  assert.equal(source.pendingAck, null);
});

test("tab writes own bytes before awaiting and returned reads do not alias later packets", async (t) => {
  const { source, target } = await pair(t);
  const original = Uint8Array.of(1, 2, 3, 4);
  const writing = source.write(original);
  original.fill(99);
  await writing;
  const first = await target.readExact(2);
  first.fill(77);
  assert.deepEqual(await target.readExact(2), Uint8Array.of(3, 4));
});

test("tab rendezvous tolerates a late peer and lost initial hello/ready packets", async (t) => {
  const hub = new Channels();
  let droppedHello = false;
  let droppedReady = false;
  hub.drop = (message) => {
    if (message.kind === "hello" && message.from === "source" && !droppedHello) return droppedHello = true;
    if (message.kind === "ready" && !droppedReady) return droppedReady = true;
    return false;
  };
  const target = make(hub, "target");
  t.after(() => target.close());
  await new Promise((resolve) => setTimeout(resolve, 5));
  const source = make(hub, "source");
  t.after(() => source.close());
  await Promise.all([source.openedPromise, target.opened]);
  assert.equal(droppedHello, true);
  assert.equal(droppedReady, true);
  await source.write(Uint8Array.of(42));
  assert.deepEqual(await target.readExact(1), Uint8Array.of(42));
});

test("tab close cancels a pending read and missing-ACK write without waiting for the peer", async (t) => {
  const { hub, source, target } = await pair(t);
  hub.drop = (message) => message.kind === "ack";
  const write = source.write(Uint8Array.of(1, 2, 3));
  const read = source.readExact(1);
  const writeFailure = assert.rejects(write, /closed locally/);
  const readFailure = assert.rejects(read, /closed locally/);
  await source.close();
  await Promise.all([writeFailure, readFailure, source.closed]);
  await target.closed;
  assert.equal(hub.channels.size, 0);
});

test("remote close drains complete bytes already received, then reports EOF", async (t) => {
  const { source, target } = await pair(t);
  await source.write(Uint8Array.of(1, 2, 3));
  await source.close();
  await target.closed;
  assert.deepEqual(await target.readExact(2), Uint8Array.of(1, 2));
  await assert.rejects(target.readExact(2), /peer closed/);
  assert.deepEqual(await target.readExact(1), Uint8Array.of(3));
  await assert.rejects(target.readExact(1), /peer closed/);
});

test("lost acknowledgements fail closed at a bounded write deadline", async (t) => {
  const { hub, source, target } = await pair(t, { timeoutMs: 40 });
  hub.drop = (message) => message.kind === "ack";
  const one = source.write(Uint8Array.of(9));
  const two = source.write(Uint8Array.of(8));
  await Promise.all([assert.rejects(one, /acknowledgement timed out/), assert.rejects(two, /acknowledgement timed out/)]);
  await target.closed;
  assert.equal(hub.channels.size, 0);
});

test("frozen peers and incomplete reads have independent bounded deadlines", async (t) => {
  const { source, target } = await pair(t, { timeoutMs: 35 });
  await assert.rejects(source.readExact(1), /read timed out/);
  await target.closed;
  const hub = new Channels();
  const orphan = make(hub, "source", { timeoutMs: 25 });
  await assert.rejects(orphan.opened, /connection timed out/);
  await orphan.closed;
  assert.equal(hub.channels.size, 0);
});

test("oversized read headers and writes reject before allocating their declared size", async (t) => {
  const { source, target } = await pair(t, { maxBufferedBytes: 64, maxWriteBytes: 32 });
  await assert.rejects(target.readExact(0xffffffff), /read size/);
  await assert.rejects(target.readExact(-1), /read size/);
  await assert.rejects(target.readExact(0.5), /read size/);
  await assert.rejects(source.write(new Uint8Array(33)), /write size limit/);
  await assert.rejects(source.write(new ArrayBuffer(1)), /Uint8Array/);
  await source.write(Uint8Array.of(7));
  assert.deepEqual(await target.readExact(1), Uint8Array.of(7));
});

for (const [label, message] of [
  ["oversized packet", { kind: "data", sequence: 0, bytes: new Uint8Array(16 * 1024 + 1) }],
  ["wrong packet sequence", { kind: "data", sequence: 4, bytes: Uint8Array.of(1) }],
  ["non-byte payload", { kind: "data", sequence: 0, bytes: [1] }],
  ["empty packet", { kind: "data", sequence: 0, bytes: new Uint8Array() }],
  ["wrong acknowledgement", { kind: "ack", sequence: 0 }],
  ["unknown message", { kind: "wat" }],
  ["wrong version", { kind: "hello", version: 7 }],
]) {
  test(`malformed peer ${label} fails the tab stream closed`, async (t) => {
    const { hub, source, target } = await pair(t);
    hub.inject(target, message);
    await target.closed;
    await source.closed;
    await assert.rejects(target.readExact(1), /invalid tab stream/);
    assert.equal(hub.channels.size, 0);
  });
}

test("wrong peer IDs and operation IDs cannot inject bytes into this operation", async (t) => {
  const { hub, source, target } = await pair(t);
  for (const wrong of [{ from: "stranger" }, { to: "stranger" }, { operationId: "another-operation" }]) {
    hub.inject(target, { kind: "data", sequence: 0, bytes: Uint8Array.of(99), ...wrong });
  }
  await source.write(Uint8Array.of(1));
  assert.deepEqual(await target.readExact(1), Uint8Array.of(1));
});

test("receiver buffering and sender queued copies are both bounded", async (t) => {
  const { source, target } = await pair(t, { maxBufferedBytes: 20, maxWriteBytes: 20 });
  await source.write(new Uint8Array(16));
  await assert.rejects(source.write(new Uint8Array(8)), /peer closed/);
  assert.match((await target.closed).message, /receive buffer limit/);

  const second = await pair(t, { maxBufferedBytes: 20, maxWriteBytes: 20 });
  second.hub.drop = (message) => message.kind === "ack";
  const first = second.source.write(new Uint8Array(16));
  const overflow = second.source.write(new Uint8Array(8));
  await Promise.all([assert.rejects(first, /queued write limit/), assert.rejects(overflow, /queued write limit/)]);
});

test("read queue count is bounded even when individual read lengths are small", async (t) => {
  const { source } = await pair(t);
  const pending = Array.from({ length: 65 }, () => source.readExact(1));
  await Promise.all(pending.map((read) => assert.rejects(read, /too many queued/)));
});

test("the default receive cap rejects byte 8 MiB + 1 and clears retained packets", async (t) => {
  const { source, target } = await pair(t, { timeoutMs: 2000 });
  await source.write(new Uint8Array(4 * 1024 * 1024));
  await source.write(new Uint8Array(4 * 1024 * 1024));
  assert.equal(target.bufferedBytes, 8 * 1024 * 1024);
  await assert.rejects(source.write(Uint8Array.of(1)), /peer closed/);
  assert.match((await target.closed).message, /receive buffer limit/);
  assert.equal(target.bufferedBytes, 0);
  assert.equal(target.buffers.length, 0);
});

test("many tiny packets cannot evade the bounded receiver allocation", async (t) => {
  const { hub, target } = await pair(t);
  // Suppress ACK delivery: this injects a malicious peer's legal packet
  // sequence without pretending that our normal serialized sender did it.
  hub.drop = (message) => message.kind === "ack";
  for (let sequence = 0; sequence < 4097; sequence++) {
    hub.inject(target, { kind: "data", sequence, bytes: Uint8Array.of(1) });
  }
  assert.match((await target.closed).message, /receive buffer limit/);
  assert.equal(target.buffers.length, 0);
});

test("real Node BroadcastChannels carry and close an actual byte stream", { timeout: 3000 }, async (t) => {
  const operationId = `real-${process.pid}-${Date.now()}`;
  const options = { room: "test", operationId, timeoutMs: 1000 };
  const target = new TabByteStream({ ...options, localId: "target", remoteId: "source" });
  const source = new TabByteStream({ ...options, localId: "source", remoteId: "target" });
  t.after(async () => { await source.close(); await target.close(); });
  await Promise.all([source.opened, target.opened]);
  const expected = Uint8Array.from({ length: 100_000 }, (_, index) => index % 255);
  const reading = target.readExact(expected.length);
  await source.write(expected);
  assert.deepEqual(await reading, expected);
  await source.close();
  assert.match((await target.closed).message, /peer closed/);
});
