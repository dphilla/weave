import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WeaveInstance } from "./weave.mjs";
import { lifecycleWasm } from "./test-support/lifecycle-fixture.mjs";

const invalidState = { code: "WEAVE_INVALID_STATE" };
const aborted = { name: "AbortError", code: "WEAVE_ABORTED" };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ opts, onTick, onInit } = {}) {
  const events = [];
  let initializations = 0;
  const services = new Map([["host", {
    imports: { host: {
      initialized() { initializations++; onInit?.(); },
      tick(value) { events.push(value); onTick?.(value); },
    } },
    snapshot: () => new Uint8Array(),
    restore() {},
  }]]);
  const instance = new WeaveInstance(lifecycleWasm(), services, opts);
  return { instance, events, services, get initializations() { return initializations; } };
}

async function ready(options) {
  const f = fixture(options);
  await f.instance.instantiate();
  f.instance.init();
  return f;
}

async function hold(instance, count = 30) {
  instance.pollMode = { afterPolls: 3 };
  assert.deepEqual(await instance.drive("run", [count], () => "hold"), { status: "held" });
  assert.equal(instance.lifecycle, "paused");
}

function exactEvents(events, count) {
  assert.deepEqual(events, Array.from({ length: count }, (_, index) => index + 1));
}

test("public lifecycle covers construction, initialization, completion, and a new invocation", async () => {
  const f = fixture();
  assert.equal(f.instance.lifecycle, "created");
  const instantiating = f.instance.instantiate();
  assert.equal(f.instance.lifecycle, "instantiating");
  assert.equal(await instantiating, f.instance);
  assert.equal(f.instance.lifecycle, "uninitialized");
  assert.equal(f.initializations, 0, "instantiation does not run the relocated guest start");
  f.instance.init();
  assert.equal(f.instance.lifecycle, "ready");
  assert.equal(f.initializations, 1);
  assert.deepEqual(await f.instance.drive("run", [3]), { status: "done", results: [6] });
  assert.equal(f.instance.lifecycle, "completed");
  assert.deepEqual(await f.instance.drive("run", [2]), { status: "done", results: [3] });
  assert.deepEqual(f.events, [1, 2, 3, 1, 2]);
  assert.equal(f.initializations, 1);
});

for (const asBuffer of [false, true]) {
  test(`constructor owns ${asBuffer ? "Node Buffer" : "Uint8Array"} module bytes and service membership`, async () => {
    const f = fixture();
    const bytes = asBuffer ? Buffer.from(lifecycleWasm()) : lifecycleWasm();
    const instance = new WeaveInstance(bytes, f.services);
    bytes.fill(0);
    f.services.clear();
    await instance.instantiate();
    instance.init();
    assert.deepEqual(await instance.drive("run", [3]), { status: "done", results: [6] });
    exactEvents(f.events, 3);
  });
}

test("instantiate reserves its operation before awaiting compilation and never replaces a live guest", async () => {
  const { instance } = fixture();
  const first = instance.instantiate();
  await assert.rejects(instance.instantiate(), invalidState);
  assert.throws(() => instance.init(), invalidState);
  await assert.rejects(instance.drive("run", [1]), invalidState);
  await first;
  const original = instance.instance;
  await assert.rejects(instance.instantiate(), invalidState);
  assert.equal(instance.instance, original);
});

test("failed instantiation releases its reservation for a retry", async (t) => {
  const { instance } = fixture();
  const failure = new Error("test compilation failure");
  const mocked = t.mock.method(WebAssembly, "instantiate", async () => { throw failure; });
  await assert.rejects(instance.instantiate(), (error) => error === failure);
  assert.equal(instance.lifecycle, "created");
  mocked.mock.restore();
  await instance.instantiate();
  instance.init();
  assert.deepEqual(await instance.drive("run", [1]), { status: "done", results: [1] });
});

test("init and drive reject calls before instantiation or initialization", async () => {
  const f = fixture();
  assert.throws(() => f.instance.init(), invalidState);
  await assert.rejects(f.instance.drive("run", [2]), invalidState);
  await f.instance.instantiate();
  await assert.rejects(f.instance.drive("run", [2]), invalidState);
  await assert.rejects(f.instance.drive(null, []), invalidState);
  assert.deepEqual(f.events, []);
  assert.equal(f.initializations, 0);
});

test("init is not repeatable or reentrant and publishes initializing during guest start", async () => {
  let instance;
  const f = fixture({ onInit() {
    assert.equal(instance.lifecycle, "initializing");
    assert.throws(() => instance.init(), invalidState);
  } });
  instance = f.instance;
  await instance.instantiate();
  instance.init();
  assert.throws(() => instance.init(), invalidState);
  assert.equal(f.initializations, 1);
  assert.equal(instance.lifecycle, "ready");
});

test("initialization failure is terminal and cannot execute partial host effects twice", async () => {
  const failure = new Error("host initialization failed");
  const f = fixture({ onInit() { throw failure; } });
  await f.instance.instantiate();
  assert.throws(() => f.instance.init(), (error) => error === failure);
  assert.equal(f.instance.lifecycle, "failed");
  assert.throws(() => f.instance.init(), invalidState);
  await assert.rejects(f.instance.drive("run", [1]), invalidState);
  await assert.rejects(f.instance.instantiate(), invalidState);
  assert.equal(f.initializations, 1);
});

test("resume requires a paused continuation, not a ready or completed guest", async () => {
  const { instance } = await ready();
  await assert.rejects(instance.drive(null, []), invalidState);
  await instance.drive("run", [1]);
  await assert.rejects(instance.drive(null, []), invalidState);
  assert.equal(instance.lifecycle, "completed");
});

test("held continuation cannot be overwritten by another entry and resumes exactly once", async () => {
  const { instance, events } = await ready();
  await hold(instance);
  const state = instance.captureGlobals();
  await assert.rejects(instance.drive("run", [99]), invalidState);
  assert.throws(() => instance.init(), invalidState);
  await assert.rejects(instance.instantiate(), invalidState);
  assert.deepEqual(instance.captureGlobals(), state);
  instance.pollMode = "run";
  assert.deepEqual(await instance.drive(null, []), { status: "done", results: [465] });
  exactEvents(events, 30);
});

test("lifecycle is read-only and cannot be fooled by caller-writable Wasm state globals", async () => {
  const { instance, events } = await ready();
  await hold(instance, 6);
  assert.throws(() => { instance.lifecycle = "ready"; }, TypeError);
  const oldFlag = instance.g("__weave_flag");
  instance.setG("__weave_flag", 0);
  await assert.rejects(instance.drive("run", [100]), invalidState);
  assert.equal(instance.lifecycle, "paused");
  instance.setG("__weave_flag", oldFlag);
  instance.pollMode = "run";
  assert.deepEqual(await instance.drive(null, []), { status: "done", results: [21] });
  exactEvents(events, 6);
});

test("one driver owns a paused callback; competing start and resume both reject", async () => {
  const { instance, events } = await ready();
  const entered = deferred();
  const release = deferred();
  instance.pollMode = { afterPolls: 2 };
  const first = instance.drive("run", [20], async () => {
    assert.equal(instance.lifecycle, "paused");
    entered.resolve();
    return release.promise;
  });
  await entered.promise;
  try {
    const state = instance.captureGlobals();
    await assert.rejects(instance.drive(null, []), invalidState);
    await assert.rejects(instance.drive("run", [100]), invalidState);
    assert.throws(() => instance.init(), invalidState);
    assert.deepEqual(instance.captureGlobals(), state);
  } finally {
    release.resolve("hold");
  }
  assert.deepEqual(await first, { status: "held" });
  instance.pollMode = "run";
  assert.deepEqual(await instance.drive(null, null), { status: "done", results: [210] });
  exactEvents(events, 20);
});

test("guest-visible running lifecycle rejects reentrant drive from a host import", async () => {
  const attempts = [];
  let instance;
  const f = await ready({ onTick(value) {
    assert.equal(instance.lifecycle, "running");
    if (value === 1) attempts.push(assert.rejects(instance.drive("run", [10]), invalidState));
  } });
  instance = f.instance;
  assert.deepEqual(await instance.drive("run", [3]), { status: "done", results: [6] });
  await Promise.all(attempts);
  exactEvents(f.events, 3);
});

test("entry name, arity, and scalar validation rejects mistakes without guest effects", async () => {
  const { instance, events } = await ready();
  const cases = [
    ["missing", []], ["__weave_init", []], ["__weave_resume", []],
    ["run", []], ["run", [1, 2]], ["run", ["3"]], ["run", [3n]],
    ["run", [1.5]], ["run", [2147483648]], ["run", [-2147483649]],
    ["typed", [1, 9223372036854775808n, 3, 4]],
    ["run", {}], ["typed", [1, 2, 3, 4]], ["typed", [1, 2n, "3", 4]],
  ];
  for (const [entry, args] of cases) {
    await assert.rejects(instance.drive(entry, args), { name: "TypeError" });
    assert.equal(instance.lifecycle, "ready");
    assert.deepEqual(events, []);
  }
  assert.deepEqual(await instance.drive("typed", [1, 2n, NaN, -0]), {
    status: "done", results: [2n],
  });
});

test("invalid resume arguments preserve a held continuation", async () => {
  const { instance, events } = await ready();
  await hold(instance, 9);
  const state = instance.captureGlobals();
  await assert.rejects(instance.drive(null, [1]), { name: "TypeError" });
  assert.equal(instance.lifecycle, "paused");
  assert.deepEqual(instance.captureGlobals(), state);
  instance.pollMode = "run";
  assert.deepEqual(await instance.drive(null, []), { status: "done", results: [45] });
  exactEvents(events, 9);
});

test("a guest trap makes the instance failed rather than offering an invalid resume", async () => {
  const { instance } = await ready();
  await assert.rejects(instance.drive("fail", []), WebAssembly.RuntimeError);
  assert.equal(instance.lifecycle, "failed");
  await assert.rejects(instance.drive(null, []), invalidState);
  await assert.rejects(instance.drive("run", [1]), invalidState);
});

test("a host import exception makes the partially executed guest failed", async () => {
  const failure = new Error("host tick failed");
  const { instance, events } = await ready({ onTick(value) { if (value === 2) throw failure; } });
  await assert.rejects(instance.drive("run", [4]), (error) => error === failure);
  assert.equal(instance.lifecycle, "failed");
  await assert.rejects(instance.drive(null, []), invalidState);
  assert.deepEqual(events, [1, 2]);
});

for (const mode of ["resolved promise", "rejected promise", "rejecting thenable"]) {
  test(`async host import returning a ${mode} fails safely without an unhandled rejection`, async () => {
    const f = fixture();
    const failure = new Error("asynchronous host import failed");
    const unhandled = [];
    const observe = (error) => { unhandled.push(error); };
    process.on("unhandledRejection", observe);
    f.services.get("host").imports.host.tick = (value) => {
      f.events.push(value);
      if (mode === "resolved promise") return Promise.resolve();
      if (mode === "rejected promise") return Promise.reject(failure);
      return { then(_resolve, reject) { reject(failure); } };
    };
    try {
      await f.instance.instantiate();
      f.instance.init();
      await assert.rejects(f.instance.drive("run", [4]), {
        name: "TypeError", message: /host\.tick.*synchronous/,
      });
      assert.equal(f.instance.lifecycle, "failed");
      await assert.rejects(f.instance.drive(null, []), invalidState);
      await assert.rejects(f.instance.drive("run", [1]), invalidState);
      assert.deepEqual(f.events, [1], "execution stops at the first asynchronous import");
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, [], "rejected host promises must be observed by the wrapper");
    } finally {
      process.off("unhandledRejection", observe);
    }
  });
}

test("an async guest initialization import cannot make initialization appear complete", async () => {
  const f = fixture();
  let calls = 0;
  f.services.get("host").imports.host.initialized = async () => {
    calls++;
    throw new Error("initialization import rejected");
  };
  await f.instance.instantiate();
  assert.throws(() => f.instance.init(), { name: "TypeError", message: /host\.initialized.*synchronous/ });
  assert.equal(f.instance.lifecycle, "failed");
  assert.throws(() => f.instance.init(), invalidState);
  await assert.rejects(f.instance.drive("run", [1]), invalidState);
  assert.equal(calls, 1);
  assert.deepEqual(f.events, []);
  // node:test also fails on any unhandled rejection; flush it before finishing.
  await new Promise((resolve) => setImmediate(resolve));
});

for (const verdict of [undefined, null, "typo", 17]) {
  test(`invalid onYield verdict ${String(verdict)} leaves a resumable continuation`, async () => {
    const { instance, events } = await ready();
    instance.pollMode = { afterPolls: 2 };
    await assert.rejects(instance.drive("run", [8], () => verdict), { name: "TypeError" });
    assert.equal(instance.lifecycle, "paused");
    instance.pollMode = "run";
    assert.deepEqual(await instance.drive(null, []), { status: "done", results: [36] });
    exactEvents(events, 8);
  });
}

test("a rejected onYield callback releases the driver while preserving exact progress", async () => {
  const { instance, events } = await ready();
  const failure = new Error("save/checkpoint callback failed");
  instance.pollMode = { afterPolls: 4 };
  await assert.rejects(instance.drive("run", [12], async () => { throw failure; }), (error) => error === failure);
  assert.equal(instance.lifecycle, "paused");
  instance.pollMode = "run";
  assert.deepEqual(await instance.drive(null, []), { status: "done", results: [78] });
  exactEvents(events, 12);
});

test("pre-aborted drive never starts or replaces guest state", async () => {
  const { instance, events } = await ready();
  const controller = new AbortController();
  controller.abort("do not start");
  await assert.rejects(instance.drive("run", [10], undefined, { signal: controller.signal }), aborted);
  assert.equal(instance.lifecycle, "ready");
  assert.deepEqual(events, []);
  await hold(instance, 10);
  const state = instance.captureGlobals();
  await assert.rejects(instance.drive(null, [], undefined, { signal: controller.signal }), aborted);
  assert.equal(instance.lifecycle, "paused");
  assert.deepEqual(instance.captureGlobals(), state);
  instance.pollMode = "run";
  assert.deepEqual(await instance.drive(null, []), { status: "done", results: [55] });
  exactEvents(events, 10);
});

test("abort from a synchronous host callback unwinds, then resumes without duplicate effects", async () => {
  const controller = new AbortController();
  const { instance, events } = await ready({ onTick(value) { if (value === 7) controller.abort("stop at seven"); } });
  await assert.rejects(instance.drive("run", [30], undefined, { signal: controller.signal }), aborted);
  assert.equal(instance.lifecycle, "paused");
  assert.ok(events.length >= 7 && events.length < 30);
  assert.deepEqual(await instance.drive(null, []), { status: "done", results: [465] });
  exactEvents(events, 30);
});

test("abort during onYield waits for callback ownership, passes its signal, and preserves continuation", async () => {
  const controller = new AbortController();
  const { instance, events } = await ready();
  const entered = deferred();
  const release = deferred();
  instance.pollMode = { afterPolls: 2 };
  let settled = false;
  const running = instance.drive("run", [10], async (actual, options) => {
    assert.equal(actual, instance);
    assert.equal(options.signal, controller.signal);
    entered.resolve();
    return release.promise;
  }, { signal: controller.signal });
  const rejection = assert.rejects(running, aborted).finally(() => { settled = true; });
  await entered.promise;
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    assert.equal(settled, false, "an unresolved callback cannot be forcibly abandoned safely");
    await assert.rejects(instance.drive(null, []), invalidState);
  } finally {
    release.resolve("continue");
  }
  await rejection;
  assert.equal(instance.lifecycle, "paused");
  instance.pollMode = "run";
  assert.deepEqual(await instance.drive(null, []), { status: "done", results: [55] });
  exactEvents(events, 10);
});

test("abort inside an onYield callback is honored before a requested hold returns", async () => {
  const controller = new AbortController();
  const { instance } = await ready();
  instance.pollMode = { afterPolls: 0 };
  await assert.rejects(instance.drive("run", [5], () => {
    controller.abort();
    return "hold";
  }, { signal: controller.signal }), aborted);
  assert.equal(instance.lifecycle, "paused");
  instance.pollMode = "run";
  assert.deepEqual(await instance.drive(null, []), { status: "done", results: [15] });
});

test("zero-length scheduling slices still advance the real continuation", async () => {
  const { instance, events } = await ready({ opts: { yieldMs: 0 } });
  assert.deepEqual(await instance.drive("run", [4]), { status: "done", results: [10] });
  exactEvents(events, 4);
});

test("abort during the built-in scheduling turn happens before a callback can publish effects", async () => {
  const controller = new AbortController();
  let callbackCalls = 0;
  const { instance, events } = await ready({ onTick(value) {
    if (value === 1) setTimeout(() => controller.abort(), 0);
  } });
  instance.pollMode = { afterPolls: 2 };
  await assert.rejects(instance.drive("run", [10], () => {
    callbackCalls++;
    return "hold";
  }, { signal: controller.signal }), aborted);
  assert.equal(callbackCalls, 0);
  assert.equal(instance.lifecycle, "paused");
  instance.pollMode = "run";
  assert.deepEqual(await instance.drive(null, []), { status: "done", results: [55] });
  exactEvents(events, 10);
});

test("invalid scheduling and driver options fail before execution", async () => {
  for (const yieldMs of [-1, NaN, Infinity, "1"]) {
    assert.throws(() => fixture({ opts: { yieldMs } }), { name: "RangeError" });
  }
  const { instance, events } = await ready();
  await assert.rejects(instance.drive("run", [5], "continue"), { name: "TypeError" });
  await assert.rejects(instance.drive("run", [5], undefined, { signal: {} }), { name: "TypeError" });
  assert.equal(instance.lifecycle, "ready");
  assert.deepEqual(events, []);
});

test("host services cannot replace weave.poll or silently collide on an import", async () => {
  for (const imports of [{ weave: { poll() {} } }, { host: { tick() {} } }]) {
    const f = fixture();
    f.services.set("conflicting", { imports });
    await assert.rejects(async () => {
      const instance = new WeaveInstance(lifecycleWasm(), f.services);
      await instance.instantiate();
    }, /(?:reserved|duplicate|conflict|already provided)/i);
    assert.equal(f.initializations, 0);
    assert.deepEqual(f.events, []);
  }
});

test("checkpoint requires a paused continuation and captures safely inside onYield", async () => {
  const { instance, events } = fixture();
  assert.throws(() => instance.checkpoint(), invalidState);
  await instance.instantiate();
  assert.throws(() => instance.checkpoint(), invalidState);
  instance.init();
  assert.throws(() => instance.checkpoint(), invalidState);
  instance.pollMode = { afterPolls: 3 };
  let captured;
  assert.deepEqual(await instance.drive("run", [7], (actual) => {
    captured = actual.checkpoint();
    return "hold";
  }), { status: "held" });
  const again = instance.checkpoint();
  assert.deepEqual(again, captured);
  assert.notEqual(again.memories[0], captured.memories[0]);
  const savedByte = captured.memories[0][0];
  again.memories[0][0] ^= 255;
  assert.equal(captured.memories[0][0], savedByte);
  assert.equal(instance.memBytes(0)[0], savedByte);
  captured.moduleHash.fill(0);
  assert.notDeepEqual(instance.moduleHash, captured.moduleHash);
  instance.pollMode = "run";
  await instance.drive(null, []);
  assert.throws(() => instance.checkpoint(), invalidState);
  exactEvents(events, 7);
});

test("fresh restore resumes the real guest without rerunning initialization", async () => {
  const source = await ready();
  await hold(source.instance, 40);
  const snapshot = source.instance.checkpoint();
  const target = fixture();
  await target.instance.instantiate();
  target.instance.restore(snapshot);
  assert.equal(target.instance.lifecycle, "paused");
  assert.equal(target.initializations, 0);
  assert.deepEqual(await target.instance.drive(null, []), { status: "done", results: [820] });
  exactEvents([...source.events, ...target.events], 40);
  assert.equal(source.instance.lifecycle, "paused", "offline snapshots copy state; they are not a live migration commit");
});

test("restore validates all snapshot fields before changing a fresh target", async () => {
  const { instance } = await ready();
  await hold(instance, 10);
  const original = instance.checkpoint();
  const corruptions = [
    (s) => { s.moduleHash[0] ^= 1; },
    (s) => { s.moduleHash = "not bytes"; },
    (s) => { s.memories = []; },
    (s) => { s.memories[0] = new Uint8Array(1); },
    (s) => { s.globals = []; },
    (s) => { s.globals[0][1] = 1.5; },
    (s) => { s.globals[1][0] = s.globals[0][0]; },
    (s) => { s.globals.find(([name]) => name === "__weave_flag")[1] = 0; },
    (s) => { s.globals.find(([name]) => name === "__weave_state")[1] = 0; },
    (s) => { s.globals.find(([name]) => name === "__weave_entry")[1] = -1; },
    (s) => { s.services = []; },
    (s) => { s.services[0][0] = "wrong service"; },
    (s) => { s.services[0][1] = "not bytes"; },
  ];
  for (const corrupt of corruptions) {
    const target = fixture();
    await target.instance.instantiate();
    const before = target.instance.memBytes(0).slice();
    const snapshot = structuredClone(original);
    corrupt(snapshot);
    assert.throws(() => target.instance.restore(snapshot));
    assert.equal(target.instance.lifecycle, "uninitialized");
    assert.deepEqual(target.instance.memBytes(0), before);
    assert.equal(target.initializations, 0);
    target.instance.restore(original);
    assert.equal(target.instance.lifecycle, "paused", "a rejected malformed snapshot does not poison an untouched target");
  }
});

test("restore refuses initialized, running, and already-paused targets without erasing progress", async () => {
  const source = await ready();
  await hold(source.instance, 9);
  const snapshot = source.instance.checkpoint();
  let target;
  const f = await ready({ onTick() { assert.throws(() => target.restore(snapshot), invalidState); } });
  target = f.instance;
  assert.throws(() => target.restore(snapshot), invalidState);
  await hold(target, 8);
  const before = target.checkpoint();
  assert.throws(() => target.restore(snapshot), invalidState);
  assert.deepEqual(target.checkpoint(), before);
  target.pollMode = "run";
  assert.deepEqual(await target.drive(null, []), { status: "done", results: [36] });
  exactEvents(f.events, 8);
});

test("restore owns input memory and service bytes so later caller mutation cannot alter the guest", async () => {
  const source = await ready();
  const originalServiceBytes = Buffer.from([12, 34, 56]);
  source.services.get("host").snapshot = () => originalServiceBytes;
  await hold(source.instance, 11);
  const snapshot = source.instance.checkpoint();
  originalServiceBytes.fill(0);
  assert.deepEqual([...snapshot.services[0][1]], [12, 34, 56]);
  snapshot.services[0][1] = Buffer.from(snapshot.services[0][1]);
  const target = fixture();
  let restoredServiceBytes;
  target.services.get("host").restore = (bytes) => { restoredServiceBytes = bytes; };
  await target.instance.instantiate();
  target.instance.restore(snapshot);
  for (const memory of snapshot.memories) memory.fill(255);
  snapshot.services[0][1].fill(255);
  snapshot.globals.forEach((entry) => { entry[1] = -1; });
  assert.deepEqual([...restoredServiceBytes], [12, 34, 56]);
  assert.deepEqual(await target.instance.drive(null, []), { status: "done", results: [66] });
  exactEvents([...source.events, ...target.events], 11);
});

test("checkpoint service failures and async implementations preserve a held continuation for retry", async () => {
  const f = await ready();
  await hold(f.instance, 12);
  const service = f.services.get("host");
  const original = service.snapshot;
  const failure = new Error("service snapshot failed");
  for (const snapshot of [() => { throw failure; }, async () => { throw failure; }, () => "wrong bytes"]) {
    service.snapshot = snapshot;
    assert.throws(() => f.instance.checkpoint());
    assert.equal(f.instance.lifecycle, "paused");
  }
  service.snapshot = original;
  assert.ok(f.instance.checkpoint().memories[0] instanceof Uint8Array);
  f.instance.pollMode = "run";
  assert.deepEqual(await f.instance.drive(null, []), { status: "done", results: [78] });
  exactEvents(f.events, 12);
});

test("checkpoint and restore service hooks cannot reenter lifecycle operations", async () => {
  const source = await ready();
  await hold(source.instance, 10);
  const attemptResults = [];
  source.services.get("host").snapshot = () => {
    assert.throws(() => source.instance.checkpoint(), invalidState);
    attemptResults.push(assert.rejects(source.instance.drive(null, []), invalidState));
    return new Uint8Array();
  };
  const snapshot = source.instance.checkpoint();
  await Promise.all(attemptResults);
  const target = fixture();
  target.services.get("host").restore = () => {
    assert.equal(target.instance.lifecycle, "staged");
    assert.throws(() => target.instance.init(), invalidState);
    assert.throws(() => target.instance.restore(snapshot), invalidState);
    assert.throws(() => target.instance.restoreServices(snapshot.services), invalidState);
    attemptResults.push(assert.rejects(target.instance.drive(null, []), invalidState));
  };
  await target.instance.instantiate();
  target.instance.restore(snapshot);
  await Promise.all(attemptResults);
  assert.deepEqual(await target.instance.drive(null, []), { status: "done", results: [55] });
  exactEvents([...source.events, ...target.events], 10);
});

test("restore service failures poison the target and never rerun initialization", async () => {
  const source = await ready();
  await hold(source.instance, 10);
  const snapshot = source.instance.checkpoint();
  for (const asynchronous of [false, true]) {
    const target = fixture();
    let calls = 0;
    const failure = new Error("portable service restore failed");
    target.services.get("host").restore = asynchronous
      ? async () => { calls++; throw failure; }
      : () => { calls++; throw failure; };
    await target.instance.instantiate();
    assert.throws(() => target.instance.restore(snapshot), asynchronous ? /synchronous/ : (error) => error === failure);
    assert.equal(target.instance.lifecycle, "failed");
    assert.throws(() => target.instance.restore(snapshot), invalidState);
    assert.throws(() => target.instance.init(), invalidState);
    await assert.rejects(target.instance.drive(null, []), invalidState);
    assert.equal(calls, 1);
    assert.equal(target.initializations, 0);
    assert.deepEqual(target.events, []);
  }
});

test("repeated fresh-instance checkpoint restores preserve portable host state and exact side effects", async () => {
  const allEvents = [];
  let initializations = 0;
  function stateful() {
    let counter = 0;
    return new WeaveInstance(lifecycleWasm(), new Map([["host", {
      imports: { host: {
        initialized() { initializations++; },
        tick(value) {
          assert.equal(value, counter + 1);
          counter++;
          allEvents.push(value);
        },
      } },
      snapshot() {
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, counter, true);
        return bytes;
      },
      restore(bytes) { counter = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true); },
    }]]));
  }
  let current = stateful();
  await current.instantiate();
  current.init();
  current.pollMode = { afterPolls: 5 };
  assert.deepEqual(await current.drive("run", [100], () => "hold"), { status: "held" });
  for (let index = 0; index < 20; index++) {
    const snapshot = current.checkpoint();
    const next = stateful();
    await next.instantiate();
    next.restore(snapshot);
    next.pollMode = { afterPolls: 2 };
    assert.deepEqual(await next.drive(null, [], () => "hold"), { status: "held" });
    current = next;
  }
  current.pollMode = "run";
  assert.deepEqual(await current.drive(null, []), { status: "done", results: [5050] });
  assert.equal(initializations, 1);
  exactEvents(allEvents, 100);
});

function childProbe(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./test-support/lifecycle-child.mjs", import.meta.url)), mode], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 5000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${mode} starved timers or failed to cancel within 5 seconds; child was killed\n${output}`));
      else if (code !== 0) reject(new Error(`${mode} child exited ${code}/${signal}\n${output}`));
      else resolve(output);
    });
  });
}

for (const mode of ["no-callback", "immediate-callback", "abort-timer"]) {
  test(`real guest remains timer-responsive with ${mode}`, async () => {
    assert.match(await childProbe(mode), new RegExp(`PASS ${mode}`));
  });
}
