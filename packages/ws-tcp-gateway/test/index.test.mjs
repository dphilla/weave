import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  DEFAULT_CLOSE_TIMEOUT_MS,
  bridgeWebSocketToDuplex,
} from "../src/index.mjs";

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
    this.binaryHandler = null;
    this.sent = [];
    this.sendWritable = true;
    this.resumeCount = 0;
    this.closeCalls = [];
  }

  setBinaryHandler(handler) {
    this.binaryHandler = handler;
  }

  resumeIncoming() {
    this.resumeCount++;
  }

  sendBinary(bytes) {
    this.sent.push(bytes);
    return this.sendWritable;
  }

  close(code = 1000, reason = "") {
    if (this.closed) return false;
    this.closed = true;
    this.closeCalls.push({ code, reason });
    this.emit("close", { code, reason });
    return true;
  }

  receive(bytes) {
    if (this.binaryHandler === null) throw new Error("no binary handler");
    return this.binaryHandler(bytes);
  }
}

class FakeDuplex extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writeWritable = true;
    this.writes = [];
    this.pauseCount = 0;
    this.resumeCount = 0;
    this.endCount = 0;
    this.destroyCount = 0;
  }

  write(bytes) {
    this.writes.push(bytes);
    return this.writeWritable;
  }

  pause() {
    this.pauseCount++;
    return this;
  }

  resume() {
    this.resumeCount++;
    return this;
  }

  end() {
    this.endCount++;
    return this;
  }

  destroy() {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.destroyCount++;
    this.emit("close");
    return this;
  }
}

function assertBridgeListenersRemoved(websocket, duplex) {
  for (const event of ["close", "error", "drain"]) {
    assert.equal(websocket.listenerCount(event), 0, `WebSocket ${event} listener leaked`);
  }
  for (const event of ["data", "end", "close", "error", "drain"]) {
    assert.equal(duplex.listenerCount(event), 0, `duplex ${event} listener leaked`);
  }
}

test("exports its documented default close timeout", () => {
  assert.equal(DEFAULT_CLOSE_TIMEOUT_MS, 2_000);
});

test("passes bytes unchanged in both directions and closes idempotently", () => {
  const websocket = new FakeWebSocket();
  const duplex = new FakeDuplex();
  const bridge = bridgeWebSocketToDuplex(websocket, duplex, { closeTimeoutMs: 0 });

  const fromWebSocket = Uint8Array.of(0, 1, 254, 255);
  const fromDuplex = Buffer.from([9, 8, 7]);
  assert.equal(websocket.receive(fromWebSocket), true);
  duplex.emit("data", fromDuplex);

  assert.strictEqual(duplex.writes[0], fromWebSocket);
  assert.strictEqual(websocket.sent[0], fromDuplex);
  assert.equal(bridge.closed, false);
  assert.equal(bridge.close(1001, "manual stop"), true);
  assert.equal(bridge.close(), false);
  assert.equal(bridge.closed, true);
  assert.deepEqual(websocket.closeCalls, [{ code: 1001, reason: "manual stop" }]);
  assert.equal(duplex.endCount, 1);
  assert.equal(duplex.destroyCount, 1);
  assert.equal(websocket.binaryHandler, null);
  assertBridgeListenersRemoved(websocket, duplex);
});

test("rejects text-mode endpoint data instead of silently reframing it", () => {
  const observed = [];
  const websocket = new FakeWebSocket();
  const duplex = new FakeDuplex();
  const bridge = bridgeWebSocketToDuplex(websocket, duplex, {
    closeTimeoutMs: 0,
    onError(error, context) {
      observed.push([error.message, context.side]);
    },
  });

  duplex.emit("data", "text from a stream with setEncoding() enabled");

  assert.equal(bridge.closed, true);
  assert.deepEqual(observed, [["duplex endpoint emitted a non-binary chunk", "duplex"]]);
  assert.deepEqual(websocket.closeCalls, [{ code: 1011, reason: "duplex endpoint failed" }]);
  assertBridgeListenersRemoved(websocket, duplex);
});

test("propagates duplex write backpressure to incoming WebSocket delivery", () => {
  const websocket = new FakeWebSocket();
  const duplex = new FakeDuplex();
  duplex.writeWritable = false;
  const bridge = bridgeWebSocketToDuplex(websocket, duplex, { closeTimeoutMs: 0 });

  assert.equal(websocket.receive(Uint8Array.of(1, 2, 3)), false);
  assert.equal(websocket.resumeCount, 0);
  assert.equal(duplex.listenerCount("drain"), 1);

  duplex.writeWritable = true;
  duplex.emit("drain");
  assert.equal(websocket.resumeCount, 1);
  assert.equal(duplex.listenerCount("drain"), 0);

  bridge.close();
});

test("pauses the duplex until outgoing WebSocket backpressure drains", () => {
  const websocket = new FakeWebSocket();
  const duplex = new FakeDuplex();
  websocket.sendWritable = false;
  const bridge = bridgeWebSocketToDuplex(websocket, duplex, { closeTimeoutMs: 0 });
  const initialResumes = duplex.resumeCount;

  duplex.emit("data", Uint8Array.of(4, 5, 6));
  assert.equal(duplex.pauseCount, 1);
  assert.equal(websocket.listenerCount("drain"), 1);

  websocket.sendWritable = true;
  websocket.emit("drain");
  assert.equal(duplex.resumeCount, initialResumes + 1);
  assert.equal(websocket.listenerCount("drain"), 0);

  bridge.close();
});

test("reports endpoint errors with labels and sides", () => {
  const observed = [];
  const websocket = new FakeWebSocket();
  const duplex = new FakeDuplex();
  const bridge = bridgeWebSocketToDuplex(websocket, duplex, {
    label: "session-7",
    closeTimeoutMs: 0,
    onError(error, context) {
      observed.push({ message: error.message, ...context });
      throw new Error("observer failure is isolated");
    },
  });

  duplex.emit("error", new Error("write failed"));
  assert.equal(bridge.closed, true);
  assert.deepEqual(observed, [{
    message: "write failed",
    label: "session-7",
    side: "duplex",
  }]);
  assert.deepEqual(websocket.closeCalls, [{ code: 1011, reason: "duplex endpoint failed" }]);
  assert.equal(duplex.destroyCount, 1);
  assertBridgeListenersRemoved(websocket, duplex);
});

test("WebSocket errors close the duplex after the configured grace period", async () => {
  const observed = [];
  const websocket = new FakeWebSocket();
  const duplex = new FakeDuplex();
  const bridge = bridgeWebSocketToDuplex(websocket, duplex, {
    label: "browser",
    closeTimeoutMs: 5,
    onError(error, context) {
      observed.push([error.message, context.label, context.side]);
    },
  });

  websocket.emit("error", new Error("socket failed"));
  assert.equal(bridge.closed, true);
  assert.equal(duplex.endCount, 1);
  assert.equal(duplex.destroyed, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(duplex.destroyCount, 1);
  assert.deepEqual(observed, [["socket failed", "browser", "websocket"]]);
  assertBridgeListenersRemoved(websocket, duplex);
});

test("observes duplex errors that arrive during graceful shutdown", async () => {
  const observed = [];
  const websocket = new FakeWebSocket();
  const duplex = new FakeDuplex();
  const bridge = bridgeWebSocketToDuplex(websocket, duplex, {
    closeTimeoutMs: 5,
    onError(error, context) {
      observed.push([error.message, context.side]);
    },
  });

  websocket.emit("close", { code: 1000, reason: "done" });
  assert.equal(bridge.closed, true);
  duplex.emit("error", new Error("late socket failure"));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(observed, [["late socket failure", "duplex"]]);
  assert.equal(duplex.destroyCount, 1);
  assertBridgeListenersRemoved(websocket, duplex);
});

test("ordinary close is not reported as an error", () => {
  const errors = [];
  const websocket = new FakeWebSocket();
  const duplex = new FakeDuplex();
  const bridge = bridgeWebSocketToDuplex(websocket, duplex, {
    closeTimeoutMs: 0,
    onError: (...args) => errors.push(args),
  });

  websocket.emit("close", { code: 1000, reason: "done" });
  assert.equal(bridge.closed, true);
  assert.equal(duplex.endCount, 1);
  assert.equal(duplex.destroyCount, 1);
  assert.deepEqual(errors, []);
  assertBridgeListenersRemoved(websocket, duplex);
});

test("validates endpoint contracts before installing listeners", () => {
  const websocket = new FakeWebSocket();
  const duplex = new FakeDuplex();

  assert.throws(
    () => bridgeWebSocketToDuplex({ ...websocket }, duplex),
    /websocket\.once must be a function/,
  );
  assert.throws(
    () => bridgeWebSocketToDuplex(websocket, {}, {}),
    /duplex\.on must be a function/,
  );
  assert.throws(
    () => bridgeWebSocketToDuplex(websocket, duplex, { closeTimeoutMs: -1 }),
    /non-negative finite number/,
  );
  assert.equal(websocket.listenerCount("close"), 0);
  assert.equal(duplex.listenerCount("data"), 0);
});
