import assert from "node:assert/strict";
import test from "node:test";

import {
  OutboundMigrationAdmission,
  TargetAdmission,
} from "./weave-node-admission.mjs";

test("only one concurrent target session can reserve an idle node", async () => {
  const admission = new TargetAdmission();
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });

  const first = (async () => {
    const token = admission.tryReserve();
    assert.notEqual(token, null);
    await gate; // models the first await inside acceptMigration()
    admission.commit(token);
    return "accepted";
  })();

  assert.equal(admission.status(), "accepting migration");
  assert.equal(admission.tryReserve(), null, "second HELLO must observe the reservation");
  unblock();
  assert.equal(await first, "accepted");
  assert.equal(admission.status(), "running");
});

test("pre-COMMIT failure releases only its own reservation", () => {
  const admission = new TargetAdmission();
  const failed = admission.tryReserve();
  assert.equal(admission.release(failed), true);
  const next = admission.tryReserve();
  assert.notEqual(next, null);
  assert.equal(admission.release(failed), false, "stale cleanup cannot release a newer session");
  assert.equal(admission.status(), "accepting migration");
  admission.commit(next);
  assert.equal(admission.status(), "running");
});

test("configured initial work reserves the node while it instantiates", () => {
  const admission = new TargetAdmission(true);
  assert.equal(admission.status(), "starting");
  assert.equal(admission.tryReserve(), null);
  admission.startRunning();
  assert.equal(admission.status(), "running");
  admission.finishRunning();
  assert.equal(admission.status(), "idle");
});

test("simultaneous control migrations reserve exactly one running workload", async () => {
  const admission = new TargetAdmission(true);
  admission.startRunning();
  const outbound = new OutboundMigrationAdmission(() => admission.isRunning());

  const issue = async (target) => {
    const attempt = outbound.tryReserve(target);
    if (!attempt.ok) return `error: ${attempt.error}`;
    return attempt.request.result;
  };

  // An async function runs synchronously through its first await. The first
  // request therefore owns the slot while its result is pending, exactly as
  // two socket callbacks interleave in the Node server.
  const first = issue("target-a:1234");
  const second = issue("target-b:5678");
  assert.equal(await second, "error: migration already in progress");
  assert.equal(outbound.current().target, "target-a:1234");

  assert.equal(outbound.complete(outbound.current(), "migrated: ok"), true);
  assert.equal(await first, "migrated: ok");
});

test("control migration rejects idle nodes and stale completion is harmless", async () => {
  const admission = new TargetAdmission();
  const outbound = new OutboundMigrationAdmission(() => admission.isRunning());
  assert.deepEqual(outbound.tryReserve("target:1234"), {
    ok: false,
    error: "node has no active workload",
  });

  const incoming = admission.tryReserve();
  admission.commit(incoming);
  const first = outbound.tryReserve("first:1234").request;
  outbound.complete(first, "migration failed");
  assert.equal(await first.result, "migration failed");

  const second = outbound.tryReserve("second:1234").request;
  assert.equal(outbound.complete(first, "stale"), false);
  assert.equal(outbound.current(), second);
  outbound.complete(second, "migrated: ok");
  assert.equal(await second.result, "migrated: ok");

  admission.finishRunning();
  assert.equal(outbound.tryReserve("third:1234").ok, false);
});

test("control migration rejects an empty target without consuming the slot", () => {
  const admission = new TargetAdmission(true);
  admission.startRunning();
  const outbound = new OutboundMigrationAdmission(() => admission.isRunning());
  assert.deepEqual(outbound.tryReserve("  "), {
    ok: false,
    error: "migration target must not be empty",
  });
  const valid = outbound.tryReserve("target:1234");
  assert.equal(valid.ok, true);
  assert.equal(outbound.current(), valid.request);
});
