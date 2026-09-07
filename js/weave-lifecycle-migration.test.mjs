import assert from "node:assert/strict";
import test from "node:test";

import {
  FT,
  SourceMigration,
  WeaveInstance,
  acceptMigration,
} from "./weave.mjs";
import { lifecycleWasm } from "./test-support/lifecycle-fixture.mjs";

const TEST_OPTIONS = { timeout: 5_000 };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// A real byte-stream boundary: reads may span writes, pending readers remain
// FIFO, and a simulated disconnect rejects every outstanding read.
class MemoryEndpoint {
  constructor() {
    this.bytes = new Uint8Array();
    this.readers = [];
    this.writes = [];
    this.error = null;
    this.beforeWrite = null;
    this.afterWrite = null;
  }

  readExact(length) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.readers.push({ length, resolve, reject });
      this.pump();
    });
  }

  receive(bytes) {
    if (this.error) return;
    const joined = new Uint8Array(this.bytes.length + bytes.length);
    joined.set(this.bytes);
    joined.set(bytes, this.bytes.length);
    this.bytes = joined;
    this.pump();
  }

  pump() {
    while (this.readers.length && this.bytes.length >= this.readers[0].length) {
      const reader = this.readers.shift();
      const bytes = this.bytes.slice(0, reader.length);
      this.bytes = this.bytes.slice(reader.length);
      reader.resolve(bytes);
    }
  }

  async write(bytes) {
    if (this.error) throw this.error;
    const copy = bytes.slice();
    this.writes.push(copy);
    await this.beforeWrite?.(copy);
    if (this.error) throw this.error;
    this.peer.receive(copy);
    await this.afterWrite?.(copy);
  }

  close(error = new Error("test stream closed")) {
    this.error ??= error;
    for (const reader of this.readers.splice(0)) reader.reject(this.error);
  }
}

function transportPair(t) {
  const source = new MemoryEndpoint();
  const target = new MemoryEndpoint();
  source.peer = target;
  target.peer = source;
  t.after(() => { source.close(); target.close(); });
  return { source, target };
}

function serviceSet(events = { initialized: 0, ticks: [] }, restoreOverride) {
  let count = 0;
  let sum = 0;
  const service = {
    imports: {
      host: {
        initialized() { events.initialized++; },
        tick(value) { events.ticks.push(value); count++; sum += value; },
      },
    },
    snapshot() {
      const bytes = new Uint8Array(8);
      const view = new DataView(bytes.buffer);
      view.setUint32(0, count, true);
      view.setUint32(4, sum, true);
      return bytes;
    },
    restore(bytes) {
      if (restoreOverride) return restoreOverride(bytes);
      assert.equal(bytes.length, 8);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      count = view.getUint32(0, true);
      sum = view.getUint32(4, true);
    },
  };
  return new Map([["lifecycle.host.v1", service]]);
}

async function heldSource(events) {
  const instance = new WeaveInstance(lifecycleWasm(), serviceSet(events));
  await instance.instantiate();
  instance.init();
  instance.pollMode = { afterPolls: 3 };
  assert.deepEqual(await instance.drive("run", [8], () => "hold"), { status: "held" });
  instance.pollMode = "run";
  return instance;
}

function receiving(target, makeServices) {
  const acceptance = acceptMigration(target, makeServices, {
    targetReadTimeoutMs: 1_000,
    targetSessionTimeoutMs: 3_000,
    commitAckWriteTimeoutMs: 100,
  });
  // A target rejection can occur while the source is awaiting its ABORT.
  // Observe it immediately, while retaining the original promise for assertions.
  void acceptance.catch(() => {});
  return acceptance;
}

async function prepareMigration(source, instance) {
  const migration = new SourceMigration(source, instance, "lifecycle-source", {
    budgetBytes: 1 << 20,
    dirtyPageThreshold: 1_000,
    maxRounds: 1,
    readTimeoutMs: 1_000,
    commitTimeoutMs: 1_000,
  });
  await migration.handshake();
  assert.equal(await migration.precopyStep(), true);
  return migration;
}

async function assertCompleted(instance) {
  const outcome = await instance.drive(null, null);
  assert.deepEqual(outcome, { status: "done", results: [36] });
  assert.equal(instance.lifecycle, "completed");
}

test("final-copy ownership is reserved before the first write can resolve", TEST_OPTIONS, async (t) => {
  const instance = await heldSource();
  const { source, target } = transportPair(t);
  const acceptance = receiving(target, () => serviceSet());
  const migration = await prepareMigration(source, instance);
  const entered = deferred();
  const release = deferred();
  source.beforeWrite = async (bytes) => {
    if (bytes[0] === FT.FINAL_BEGIN) {
      entered.resolve();
      await release.promise;
    }
  };
  const finishing = migration.finish();
  void finishing.catch(() => {});
  try {
    assert.equal(instance.lifecycle, "finalizing", "reserve before finish() first awaits");
    await entered.promise;
    await assert.rejects(migration.finish(), /finish|finaliz|progress|busy|state|phase/i);
    await assert.rejects(instance.drive(null, null), /finaliz|progress|busy|state|paused/i);
    assert.equal(source.writes.filter((bytes) => bytes[0] === FT.FINAL_BEGIN).length, 1);
  } finally {
    release.resolve();
  }
  assert.equal((await finishing).commitConfirmed, true);
  assert.equal(instance.lifecycle, "retired");
  await acceptance;
});

test("pre-PREPARED service rejection leaves the source paused and resumable", TEST_OPTIONS, async (t) => {
  const events = { initialized: 0, ticks: [] };
  const instance = await heldSource(events);
  const { source, target } = transportPair(t);
  const acceptance = receiving(target, () => serviceSet(undefined, () => {
    throw new Error("deliberate service restore rejection");
  }));
  const migration = await prepareMigration(source, instance);
  await assert.rejects(migration.finish(), /deliberate service restore rejection/);
  await assert.rejects(acceptance, /deliberate service restore rejection/);
  assert.equal(instance.lifecycle, "paused");
  assert.ok(!target.writes.some((bytes) => bytes[0] === FT.PREPARED));
  assert.ok(!source.writes.some((bytes) => bytes[0] === FT.COMMIT));
  await assertCompleted(instance);
  assert.equal(events.initialized, 1);
  assert.deepEqual(events.ticks, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("verified targets stay staged until COMMIT while the source is already retired", TEST_OPTIONS, async (t) => {
  const sourceEvents = { initialized: 0, ticks: [] };
  const targetEvents = { initialized: 0, ticks: [] };
  const instance = await heldSource(sourceEvents);
  const { source, target } = transportPair(t);
  let staged;
  const originalInstantiate = WeaveInstance.prototype.instantiate;
  t.mock.method(WeaveInstance.prototype, "instantiate", async function (...args) {
    const result = await originalInstantiate.apply(this, args);
    staged = this;
    return result;
  });
  const acceptance = receiving(target, () => serviceSet(targetEvents));
  let accepted = false;
  void acceptance.then(() => { accepted = true; }, () => {});
  const migration = await prepareMigration(source, instance);
  const beforeCommit = deferred();
  const releaseCommit = deferred();
  source.beforeWrite = async (bytes) => {
    if (bytes[0] === FT.COMMIT) {
      beforeCommit.resolve();
      await releaseCommit.promise;
    }
  };
  const finishing = migration.finish();
  void finishing.catch(() => {});
  try {
    await beforeCommit.promise;
    assert.equal(instance.lifecycle, "retired");
    assert.equal(staged.lifecycle, "staged");
    assert.equal(accepted, false);
    await assert.rejects(instance.drive(null, null), /retired/);
    await assert.rejects(staged.drive(null, null), /staged|paused|state/i);
    await assert.rejects(staged.drive("run", [8]), /staged|ready|state/i);
    assert.throws(() => staged.init(), /staged|uninitialized|state/i);
    assert.equal(targetEvents.initialized, 0, "a restore target must not run guest startup");
    assert.deepEqual(targetEvents.ticks, [], "a staged target must not execute guest work");
  } finally {
    releaseCommit.resolve();
  }
  assert.equal((await finishing).commitConfirmed, true);
  const { inst: received } = await acceptance;
  assert.equal(received, staged);
  assert.equal(received.lifecycle, "paused");
  await assertCompleted(received);
  assert.deepEqual([...sourceEvents.ticks, ...targetEvents.ticks], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(targetEvents.initialized, 0);
  await assert.rejects(instance.drive("run", [8]), /retired/);
});

for (const failure of ["COMMIT acknowledgement", "delivered COMMIT write"]) {
  test(`source retirement is irreversible after an uncertain ${failure}`, TEST_OPTIONS, async (t) => {
    const instance = await heldSource();
    const { source, target } = transportPair(t);
    const acceptance = receiving(target, () => serviceSet());
    const migration = await prepareMigration(source, instance);
    const error = new Error(`lost ${failure}`);
    if (failure === "COMMIT acknowledgement") {
      target.beforeWrite = (bytes) => {
        if (bytes[0] === FT.COMMIT_OK) {
          source.close(error);
          throw error;
        }
      };
    } else {
      source.afterWrite = (bytes) => {
        if (bytes[0] === FT.COMMIT) throw error;
      };
    }
    const stats = await migration.finish();
    assert.equal(stats.commitConfirmed, false);
    assert.match(stats.commitError, /lost/);
    assert.equal(instance.lifecycle, "retired");
    await assert.rejects(instance.drive(null, null), /retired/);
    await assert.rejects(instance.drive("run", [8]), /retired/);
    assert.throws(() => instance.init(), /retired/);
    const { inst: received } = await acceptance;
    assert.equal(received.lifecycle, "paused");
    await assertCompleted(received);
  });
}

for (const rejects of [false, true]) {
  test(`${rejects ? "Rejected" : "Resolved"} Promise-returning service restore is rejected before PREPARED`, TEST_OPTIONS, async (t) => {
    const instance = await heldSource();
    const { source, target } = transportPair(t);
    const acceptance = receiving(target, () => serviceSet(undefined, () => rejects
      ? Promise.reject(new Error("late asynchronous service failure"))
      : Promise.resolve()));
    const migration = await prepareMigration(source, instance);
    await assert.rejects(migration.finish(), /sync|promise|async/i);
    await assert.rejects(acceptance, /sync|promise|async/i);
    assert.ok(!target.writes.some((bytes) => bytes[0] === FT.PREPARED));
    assert.equal(instance.lifecycle, "paused");
    await assertCompleted(instance);
  });
}

test("onYield may handshake and precopy, but cannot finish while its drive still owns the guest", TEST_OPTIONS, async (t) => {
  const instance = new WeaveInstance(lifecycleWasm(), serviceSet());
  await instance.instantiate();
  instance.init();
  instance.pollMode = { afterPolls: 3 };
  const { source, target } = transportPair(t);
  const acceptance = receiving(target, () => serviceSet());
  let migration;
  const outcome = await instance.drive("run", [8], async (yielded) => {
    assert.equal(yielded, instance);
    assert.equal(instance.lifecycle, "paused");
    migration = await prepareMigration(source, instance);
    await assert.rejects(migration.finish(), /drive|progress|state/i);
    await assert.rejects(instance.drive(null, null), /drive|progress|state/i);
    assert.ok(!source.writes.some((bytes) => bytes[0] === FT.FINAL_BEGIN));
    return "hold";
  });
  assert.deepEqual(outcome, { status: "held" });
  assert.equal((await migration.finish()).commitConfirmed, true);
  assert.equal(instance.lifecycle, "retired");
  const { inst: received } = await acceptance;
  await assertCompleted(received);
});

test("checkpoint service snapshots cannot reenter the paused guest", TEST_OPTIONS, async () => {
  const instance = await heldSource();
  const service = instance.services.get("lifecycle.host.v1");
  const originalSnapshot = service.snapshot;
  let resumeAttempt;
  service.snapshot = () => {
    resumeAttempt = instance.drive(null, null);
    void resumeAttempt.catch(() => {});
    return originalSnapshot();
  };
  const snapshot = instance.checkpoint();
  await assert.rejects(resumeAttempt, /checkpoint|snapshot|progress|busy|state/i);
  assert.equal(instance.lifecycle, "paused");
  service.snapshot = originalSnapshot;
  const target = new WeaveInstance(lifecycleWasm(), serviceSet());
  await target.instantiate();
  target.restore(snapshot);
  await assertCompleted(target);
  await assertCompleted(instance);
});

test("standalone service restoration cannot reenter guest initialization", TEST_OPTIONS, async () => {
  const events = { initialized: 0, ticks: [] };
  let instance;
  const services = serviceSet(events, () => instance.init());
  instance = new WeaveInstance(lifecycleWasm(), services);
  await instance.instantiate();
  assert.throws(
    () => instance.restoreServices([["lifecycle.host.v1", new Uint8Array(8)]]),
    /restor|progress|busy|state/i,
  );
  assert.equal(events.initialized, 0);
  assert.equal(instance.lifecycle, "failed");
});

test("migration rejects asynchronous snapshots before writing service state", TEST_OPTIONS, async (t) => {
  const instance = await heldSource();
  const { source, target } = transportPair(t);
  const acceptance = receiving(target, () => serviceSet());
  const migration = await prepareMigration(source, instance);
  const rejected = Promise.reject(new Error("asynchronous snapshot failed"));
  // Keep a pre-fix contract failure local to this test rather than producing
  // an unrelated process-wide unhandled rejection after the assertion fails.
  void rejected.catch(() => {});
  const service = instance.services.get("lifecycle.host.v1");
  const originalSnapshot = service.snapshot;
  service.snapshot = () => rejected;
  try {
    await assert.rejects(migration.finish(), /snapshot.*synchronous|synchronous.*snapshot/i);
    assert.ok(!source.writes.some((bytes) => bytes[0] === FT.SERVICES));
    assert.equal(instance.lifecycle, "paused");
  } finally {
    service.snapshot = originalSnapshot;
    source.close();
    target.close();
  }
  await assert.rejects(acceptance, /test stream closed/);
  await assertCompleted(instance);
});
