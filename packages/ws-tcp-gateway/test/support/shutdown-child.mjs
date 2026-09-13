import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { PassThrough } from "node:stream";

import { bridgeWebSocketToDuplex } from "../../src/index.mjs";

const scenario = process.argv[2];
const [kind, schedule] = scenario.split(":");
const failure = new Error(`I/O failure: ${scenario}`);
const immediate = () => new Promise((resolve) => setImmediate(resolve));
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const bridgeTimers = new Set();

// Track even unref'ed bridge timers: process exit alone would miss those leaks.
globalThis.setTimeout = (callback, delay, ...args) => {
  const handle = nativeSetTimeout(() => {
    bridgeTimers.delete(handle);
    callback(...args);
  }, delay);
  bridgeTimers.add(handle);
  return handle;
};
globalThis.clearTimeout = (handle) => {
  bridgeTimers.delete(handle);
  return nativeClearTimeout(handle);
};

class WebSocketEndpoint extends EventEmitter {
  closed = false;
  binaryHandler = null;
  closeCount = 0;
  setBinaryHandler(handler) { this.binaryHandler = handler; }
  resumeIncoming() {}
  sendBinary() { return true; }
  close() {
    if (this.closed) return false;
    this.closed = true;
    this.closeCount++;
    this.emit("close");
    return true;
  }
}

class SynchronousDuplex extends EventEmitter {
  destroyed = false;
  write() { return true; }
  pause() { return this; }
  resume() { return this; }
  end() { return this; }
  destroy() {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

const duplexEvents = ["data", "end", "close", "error", "drain"];
const websocketEvents = ["close", "error", "drain"];
function captureListeners(endpoint, events) {
  return new Map(events.map((event) => [event, endpoint.listeners(event)]));
}
function listenersMatch(endpoint, expected) {
  return [...expected].every(([event, listeners]) => {
    const actual = endpoint.listeners(event);
    return actual.length === listeners.length && actual.every((fn, i) => fn === listeners[i]);
  });
}

async function waitForCleanup(websocket, duplex, expectedWebSocket, expectedDuplex) {
  const complete = () => listenersMatch(websocket, expectedWebSocket)
    && listenersMatch(duplex, expectedDuplex);
  if (!complete()) {
    await new Promise((resolve, reject) => {
      // Listener removal is observable; no scheduling-dependent sleep is needed.
      const check = () => queueMicrotask(() => {
        if (complete()) finish();
      });
      const timer = nativeSetTimeout(() => finish(new Error(
        `bridge observers leaked: ${JSON.stringify(Object.fromEntries(
          duplexEvents.map((event) => [event, duplex.listenerCount(event)]),
        ))}`,
      )), 5_000);
      const finish = (error) => {
        nativeClearTimeout(timer);
        duplex.off("removeListener", check);
        websocket.off("removeListener", check);
        if (error) reject(error);
        else resolve();
      };
      duplex.on("removeListener", check);
      websocket.on("removeListener", check);
      check();
    });
  }
  // Allow queued native error/close delivery and timer cancellation to complete.
  await immediate();
  assert.equal(listenersMatch(websocket, expectedWebSocket), true, "WebSocket caller listeners changed");
  assert.equal(listenersMatch(duplex, expectedDuplex), true, "duplex caller listeners changed");
  assert.equal(bridgeTimers.size, 0, "bridge left a pending timeout, including unref'ed timeouts");
}

async function socketPair() {
  const server = net.createServer({ allowHalfOpen: true });
  let peer;
  const accepted = new Promise((resolve) => server.once("connection", (socket) => {
    peer = socket;
    // This is the remote endpoint, not the bridged socket whose errors are tested.
    socket.on("error", () => {});
    resolve();
  }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const duplex = net.createConnection({ port: server.address().port, host: "127.0.0.1", allowHalfOpen: true });
  try {
    await Promise.all([
      accepted,
      new Promise((resolve, reject) => {
        duplex.once("connect", resolve);
        duplex.once("error", reject);
      }),
    ]);
    // Do not accidentally mask a gateway error with a connection-setup listener.
    duplex.removeAllListeners("error");
    return {
      duplex,
      async cleanup() {
        duplex.destroy();
        peer.destroy();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      },
    };
  } catch (error) {
    duplex.destroy();
    peer?.destroy();
    server.close();
    throw error;
  }
}

async function run() {
  const websocket = new WebSocketEndpoint();
  let duplex;
  let cleanup = async () => {};
  let releaseDestroy;
  let destroyStarted;
  const started = new Promise((resolve) => { destroyStarted = resolve; });
  if (kind === "socket") {
    ({ duplex, cleanup } = await socketPair());
  } else if (kind === "sync-duplex" || kind === "silent-duplex") {
    duplex = new SynchronousDuplex();
    if (kind === "silent-duplex") duplex.destroyed = true;
  } else {
    const emitClose = kind !== "emit-close-false";
    // The timeout schedule must reach the bridge's force-close timer rather
    // than PassThrough auto-destruction after its readable/writable ends.
    duplex = new PassThrough({ emitClose, autoDestroy: schedule !== "timeout" });
    if (kind === "async-destroy" || schedule === "async-error") {
      duplex._destroy = (_error, callback) => {
        releaseDestroy = () => callback(failure);
        destroyStarted();
      };
    }
  }

  const reports = [];
  const callerErrors = [];
  let closeDelivered = false;
  duplex.on("close", () => { closeDelivered = true; });
  if (schedule === "caller-listeners") {
    duplex.on("error", (error) => callerErrors.push(error));
    duplex.on("close", () => {});
    duplex.on("drain", () => {});
    websocket.on("close", () => {});
    websocket.on("error", () => {});
    websocket.on("drain", () => {});
  }
  const expectedDuplex = captureListeners(duplex, duplexEvents);
  const expectedWebSocket = captureListeners(websocket, websocketEvents);
  const alreadyDestroyed = schedule === "already-destroyed";
  if (alreadyDestroyed && kind !== "silent-duplex") {
    duplex.destroy(failure);
    assert.equal(duplex.destroyed, true);
    assert.equal(closeDelivered, false, "must exercise the interval before close delivery");
  }

  try {
    const bridge = bridgeWebSocketToDuplex(websocket, duplex, {
      label: scenario,
      closeTimeoutMs: schedule === "close-first" ? 100 : schedule === "timeout" ? 5 : 0,
      onError(error, context) {
        reports.push({ error, context });
        if (schedule === "observer-throws") throw new Error("caller observer throws");
      },
    });
    let expectsError = true;
    if (kind === "async-destroy" || schedule === "async-error") {
      if (schedule === "websocket") websocket.close();
      else bridge.close();
      if (schedule === "timeout") {
        assert.equal(duplex.destroyed, false, "force-close grace period was bypassed");
      }
      await started;
      // The destruction callback is deliberately later than destroy() returning.
      await immediate();
      releaseDestroy();
    } else if (kind === "sync-duplex") {
      if (schedule === "error") duplex.emit("error", failure);
      else { expectsError = false; bridge.close(); }
    } else if (kind === "silent-duplex") {
      expectsError = false;
    } else if (kind === "emit-close-false") {
      expectsError = schedule === "error";
      duplex.destroy(expectsError ? failure : undefined);
      bridge.close();
    } else if (!alreadyDestroyed) {
      if (schedule === "close-first") bridge.close();
      duplex.destroy(failure);
      assert.equal(duplex.destroyed, true);
      if (schedule === "queued-websocket") websocket.close();
      else if (schedule !== "error-only" && schedule !== "close-first") bridge.close();
    }

    // Error-only closes when Node delivers its queued error, not synchronously.
    await immediate();
    await waitForCleanup(websocket, duplex, expectedWebSocket, expectedDuplex);
    assert.equal(bridge.closed, true);
    assert.equal(websocket.closed, true);
    assert.equal(websocket.closeCount, 1);
    assert.equal(websocket.binaryHandler, null);
    assert.equal(duplex.destroyed, true);
    assert.deepEqual(reports, expectsError ? [{ error: failure, context: { label: scenario, side: "duplex" } }] : [],
      "native errors must be reported exactly once, including their original identity");
    assert.deepEqual(callerErrors, schedule === "caller-listeners" ? [failure] : []);
    assert.equal(bridge.close(), false, "closure remains idempotent after terminal delivery");
  } finally {
    await cleanup();
  }
}

// Keep a controlled pending _destroy or an unref'ed force-close deadline alive
// until the assertions finish; clear this watchdog before checking natural exit.
const watchdog = nativeSetTimeout(() => { throw new Error(`scenario stalled: ${scenario}`); }, 8_000);
try {
  await run();
  console.log(JSON.stringify({ scenario, passed: true }));
} finally {
  nativeClearTimeout(watchdog);
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
}
