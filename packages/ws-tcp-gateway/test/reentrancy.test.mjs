import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Duplex, PassThrough } from "node:stream";
import test from "node:test";

import { bridgeWebSocketToDuplex } from "../src/index.mjs";

const turn = () => new Promise(resolve => setImmediate(resolve));

class Endpoint extends EventEmitter {
  closed = false;
  binaryHandler = null;
  writable = true;
  sent = [];
  closeCount = 0;
  resumeCount = 0;
  onSend = null;

  setBinaryHandler(handler) { this.binaryHandler = handler; }
  resumeIncoming() { this.resumeCount++; }
  sendBinary(bytes) {
    this.sent.push(bytes);
    this.onSend?.();
    return this.writable;
  }
  close() {
    if (this.closed) return false;
    this.closed = true;
    this.closeCount++;
    this.emit("close");
    return true;
  }
}

function fixture(t, { passthrough = false } = {}) {
  const websocket = new Endpoint();
  const writes = [];
  let onWrite = () => {};
  const duplex = passthrough ? new PassThrough() : new Duplex({
    // A genuine Node Writable invokes this hook synchronously from write().
    writableHighWaterMark: 1,
    read() {},
    write(bytes, _encoding, callback) {
      writes.push(bytes);
      onWrite();
      // Keep the write outstanding so native write() really returns false.
      // An immediately completed write can return true even above its HWM.
      setImmediate(callback);
    },
  });
  const calls = { pause: 0, resume: 0 };
  for (const method of Object.keys(calls)) {
    const original = duplex[method].bind(duplex);
    duplex[method] = (...args) => { calls[method]++; return original(...args); };
  }

  // Cleanup must remove only bridge-owned listeners, not application observers.
  const callerListeners = [];
  for (const [endpoint, events] of [
    [websocket, ["close", "error", "drain"]],
    [duplex, ["data", "end", "close", "error", "drain"]],
  ]) {
    for (const event of events) {
      const listener = () => {};
      endpoint.on(event, listener);
      callerListeners.push({ endpoint, event, listener });
    }
  }
  const errors = [];
  const bridge = bridgeWebSocketToDuplex(websocket, duplex, {
    closeTimeoutMs: 0,
    onError(error, context) { errors.push({ error, side: context.side }); },
  });
  const savedBinaryHandler = websocket.binaryHandler;
  t.after(async () => {
    bridge.close();
    duplex.destroy();
    await turn();
  });

  async function assertStopped() {
    await turn(); // Native streams emit their terminal close asynchronously.
    assert.equal(bridge.closed, true);
    assert.equal(bridge.close(), false, "shutdown must be idempotent");
    assert.equal(websocket.closeCount, 1, "the endpoint closes exactly once");
    assert.equal(websocket.binaryHandler, null);
    assert.equal(duplex.destroyed, true);
    for (const { endpoint, event, listener } of callerListeners) {
      assert.deepEqual(endpoint.listeners(event), [listener], `${event} cleanup must retain only the caller listener`);
    }

    const before = { sent: websocket.sent.length, writes: writes.length,
      websocketResumes: websocket.resumeCount, duplexResumes: calls.resume };
    assert.equal(savedBinaryHandler(Uint8Array.of(99)), false);
    duplex.emit("data", Buffer.from([100]));
    websocket.emit("drain");
    duplex.emit("drain");
    assert.deepEqual({ sent: websocket.sent.length, writes: writes.length,
      websocketResumes: websocket.resumeCount, duplexResumes: calls.resume }, before,
    "late data and drain must neither forward bytes nor resume closed endpoints");
  }
  return { websocket, duplex, bridge, errors, calls, writes, assertStopped,
    onWrite(callback) { onWrite = callback; } };
}

test("real PassThrough pause listener can close without a late WebSocket drain listener", async t => {
  const f = fixture(t, { passthrough: true });
  f.websocket.writable = false;
  f.duplex.once("pause", () => f.bridge.close());
  f.duplex.write(Buffer.from([1, 2, 3]));
  assert.equal(f.calls.pause, 1);
  await f.assertStopped();
  assert.deepEqual(f.errors, []);
});

for (const transition of ["close", "error"]) {
  test(`sendBinary may synchronously ${transition} before returning backpressure`, async t => {
    const f = fixture(t);
    const failure = new Error("WebSocket send failed");
    f.websocket.writable = false;
    f.websocket.onSend = () => {
      if (transition === "close") f.websocket.close();
      else f.websocket.emit("error", failure);
    };
    f.duplex.push(Buffer.from([1, 2, 3]));
    await f.assertStopped();
    assert.equal(f.calls.pause, 0, "a closed bridge must not pause its duplex after send returns");
    assert.deepEqual(f.errors, transition === "error" ? [{ error: failure, side: "websocket" }] : []);
  });

  test(`native Duplex write hook may synchronously ${transition} before returning false`, async t => {
    const f = fixture(t);
    const failure = new Error("duplex write failed");
    f.onWrite(() => {
      if (transition === "close") f.bridge.close();
      else f.duplex.emit("error", failure);
    });
    assert.equal(f.websocket.binaryHandler(Uint8Array.of(4, 5, 6)), false);
    await f.assertStopped();
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.errors, transition === "error" ? [{ error: failure, side: "duplex" }] : []);
  });
}

test("a synchronous WebSocket drain during native pause is not lost", async t => {
  const f = fixture(t);
  f.websocket.writable = false;
  const initialResumes = f.calls.resume;
  f.duplex.once("pause", () => {
    f.websocket.writable = true;
    f.websocket.emit("drain");
  });
  f.duplex.push(Buffer.from([7, 8]));
  await turn();
  assert.equal(f.bridge.closed, false);
  assert.equal(f.calls.pause, 1);
  assert.equal(f.calls.resume, initialResumes + 1, "drain emitted from pause must resume the duplex");
  assert.equal(f.websocket.listenerCount("drain"), 1, "only the caller's drain observer remains");
  f.bridge.close();
  await f.assertStopped();
});

for (const side of ["websocket", "duplex"]) {
  test(`${side} newListener observer can close during drain registration`, async t => {
    const f = fixture(t);
    const endpoint = side === "websocket" ? f.websocket : f.duplex;
    // Node emits newListener before adding the requested listener. An ordinary
    // application observer may cancel a session at that synchronous boundary.
    const closeOnDrainRegistration = event => {
      if (event === "drain") f.bridge.close();
    };
    endpoint.on("newListener", closeOnDrainRegistration);
    if (side === "websocket") {
      f.websocket.writable = false;
      f.duplex.push(Buffer.from([9, 10]));
    } else {
      assert.equal(f.websocket.binaryHandler(Uint8Array.of(11, 12)), false);
    }
    await f.assertStopped();
    assert.ok(endpoint.listeners("newListener").includes(closeOnDrainRegistration));
  });
}
