import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SourceMigration, WeaveInstance, acceptMigration } from "../../js/weave.mjs";
import { loadPiWasm, verifyPiFixtureSource } from "./test-fixture.mjs";

const OPTIONS = { timeout: 15_000 };
const REPORT_TERMS = 32768n;
let bytes;

function wasm() {
  return bytes ??= loadPiWasm();
}

function fixture(events = []) {
  const result = { events, instance: null, stopAt: Infinity, restores: 0, lastTerms: 0n, lastEstimate: 0, sequence: 0n };
  result.services = new Map([["demo.pi.progress.v1", {
    imports: { demo: { progress(terms, estimate) {
      assert.equal(typeof terms, "bigint", "the progress counter comes from a Wasm i64");
      assert.equal(terms, result.lastTerms + REPORT_TERMS, "no repeated or missing host effects");
      assert.ok(Number.isFinite(estimate));
      assert.ok(estimate > result.lastEstimate);
      result.lastTerms = terms;
      result.lastEstimate = estimate;
      result.sequence++;
      assert.equal(result.sequence * REPORT_TERMS, terms, "portable host sequence agrees with guest progress");
      events.push([terms, estimate]);
      if (events.length >= result.stopAt) result.instance.pollMode = "unwind";
    } } },
    snapshot() {
      const state = new Uint8Array(24);
      const view = new DataView(state.buffer);
      view.setBigUint64(0, result.lastTerms, true);
      view.setFloat64(8, result.lastEstimate, true);
      view.setBigUint64(16, result.sequence, true);
      return state;
    },
    restore(state) {
      assert.equal(state.length, 24);
      const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
      result.lastTerms = view.getBigUint64(0, true);
      result.lastEstimate = view.getFloat64(8, true);
      result.sequence = view.getBigUint64(16, true);
      result.restores++;
    },
  }]]);
  return result;
}

async function fresh(events) {
  const result = fixture(events);
  result.instance = new WeaveInstance(wasm(), result.services, { yieldMs: 10 });
  await result.instance.instantiate();
  result.instance.init();
  return result;
}

async function runTo(result, records, entry = null) {
  result.stopAt = records;
  result.instance.pollMode = "run";
  assert.deepEqual(await result.instance.drive(entry, entry === null ? null : [],
    () => result.events.length >= records ? "hold" : "continue"), { status: "held" });
  assert.equal(result.events.length, records);
  assert.equal(result.instance.lifecycle, "paused");
}

function doubleBits(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return Buffer.from(bytes).toString("hex");
}

function exactEvents(actual, expected) {
  assert.deepEqual(actual.map(([terms, estimate]) => [terms, doubleBits(estimate)]),
    expected.map(([terms, estimate]) => [terms, doubleBits(estimate)]));
}

// A queued byte stream exercises the public migration protocol, including
// deliberately fragmented writes, rather than passing a checkpoint object.
class Endpoint {
  constructor() {
    this.buffer = new Uint8Array();
    this.readers = [];
    this.error = null;
    this.bytesWritten = 0;
  }

  readExact(length) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.readers.push({ length, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.readers.length && this.buffer.length >= this.readers[0].length) {
      const reader = this.readers.shift();
      const result = this.buffer.slice(0, reader.length);
      this.buffer = this.buffer.slice(reader.length);
      reader.resolve(result);
    }
  }

  receive(bytes) {
    if (this.error) throw this.error;
    const buffer = new Uint8Array(this.buffer.length + bytes.length);
    buffer.set(this.buffer);
    buffer.set(bytes, this.buffer.length);
    this.buffer = buffer;
    this.pump();
  }

  async write(bytes) {
    if (this.error) throw this.error;
    this.bytesWritten += bytes.length;
    for (let offset = 0; offset < bytes.length; offset += 997) {
      this.peer.receive(bytes.slice(offset, offset + 997));
    }
  }

  close() {
    this.error ??= new Error("pi test transport closed");
    for (const reader of this.readers.splice(0)) reader.reject(this.error);
  }
}

function transportPair(t) {
  const source = new Endpoint();
  const target = new Endpoint();
  source.peer = target;
  target.peer = source;
  t.after(() => { source.close(); target.close(); });
  return { source, target };
}

test("JavaScript-only Pi fixture is source-hash guarded and returned bytes are caller-owned", () => {
  const source = readFileSync(new URL("./pi.wat", import.meta.url));
  assert.equal(verifyPiFixtureSource(source), true);
  assert.throws(() => verifyPiFixtureSource(Buffer.concat([source, Buffer.from("\n;; changed source\n")])),
    /regenerate pi-fixture/);
  const first = loadPiWasm();
  first.fill(255);
  assert.equal(WebAssembly.validate(loadPiWasm()), true);
});

test("fixture-only mode works without Rust and an explicitly missing CLI is not silently hidden", () => {
  const moduleUrl = new URL("./test-fixture.mjs", import.meta.url).href;
  const script = `import { loadPiWasm } from ${JSON.stringify(moduleUrl)}; if (!WebAssembly.validate(loadPiWasm())) throw new Error('invalid fixture');`;
  const env = { ...process.env, WEAVE_PI_WASM: "", WEAVE_BIN: `/private/tmp/weave-pi-missing-cli-${process.pid}` };
  assert.doesNotThrow(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...env, WEAVE_PI_USE_FIXTURE: "1" }, stdio: "pipe", timeout: 5000,
  }));
  assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...env, WEAVE_PI_USE_FIXTURE: "0" }, stdio: "pipe", timeout: 5000,
  }), /ENOENT/);
});

test("pi is actually calculated in Wasm, approaches pi, and holds live nested frames in bounded memory", OPTIONS, async () => {
  const guest = await fresh();
  await runTo(guest, 1, "run");
  // The transformer lazily reserves its continuation stack at the first
  // suspension. Measure steady-state memory after that intentional allocation.
  const initialMemory = guest.instance.memBytes().length;
  await runTo(guest, 32);
  assert.equal(guest.events.at(-1)[0], 1048576n);
  for (const [terms, estimate] of guest.events) {
    const error = Math.PI - estimate;
    assert.ok(error > 0, "paired Leibniz partial sums approach pi from below");
    assert.ok(error < 2 / Number(terms), "error obeys the alternating-series upper bound");
    assert.ok(error > 0.9 / Number(terms), "the advertised slow convergence is genuine");
  }
  assert.ok(Math.PI - guest.lastEstimate < 0.000001);
  assert.equal(guest.instance.memBytes().length, initialMemory, "continued computation does not grow memory");
  const stackBytes = guest.instance.g("__weave_sp") - guest.instance.g("__weave_stack_base");
  assert.ok(stackBytes > 32, "the held continuation contains nested frames and live locals");
  assert.ok(stackBytes < 1024, "the stack depth is constant, not recursive growth");
});

test("pi f64 accumulator and Kahan correction survive six fresh-instance checkpoint restores bit for bit", OPTIONS, async () => {
  const baseline = await fresh();
  await runTo(baseline, 16, "run");
  const events = [];
  let current = await fresh(events);
  await runTo(current, 2, "run");
  const memoryLength = current.instance.memBytes().length;
  for (let hop = 0; hop < 6; hop++) {
    const snapshot = current.instance.checkpoint();
    const next = fixture(events);
    next.instance = new WeaveInstance(wasm(), next.services, { yieldMs: 10 });
    await next.instance.instantiate();
    next.instance.restore(snapshot);
    assert.equal(next.restores, 1);
    await runTo(next, events.length + 2);
    assert.equal(next.instance.memBytes().length, memoryLength);
    current = next;
  }
  await runTo(current, 16);
  exactEvents(events, baseline.events);
});

test("pi crosses six real migration handoffs with exact continuity and irrevocably retired sources", OPTIONS, async (t) => {
  const baseline = await fresh();
  await runTo(baseline, 16, "run");
  const events = [];
  let current = await fresh(events);
  await runTo(current, 2, "run");
  for (let hop = 0; hop < 6; hop++) {
    const { source, target } = transportPair(t);
    const next = fixture(events);
    const acceptance = acceptMigration(target, () => next.services, {
      targetReadTimeoutMs: 1000,
      targetSessionTimeoutMs: 3000,
      commitAckWriteTimeoutMs: 1000,
      yieldMs: 10,
    });
    void acceptance.catch(() => {});
    const migration = new SourceMigration(source, current.instance, `pi-source-${hop}`, {
      budgetBytes: 1 << 20,
      dirtyPageThreshold: 1000,
      maxRounds: 1,
      readTimeoutMs: 1000,
      commitTimeoutMs: 1000,
    });
    await migration.handshake();
    assert.equal(await migration.precopyStep(), true);
    const stats = await migration.finish();
    assert.equal(stats.commitConfirmed, true);
    assert.equal(current.instance.lifecycle, "retired");
    await assert.rejects(current.instance.drive(null, null), /retired/);
    next.instance = (await acceptance).inst;
    assert.equal(next.restores, 1);
    assert.ok(source.bytesWritten > wasm().length, "migration transferred module and continuation bytes");
    await runTo(next, events.length + 2);
    current = next;
  }
  await runTo(current, 16);
  exactEvents(events, baseline.events);
});

test("pi computation remains timer-responsive and cancellation leaves a resumable continuation", OPTIONS, async () => {
  const guest = await fresh();
  const abort = new AbortController();
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; abort.abort(); }, 40);
  try {
    await assert.rejects(guest.instance.drive("run", [], null, { signal: abort.signal }),
      (error) => error.name === "AbortError");
    assert.equal(timerFired, true);
    assert.equal(guest.instance.lifecycle, "paused");
    assert.ok(guest.lastTerms > 0n);
    await runTo(guest, guest.events.length + 2);
  } finally {
    clearTimeout(timer);
  }
});
