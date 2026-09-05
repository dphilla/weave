import assert from "node:assert/strict";
import test from "node:test";
import { APP_KINDS, flush, loadApp, runningApp } from "../test-support/browser-app-harness.mjs";

for (const kind of APP_KINDS) {
  test(`${kind}: burst Start creates only one workload`, async (t) => {
    const app = await loadApp(kind);
    t.after(() => app.dispose());
    const starts = [app.start(), app.start(), app.start()];
    assert.equal(app.instances.length, 1, "Start must reserve ownership before instantiate awaits");
    assert.equal(app.startButton.disabled, true, "Start is disabled during instantiation");
    await app.instantiate();
    assert.equal(app.instances[0].instantiateCalls, 1);
    assert.equal(app.instances[0].initCalls, 1);
    assert.equal(app.instances[0].driveCalls.length, 1);
    await app.complete();
    await Promise.all(starts);
    assert.equal(app.state.active, null);
    assert.equal(app.state.runner, null);
  });

  test(`${kind}: pending Start excludes Arm or incoming prepare`, async (t) => {
    const app = await loadApp(kind);
    t.after(() => app.dispose());
    const start = app.start();
    void app.arm();
    await flush();
    assert.equal(app.state.accepting, false, "target cannot stage while a fresh workload is instantiating");
    assert.equal(app.acceptances.length + app.relayAcceptances.length, 0);
    if (kind === "peer") {
      assert.equal(app.control.sent.filter((message) => message.type === "migration-rejected").length, 1);
    }
    await app.instantiate();
    await app.complete();
    await start;
  });

  test(`${kind}: armed incoming target excludes Start`, async (t) => {
    const app = await loadApp(kind);
    t.after(() => app.dispose());
    void app.arm();
    await flush();
    assert.equal(app.state.accepting, true);
    assert.equal(app.startButton.disabled, true);
    await app.start();
    assert.equal(app.instances.length, 0);
  });

  for (const phase of ["instantiate", "init"]) {
    test(`${kind}: ${phase} failure releases the Start reservation for retry`, async (t) => {
      const app = await loadApp(kind);
      t.after(() => app.dispose());
      if (phase === "init") app.failNextInit();
      const failed = app.start();
      if (phase === "instantiate") app.instances[0].instantiation.reject(new Error("instantiate failed"));
      else await app.instantiate();
      await failed;
      assert.equal(app.state.active, null);
      assert.equal(app.state.runner, null);
      assert.equal(app.startButton.disabled, false);
      const retry = app.start();
      assert.equal(app.instances.length, 2, "a failed start must not permanently consume the source slot");
      await app.instantiate(1);
      assert.equal(app.instances[1].driveCalls.length, 1);
      await app.complete(1);
      await retry;
    });
  }
}

test("peer: duplicate Migrate emits one prepare and the ACK queues one stream", async (t) => {
  const { app, start } = await runningApp("peer");
  t.after(() => app.dispose());
  const requests = [app.requestMigration(), app.requestMigration(), app.requestMigration()];
  assert.equal(app.control.sent.filter((message) => message.type === "prepare-migration").length, 1);
  assert.equal(app.migrateButton.disabled, true, "Migrate is disabled before waiting for its ACK");
  assert.equal(app.timers.capture(10_000).length, 1);
  app.control.message({ type: "migration-armed", channel: "a-to-b" });
  await flush();
  await Promise.all(requests);
  assert.equal(app.state.pendingArm, null);
  assert.equal(app.state.migrationRequested, true);
  assert.equal(app.streams.length, 1);
  assert.equal(app.elements.runtimeState.textContent, "queued");
  assert.equal(app.timers.capture(10_000).length, 0);
  await app.complete();
  await start;
});

test("peer: normal ACK remains scoped to the live workload", async (t) => {
  const { app, start } = await runningApp("peer");
  t.after(() => app.dispose());
  const active = app.state.active;
  const request = app.requestMigration();
  app.control.message({ type: "migration-armed", channel: "a-to-b" });
  await request;
  assert.equal(app.state.active, active);
  assert.equal(app.state.migrationRequested, true);
  assert.equal(app.state.outboundStream, app.streams[0]);
  assert.equal(app.timers.capture(10_000).length, 0);
  await app.complete();
  await start;
});

for (const lateEvent of ["ack", "timeout"]) {
  test(`peer: completion while arming ignores a late ${lateEvent}`, async (t) => {
    const { app, start } = await runningApp("peer");
    t.after(() => app.dispose());
    let settled = false;
    const request = app.requestMigration().finally(() => { settled = true; });
    const oldTimers = app.timers.capture(10_000);
    assert.equal(oldTimers.length, 1);
    await app.complete();
    await start;
    await flush();
    assert.equal(app.elements.runtimeState.textContent, "complete");
    assert.equal(app.state.pendingArm, null, "retiring a workload must cancel its arm wait");
    assert.equal(app.timers.capture(10_000).length, 0);
    assert.equal(settled, true, "cancellation settles the request without waiting ten seconds");
    if (lateEvent === "ack") app.control.message({ type: "migration-armed", channel: "a-to-b" });
    else for (const timer of oldTimers) timer.callback();
    await flush();
    await request;
    assert.equal(app.elements.runtimeState.textContent, "complete", "late continuations cannot resurrect the running/queued badge");
    assert.equal(app.state.active, null);
    assert.equal(app.state.runner, null);
    assert.equal(app.state.pendingArm, null);
    assert.equal(app.state.migrationRequested, false);
    assert.equal(app.state.outboundStream, null);
    assert.equal(app.streams.length, 0, "a completed source must not allocate an outbound migration stream");
  });
}

test("peer: control close cancels a pending arm without a timeout", async (t) => {
  const { app, start } = await runningApp("peer");
  t.after(() => app.dispose());
  let settled = false;
  const request = app.requestMigration().finally(() => { settled = true; });
  app.control.close();
  await flush();
  assert.equal(app.state.pendingArm, null);
  assert.equal(app.timers.capture(10_000).length, 0);
  assert.equal(settled, true);
  assert.equal(app.state.migrationRequested, false);
  assert.equal(app.state.outboundStream, null);
  assert.equal(app.elements.runtimeState.textContent, "running");
  await request;
  await app.complete();
  await start;
});

test("peer: outbound close cancels a pending arm and ignores a later ACK", async (t) => {
  const { app, start } = await runningApp("peer");
  t.after(() => app.dispose());
  const active = app.state.active;
  let settled = false;
  const request = app.requestMigration().finally(() => { settled = true; });
  app.channels.get("a-to-b").close();
  await flush();
  assert.equal(app.state.pendingArm, null);
  assert.equal(app.timers.capture(10_000).length, 0);
  assert.equal(settled, true);
  app.control.message({ type: "migration-armed", channel: "a-to-b" });
  await flush();
  await request;
  assert.equal(app.state.active, active, "channel failure must not retire the local workload");
  assert.equal(app.state.migrationRequested, false);
  assert.equal(app.state.outboundStream, null);
  assert.equal(app.streams.length, 0);
  await app.complete();
  await start;
});

test("peer: synchronous prepare-send failure releases the wait for retry", async (t) => {
  const { app, start } = await runningApp("peer");
  t.after(() => app.dispose());
  const originalSend = app.control.send.bind(app.control);
  let first = true;
  app.control.send = (value) => {
    if (first && JSON.parse(value).type === "prepare-migration") {
      first = false;
      throw new Error("synchronous send failure");
    }
    originalSend(value);
  };
  await app.requestMigration();
  assert.equal(app.state.pendingArm, null);
  assert.equal(app.timers.capture(10_000).length, 0);
  assert.equal(app.state.migrationRequested, false);
  assert.equal(app.elements.runtimeState.textContent, "running");
  assert.equal(app.migrateButton.disabled, false);
  const retry = app.requestMigration();
  app.control.message({ type: "migration-armed", channel: "a-to-b" });
  await retry;
  assert.equal(app.state.migrationRequested, true);
  assert.equal(app.streams.length, 1);
  await app.complete();
  await start;
});

test("peer: pagehide cancels a pending arm and ignores later callbacks", async (t) => {
  const { app, start } = await runningApp("peer");
  t.after(() => app.dispose());
  let settled = false;
  const request = app.requestMigration().finally(() => { settled = true; });
  const oldTimers = app.timers.capture(10_000);
  app.pagehide();
  await flush();
  assert.equal(app.state.pendingArm, null);
  assert.equal(app.timers.capture(10_000).length, 0);
  assert.equal(settled, true);
  const badge = app.elements.runtimeState.textContent;
  app.control.message({ type: "migration-armed", channel: "a-to-b" });
  for (const timer of oldTimers) timer.callback();
  await request;
  await flush();
  assert.equal(app.elements.runtimeState.textContent, badge);
  assert.equal(app.state.migrationRequested, false);
  assert.equal(app.state.outboundStream, null);
  assert.equal(app.streams.length, 0);
  await app.complete();
  await start;
});

test("peer: an ACK queued just before control close cannot queue migration", async (t) => {
  const { app, start } = await runningApp("peer");
  t.after(() => app.dispose());
  const request = app.requestMigration();
  app.control.message({ type: "migration-armed", channel: "a-to-b" });
  app.control.close();
  await request;
  assert.equal(app.state.pendingArm, null);
  assert.equal(app.timers.capture(10_000).length, 0);
  assert.equal(app.state.migrationRequested, false);
  assert.equal(app.state.outboundStream, null);
  assert.equal(app.streams.length, 0);
  await app.complete();
  await start;
});
