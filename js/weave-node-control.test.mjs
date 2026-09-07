import assert from "node:assert/strict";
import test from "node:test";
import { ControlState, builtinCapabilities, decodeRequest, encodeResponse, validTarget } from "./weave-node-control.mjs";
import { FT, frame, readFrame } from "./weave.mjs";

const bytes = (value) => new TextEncoder().encode(value);
const state = () => new ControlState(builtinCapabilities(), "running", "epoch");
const migrate = (operation_id = "one", target = "localhost:9000") => ({ schema_version: 1, action: "migrate", node_epoch: "epoch", operation_id, target });
const lookup = (operation_id = "one") => ({ schema_version: 1, action: "operation", node_epoch: "epoch", operation_id });

test("control request decoding is strict, Unicode-valid and versioned", () => {
  for (const value of ["null", "[]", "{}", '{"schema_version":1,"action":"status","extra":true}',
    '{"schema_version":1,"schema_version":1,"action":"status"}',
    '{"schema_version":1,"schema_versio\\u006e":1,"action":"status"}',
    '{"schema_version":1.0,"action":"status"}', '{"schema_version":1e0,"action":"status"}',
    '{"schema_version":null,"action":"status"}', '{"schema_version":1,"action":"other"}',
    '{"schema_version":1,"action":"status","target":{}}',
    '{"schema_version":1,"action":"status","target":"\\ud800"}',
    '{"schema_version":1,"action":"status"} {}']) {
    assert.throws(() => decodeRequest(bytes(value)), undefined, value);
  }
  assert.throws(() => decodeRequest(new Uint8Array([255])));
  assert.throws(() => decodeRequest(bytes('\ufeff{"schema_version":1,"action":"status"}')));
  assert.equal(decodeRequest(bytes('{"schema_version":1,"action":"operation","node_epoch":"\ufeffepoch","operation_id":"one"}')).node_epoch, "\ufeffepoch");
  assert.throws(() => decodeRequest(new Uint8Array(65537)));
  const s = state();
  assert.equal(s.handle(decodeRequest(bytes('{"schema_version":2,"action":"status"}')), true).response.code, "UNSUPPORTED_SCHEMA");
  assert.equal(s.handle(decodeRequest(bytes('{"schema_version":1,"action":"status","target":null}')), true).response.code, "STATUS_OK");
});

test("epoch-scoped duplicate IDs return the original operation without reexecution", () => {
  const s = state();
  assert.ok(s.handle(migrate(), true).accepted);
  assert.equal(s.handle(migrate(), true).accepted, null);
  assert.equal(s.handle(migrate("two"), true).response.code, "NODE_BUSY");
  s.complete("failed_before_commit", "migrated: misleading text");
  const replay = s.handle(migrate(), true);
  assert.equal(replay.accepted, null);
  assert.equal(replay.response.code, "MIGRATION_FAILED");
  assert.equal(replay.response.operation.ownership, "retained");
  assert.equal(s.handle(migrate("one", "localhost:9001"), true).response.code, "OPERATION_CONFLICT");
  assert.equal(s.handle({ ...migrate(), node_epoch: "old" }, true).response.code, "NODE_EPOCH_MISMATCH");
  assert.equal(s.handle(lookup("missing"), true).response.code, "OPERATION_NOT_FOUND");
  assert.ok(s.handle(migrate("two"), true).accepted);
});

test("full control ledger fails closed and keeps the first accepted ID", () => {
  const s = state();
  for (let i = 0; i < 256; i++) {
    assert.ok(s.handle(migrate(`id-${i}`), true).accepted);
    s.complete("failed_before_commit", "unreachable");
  }
  assert.equal(s.handle(migrate("overflow"), true).response.code, "OPERATION_CAPACITY");
  assert.equal(s.handle(migrate("id-0"), true).response.code, "MIGRATION_FAILED");
  assert.equal(s.operations.size, 256);
});

test("PREPARED retires the source before confirmation and never becomes retryable failure", () => {
  const s = state(); s.handle(migrate(), true); s.sourceRetired();
  const pending = s.handle(lookup(), false).response;
  assert.equal(pending.code, "COMMIT_PENDING");
  assert.equal(pending.operation.state, "accepted");
  assert.equal(pending.ownership, "retired");
  assert.equal(pending.operation.ownership, "retired");
  s.complete("failed_before_commit", "migrated: misleading text");
  const final = s.handle(lookup(), false).response;
  assert.equal(final.code, "COMMIT_UNCERTAIN");
  assert.equal(final.retry, "inspect_ownership");
  assert.equal(final.ok, false);
  assert.equal(final.ownership, "retired");
  s.setLifecycle("running");
  assert.equal(s.handle(lookup(), true).response.operation.ownership, "retired");
});

test("typed completions distinguish confirmed, precommit, done and trapped", () => {
  for (const [completion, code, lifecycle, ownership] of [
    ["migrated", "MIGRATED", "retired", "retired"],
    ["commit_uncertain", "COMMIT_UNCERTAIN", "retired", "retired"],
    ["failed_before_commit", "MIGRATION_FAILED", "running", "retained"],
    ["workload_completed", "WORKLOAD_COMPLETED", "completed", "none"],
    ["workload_trapped", "WORKLOAD_TRAPPED", "failed", "none"],
  ]) {
    const s = state(); s.handle(migrate(), true); s.complete(completion, "anything");
    const result = s.handle(lookup(), false).response;
    assert.deepEqual([result.code, result.lifecycle, result.ownership], [code, lifecycle, ownership]);
  }
});

test("targets and operation IDs reject ambiguous, oversized or malformed values", () => {
  const s = state();
  for (const target of ["", "host", "host:0", "host:+1", "host:65536", "host:1\n", "a:b:1", "[invalid]:1", "::1:80", "[127.0.0.1]:1", "host:1.0"]) {
    assert.equal(validTarget(target), false, target);
    assert.equal(s.handle(migrate("one", target), true).response.code, "INVALID_REQUEST");
  }
  assert.equal(validTarget("[::1]:9000"), true);
  assert.equal(validTarget("localhost:09000"), true);
  for (const id of ["", "a b", "../id", "☃", "x".repeat(129)]) assert.equal(s.handle(migrate(id), true).response.code, "INVALID_REQUEST");
  assert.equal(s.operations.size, 0);
});

test("control responses, capability claims, epochs and returned records are bounded and isolated", () => {
  const first = new ControlState(builtinCapabilities());
  const second = new ControlState(builtinCapabilities());
  assert.match(first.epoch, /^[a-f0-9]{32}$/);
  assert.notEqual(first.epoch, second.epoch);
  const s = state(); s.handle(migrate(), true); s.complete("failed_before_commit", "☃".repeat(2048));
  const response = s.handle(lookup(), true).response;
  assert.ok(bytes(response.message).length <= 2048);
  response.operation.state = "succeeded";
  assert.equal(s.handle(lookup(), true).response.operation.state, "failed");
  assert.equal(JSON.parse(new TextDecoder().decode(encodeResponse(s.status()))).capabilities.migration_protocol, 2);
  assert.throws(() => new ControlState({ ...builtinCapabilities(), features: ["x".repeat(33000)] }));
});

test("structured control frame cap is checked before payload reads or allocation", async () => {
  for (const type of [FT.CTL_REQUEST, FT.CTL_RESPONSE]) {
    const header = new Uint8Array(5); header[0] = type;
    new DataView(header.buffer).setUint32(1, 65537, true);
    let reads = 0;
    await assert.rejects(() => readFrame({ readExact: async () => { reads++; return header; } }), /control frame too large/);
    assert.equal(reads, 1);
    assert.throws(() => frame(type, new Uint8Array(65537)), /control frame payload too large/);
    assert.equal(frame(type, new Uint8Array(65536)).length, 65541);
  }
});
