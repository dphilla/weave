import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FT, frame, readFrame, acceptMigration } from "./weave.mjs";
import { connectTcp, TcpTransport } from "./weave-node-transport.mjs";
import { makeEmitServices } from "./weave-node-services.mjs";
import { controlWasm } from "./test-support/control-fixture.mjs";

const runner = fileURLToPath(new URL("./weave-node.mjs", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function unusedPort() {
  const listener = net.createServer(); listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startNode(t, args = [], port = null) {
  port ??= await unusedPort();
  const child = spawn(process.execPath, [runner, "serve", "--listen", `127.0.0.1:${port}`, "--yield-ms", "1", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (data) => { stderr += data; });
  let stdout = ""; child.stdout.on("data", (data) => { stdout += data; });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, "exit"); child.kill("SIGTERM"); await exit;
  };
  t.after(stop);
  for (let i = 0; i < 200 && !stderr.includes("listening on"); i++) {
    if (child.exitCode !== null) throw new Error(`node exited ${child.exitCode}: ${stderr}`);
    await delay(10);
  }
  assert.match(stderr, /listening on/, stderr);
  return { port, stop, stdout: () => stdout, stderr: () => stderr };
}

async function request(port, value, { dropReply = false } = {}) {
  const transport = await connectTcp("127.0.0.1", port, { timeoutMs: 2000 });
  try {
    const payload = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
    await transport.write(frame(FT.CTL_REQUEST, payload));
    if (dropReply) return null;
    const result = await readFrame(transport);
    assert.equal(result.type, FT.CTL_RESPONSE);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.payload));
  } finally { transport.close(); }
}

async function waitFor(port, query, condition) {
  let result;
  for (let i = 0; i < 200; i++) {
    result = await request(port, query);
    if (condition(result)) return result;
    await delay(10);
  }
  assert.fail(`operation did not reach expected state: ${JSON.stringify(result)}`);
}

async function targetServer(t, handler) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    handler(new TcpTransport(socket)).catch(() => socket.destroy());
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

test("Node rejects invalid source configuration before opening its control listener", { timeout: 15000 }, async (t) => {
  for (const [flag, value] of [["budget", "0"], ["budget", "1.5"], ["max-rounds", "NaN"], ["dirty-threshold", "-1"], ["yield-ms", "NaN"]]) {
    const child = spawn(process.execPath, [runner, "serve", "--listen", "127.0.0.1:0", `--${flag}`, value], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", (data) => { stderr += data; });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 2000);
    const [code] = await once(child, "close"); clearTimeout(timer);
    assert.equal(timedOut, false, `--${flag} was not rejected promptly`);
    assert.notEqual(code, 0);
    assert.match(stderr, new RegExp(`--${flag} must be`));
    assert.doesNotMatch(stderr, /listening on/);
  }
});

test("real Node process exposes strict discovery, survives malformed peers and changes epoch on restart", { timeout: 15000 }, async (t) => {
  const node = await startNode(t);
  const status = await request(node.port, { schema_version: 1, action: "status" });
  assert.equal(status.lifecycle, "idle");
  assert.equal(status.ownership, "none");
  assert.equal(status.capabilities.runtime, "node");
  assert.equal(status.capabilities.migration_protocol, 2);
  assert.equal((await request(node.port, '{"schema_version":1,"action":"status","extra":true}')).code, "INVALID_REQUEST");
  assert.equal((await request(node.port, '{"schema_version":1,"schema_version":1,"action":"status"}')).code, "INVALID_REQUEST");
  const malformed = await connectTcp("127.0.0.1", node.port);
  const header = new Uint8Array(5); header[0] = FT.CTL_REQUEST; new DataView(header.buffer).setUint32(1, 65537, true);
  await malformed.write(header);
  await assert.rejects(() => readFrame(malformed)); malformed.close();
  assert.equal((await request(node.port, { schema_version: 1, action: "status" })).code, "STATUS_OK");
  const legacy = await connectTcp("127.0.0.1", node.port);
  await legacy.write(frame(FT.CTL_STATUS));
  assert.equal((await readFrame(legacy)).type, FT.CTL_OK); legacy.close();
  await node.stop();
  const restarted = await startNode(t, [], node.port);
  const current = await request(restarted.port, { schema_version: 1, action: "status" });
  assert.notEqual(current.node_epoch, status.node_epoch);
  const stale = await request(restarted.port, { schema_version: 1, action: "migrate", node_epoch: status.node_epoch, operation_id: "stale", target: "localhost:9000" });
  assert.equal(stale.code, "NODE_EPOCH_MISMATCH");
  assert.equal(stale.retry, "inspect_ownership");
});

test("real Node source preserves one accepted operation after a lost reply and distinguishes precommit failure", { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "weave-control-process-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const modulePath = path.join(dir, "control.wasm"); await writeFile(modulePath, controlWasm());
  const node = await startNode(t, ["--module", modulePath, "--invoke", "forever"]);
  const status = await waitFor(node.port, { schema_version: 1, action: "status" }, (response) => response.lifecycle === "running");
  const unavailablePort = await unusedPort();
  const migration = { schema_version: 1, action: "migrate", node_epoch: status.node_epoch, operation_id: "lost-reply", target: `127.0.0.1:${unavailablePort}` };
  await request(node.port, migration, { dropReply: true });
  const lookup = { ...migration, action: "operation" }; delete lookup.target;
  const result = await waitFor(node.port, lookup, (response) => response.code === "MIGRATION_FAILED");
  assert.equal(result.ownership, "retained");
  assert.equal(result.operation.ownership, "retained");
  assert.equal(result.retry, "new_operation");
  const replay = await request(node.port, migration);
  assert.deepEqual(replay.operation, result.operation);
  const conflict = await request(node.port, { ...migration, target: `127.0.0.1:${node.port}` });
  assert.equal(conflict.code, "OPERATION_CONFLICT");
  assert.equal((await request(node.port, { schema_version: 1, action: "status" })).lifecycle, "running");
  assert.equal(node.stdout(), "", "forever guest has not accidentally completed or produced host effects");
});

test("real Node reports completed and trapped workloads without retrying a failed instance", { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "weave-control-lifecycle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const modulePath = path.join(dir, "control.wasm"); await writeFile(modulePath, controlWasm());
  for (const [entry, lifecycle] of [["run", "completed"], ["fail", "failed"]]) {
    const node = await startNode(t, ["--module", modulePath, "--invoke", entry]);
    const status = await waitFor(node.port, { schema_version: 1, action: "status" }, (response) => response.lifecycle === lifecycle);
    assert.equal(status.ownership, "none");
    if (entry === "run") assert.match(node.stdout(), /WEAVE_DONE \[42\]/);
    else assert.match(node.stderr(), /workload trapped/);
    await node.stop();
  }
});

test("real Node final-copy failure allows a new operation that successfully migrates", { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "weave-control-final-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const modulePath = path.join(dir, "control.wasm"); await writeFile(modulePath, controlWasm());
  let finalRestoreAttempted = false;
  const rejectingPort = await targetServer(t, async (transport) => {
    await acceptMigration(transport, () => {
      const services = makeEmitServices();
      services.get("env.emit").restore = () => { finalRestoreAttempted = true; throw new Error("intentional final-copy restore rejection"); };
      return services;
    });
  });
  const source = await startNode(t, ["--module", modulePath, "--invoke", "forever"]);
  const target = await startNode(t);
  const status = await waitFor(source.port, { schema_version: 1, action: "status" }, (response) => response.lifecycle === "running");
  const migration = { schema_version: 1, action: "migrate", node_epoch: status.node_epoch, operation_id: "final-fails", target: `127.0.0.1:${rejectingPort}` };
  assert.equal((await request(source.port, migration)).code, "ACCEPTED");
  const query = { ...migration, action: "operation" }; delete query.target;
  const failure = await waitFor(source.port, query, (response) => response.code === "MIGRATION_FAILED");
  assert.equal(finalRestoreAttempted, true, "failure occurred during final-copy service restore");
  assert.equal(failure.ownership, "retained");
  assert.equal(failure.retry, "new_operation");
  const retry = { ...migration, operation_id: "retry-succeeds", target: `127.0.0.1:${target.port}` };
  assert.equal((await request(source.port, retry)).code, "ACCEPTED");
  const result = await waitFor(source.port, { ...query, operation_id: retry.operation_id }, (response) => response.code === "MIGRATED");
  assert.equal(result.ownership, "retired");
  assert.equal(result.operation.state, "succeeded");
  assert.equal((await request(target.port, { schema_version: 1, action: "status" })).lifecycle, "running");
});

test("real Node exposes irreversible COMMIT_PENDING then uncertainty when COMMIT_OK is lost", { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "weave-control-commit-loss-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const modulePath = path.join(dir, "control.wasm"); await writeFile(modulePath, controlWasm());
  let commitReceived = false;
  let releaseAck;
  const ackGate = new Promise((resolve) => { releaseAck = resolve; });
  t.after(releaseAck);
  const targetPort = await targetServer(t, async (transport) => {
    await acceptMigration({
      readExact: (n) => transport.readExact(n),
      close: () => transport.close(),
      write: async (data) => {
        if (data[0] !== FT.COMMIT_OK) return transport.write(data);
        commitReceived = true;
        await ackGate;
        transport.close();
        throw new Error("intentional lost COMMIT_OK");
      },
    }, makeEmitServices);
  });
  const source = await startNode(t, ["--module", modulePath, "--invoke", "forever"]);
  const status = await waitFor(source.port, { schema_version: 1, action: "status" }, (response) => response.lifecycle === "running");
  const migration = { schema_version: 1, action: "migrate", node_epoch: status.node_epoch, operation_id: "commit-loss", target: `127.0.0.1:${targetPort}` };
  assert.equal((await request(source.port, migration)).code, "ACCEPTED");
  const query = { ...migration, action: "operation" }; delete query.target;
  const pending = await waitFor(source.port, query, (response) => response.code === "COMMIT_PENDING");
  assert.equal(commitReceived, true);
  assert.equal(pending.ownership, "retired");
  assert.equal(pending.operation.ownership, "retired");
  assert.equal(pending.operation.state, "accepted");
  releaseAck();
  const uncertain = await waitFor(source.port, query, (response) => response.code === "COMMIT_UNCERTAIN");
  assert.equal(uncertain.ownership, "retired");
  assert.equal(uncertain.retry, "inspect_ownership");
  assert.equal(uncertain.ok, false);
  assert.equal((await request(source.port, migration)).operation.state, "uncertain");
});
