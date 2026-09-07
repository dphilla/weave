#!/usr/bin/env node
// Black-box human/agent workflow: central CLI against four persistent runtimes.
// No runtime is skipped. All commands, JSON results, and server logs are retained.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifacts = process.env.WEAVE_CI_ARTIFACT_DIR
  ? path.resolve(process.env.WEAVE_CI_ARTIFACT_DIR)
  : mkdtempSync(path.join(os.tmpdir(), "weave-control-interface-"));
mkdirSync(artifacts, { recursive: true });
const weave = process.env.WEAVE_BIN || path.join(root, "target/release/weave");
const wamr = process.env.WAMR_BIN || process.env.WEAVE_WAMR_BIN || path.join(root, "wamr/target/release/weave-wamr");
const node = process.env.NODE_BIN || process.execPath;
let wazero = process.env.WEAVE_WAZERO_BIN;
const owned = new Set();
const results = [];
let sequence = 0;

function launch(label, executable, args, options = {}) {
  const prefix = `${String(++sequence).padStart(3, "0")}-${label}`;
  appendFileSync(path.join(artifacts, "commands.jsonl"), JSON.stringify({ prefix, executable, args, cwd: options.cwd || root }) + "\n");
  const child = spawn(executable, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], ...options });
  owned.add(child);
  let stdout = "", stderr = "", error = null;
  const collect = (name, chunk) => {
    appendFileSync(path.join(artifacts, `${prefix}.${name}.log`), chunk);
    if (name === "stdout") stdout += chunk.toString(); else stderr += chunk.toString();
    if (stdout.length + stderr.length > 2 * 1024 * 1024) {
      error = new Error(`${label}: output exceeded 2 MiB`);
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", (chunk) => collect("stdout", chunk));
  child.stderr.on("data", (chunk) => collect("stderr", chunk));
  child.on("error", (cause) => { error = cause; });
  const completion = new Promise((resolve) => child.once("close", (code, signal) => {
    owned.delete(child);
    resolve({ code, signal, error, stdout, stderr, prefix });
  }));
  return { child, completion, prefix };
}

async function command(label, executable, args, { timeout = 20000, ...options } = {}) {
  const task = launch(label, executable, args, options);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; task.child.kill("SIGKILL"); }, timeout);
  const result = await task.completion;
  clearTimeout(timer);
  if (timedOut) throw new Error(`${label}: exceeded ${timeout}ms; see ${result.prefix}`);
  if (result.error) throw result.error;
  return result;
}

async function cli(label, args, expectedCode = 0) {
  const result = await command(label, weave, [...args, "--json"]);
  let value;
  try { value = JSON.parse(result.stdout); }
  catch { throw new Error(`${label}: stdout is not one JSON document: ${result.stdout}; stderr=${result.stderr}`); }
  writeFileSync(path.join(artifacts, `${result.prefix}.json`), JSON.stringify(value, null, 2) + "\n");
  assert.equal(result.code, expectedCode, `${label}: ${JSON.stringify(value)}; ${result.stderr}`);
  assert.equal(value.schema_version, 1, label);
  return value;
}

async function unusedAddress() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = `127.0.0.1:${server.address().port}`;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address;
}

async function start(runtime, fixture, active) {
  const address = await unusedAddress();
  const executable = { wasmtime: weave, node, wazero, wamr }[runtime];
  const args = runtime === "node" ? [path.join(root, "js/weave-node.mjs")] : [];
  args.push("serve", "--listen", address);
  if (active) {
    args.push("--module", fixture, "--invoke", "run");
    if (runtime === "wasmtime") args.push("--pre-woven");
  }
  const task = launch(`${runtime}-server`, executable, args);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (task.child.exitCode !== null || task.child.signalCode !== null) {
      const result = await task.completion;
      throw new Error(`${runtime} exited during startup: ${result.stderr}`);
    }
    try {
      const status = await cli(`${runtime}-startup`, ["status", "--node", address, "--timeout-ms", "500"]);
      if (status.lifecycle === (active ? "running" : "idle")) return { runtime, address, task, epoch: status.node_epoch };
    } catch (error) {
      if (Date.now() + 100 >= deadline) throw error;
    }
    await delay(25);
  }
  throw new Error(`${runtime}: did not become ready`);
}

function identity(server, id) {
  return ["--node", server.address, "--operation-id", id, "--node-epoch", server.epoch];
}

function retainedFailure(result, id) {
  assert.equal(result.code, "MIGRATION_FAILED");
  assert.equal(result.lifecycle, "running");
  assert.equal(result.ownership, "retained");
  assert.equal(result.operation.operation_id, id);
  assert.equal(result.operation.state, "failed");
  assert.equal(result.operation.ownership, "retained");
  assert.equal(result.operation.retry, "new_operation");
}

// Simulate an application that loses/discards the acceptance response. We do
// not decode the reply: the next application observation is lookup by saved ID.
async function discardAcceptanceReply(server, request) {
  const json = Buffer.from(JSON.stringify(request));
  const header = Buffer.alloc(5);
  header[0] = 23;
  header.writeUInt32LE(json.length, 1);
  writeFileSync(path.join(artifacts, `${server.runtime}-discarded-reply-request.json`), JSON.stringify(request, null, 2) + "\n");
  await new Promise((resolve, reject) => {
    const [host, port] = server.address.split(":");
    const socket = net.createConnection({ host, port: Number(port) });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    socket.setTimeout(5000, () => finish(new Error("discarded-reply request timed out")));
    socket.once("connect", () => socket.write(Buffer.concat([header, json])));
    socket.once("data", () => finish());
    socket.once("error", finish);
    socket.once("end", () => finish(new Error("node closed without a control reply")));
  });
}

async function cleanup() {
  const children = [...owned];
  await Promise.all(children.map(async (child) => {
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    await closed;
    clearTimeout(timer);
  }));
  assert.equal(owned.size, 0, "every owned subprocess must be reaped");
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  if (stopping) return;
  stopping = true;
  void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
});

async function main() {
  if (!wazero) {
    wazero = path.join(artifacts, "weave-wazero");
    const build = await command("build-wazero", "go", ["build", "-o", wazero, "."], {
      cwd: path.join(root, "go/weave-wazero"), timeout: 120000,
      env: { ...process.env, GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local" },
    });
    assert.equal(build.code, 0, `offline wazero build: ${build.stderr}`);
  }
  const wat = path.join(artifacts, "control-loop.wat");
  const fixture = path.join(artifacts, "control-loop.woven.wasm");
  writeFileSync(wat, '(module (func (export "run") (loop $again br $again)))\n');
  const transform = await command("transform", weave, ["transform", wat, "-o", fixture, "--period", "1", "--stack-pages", "1"]);
  assert.equal(transform.code, 0, transform.stderr);

  const servers = [];
  for (const runtime of ["wasmtime", "node", "wazero", "wamr"]) {
    servers.push(await start(runtime, fixture, runtime === "wasmtime"));
  }
  const services = ["env.emit", "env.emit32", "env.emit64"];
  for (let index = 0; index < servers.length; index++) {
    const source = servers[index], target = servers[(index + 1) % servers.length];
    const tag = source.runtime;
    const status = await cli(`${tag}-status`, ["status", "--node", source.address, "--timeout-ms", "5000"]);
    assert.equal(status.lifecycle, "running");
    assert.equal(status.ownership, "retained");
    assert.equal(status.node_epoch, source.epoch);
    assert.match(status.node_epoch, /^[0-9a-f]{32}$/);
    assert.equal(status.capabilities.runtime, source.runtime);
    assert.equal(status.capabilities.migration_protocol, 2);
    assert.deepEqual([...status.capabilities.services].sort(), services);
    assert.equal(status.capabilities.imports.length, 3);
    for (const declaration of status.capabilities.imports) {
      assert.equal(declaration.module, "env");
      assert.deepEqual(declaration.results, []);
      assert.deepEqual(declaration.params, { emit: ["i32", "i64"], emit32: ["i32"], emit64: ["i64"] }[declaration.name]);
    }
    assert.equal(status.capabilities.limits.control_frame_bytes, 65536);
    assert.equal(status.capabilities.limits.retained_operations, 256);
    assert.equal(status.capabilities.limits.operation_id_bytes, 128);
    const preflight = await cli(`${tag}-inspect`, ["inspect", fixture, "--pre-woven", "--invoke", "run", "--node", source.address, "--timeout-ms", "5000"]);
    assert.equal(preflight.code, "PREFLIGHT_OK", JSON.stringify(preflight.findings));
    const legacy = await command(`${tag}-legacy-status`, weave, ["status", "--node", source.address, "--legacy", "--timeout-ms", "5000"]);
    assert.equal(legacy.code, 0, legacy.stderr);
    assert.match(legacy.stdout, /^ok:/);

    const unavailable = await unusedAddress();
    const failedId = `${tag}-refusal`;
    const failed = await cli(`${tag}-refusal`, ["migrate", ...identity(source, failedId), "--to", unavailable, "--timeout-ms", "5000"], 4);
    retainedFailure(failed, failedId);
    const replay = await cli(`${tag}-refusal-replay`, ["migrate", ...identity(source, failedId), "--to", unavailable, "--timeout-ms", "5000"], 4);
    assert.deepEqual(replay.operation, failed.operation);
    const conflict = await cli(`${tag}-conflict`, ["migrate", ...identity(source, failedId), "--to", target.address, "--timeout-ms", "5000"], 4);
    assert.equal(conflict.code, "OPERATION_CONFLICT");
    const stale = await cli(`${tag}-stale-epoch`, ["operation", "--node", source.address, "--operation-id", failedId, "--node-epoch", "0".repeat(32), "--timeout-ms", "5000"], 5);
    assert.equal(stale.code, "NODE_EPOCH_MISMATCH");

    const discardedId = `${tag}-discarded-acceptance`;
    await discardAcceptanceReply(source, { schema_version: 1, action: "migrate", node_epoch: source.epoch, operation_id: discardedId, target: unavailable });
    const recovered = await cli(`${tag}-discarded-reply-lookup`, ["operation", ...identity(source, discardedId), "--wait", "--timeout-ms", "5000"], 4);
    retainedFailure(recovered, discardedId);

    const migrationId = `${tag}-handoff`;
    const migrated = await cli(`${tag}-to-${target.runtime}`, ["migrate", ...identity(source, migrationId), "--to", target.address, "--timeout-ms", "15000"]);
    assert.equal(migrated.code, "MIGRATED");
    assert.equal(migrated.lifecycle, "retired");
    assert.equal(migrated.ownership, "retired");
    assert.equal(migrated.operation.state, "succeeded");
    assert.equal(migrated.operation.ownership, "retired");
    const lookup = await cli(`${tag}-successful-lookup`, ["operation", ...identity(source, migrationId), "--wait", "--timeout-ms", "5000"]);
    assert.deepEqual(lookup.operation, migrated.operation);
    const terminalReplay = await cli(`${tag}-terminal-replay`, ["migrate", ...identity(source, migrationId), "--to", target.address, "--timeout-ms", "5000"]);
    assert.deepEqual(terminalReplay.operation, migrated.operation);
    const destination = await cli(`${target.runtime}-received-status`, ["status", "--node", target.address, "--timeout-ms", "5000"]);
    assert.equal(destination.lifecycle, "running");
    assert.equal(destination.ownership, "retained");
    assert.equal(destination.node_epoch, target.epoch);
    results.push({ source: source.runtime, target: target.runtime, epoch: source.epoch, preflight: "PASS", failure_replay: "PASS", conflict: "PASS", stale_epoch: "PASS", discarded_reply_recovery: "PASS", migration: "MIGRATED", source_ownership: "retired", target_lifecycle: "running", terminal_replay: "PASS", legacy_status: "PASS" });
    console.log(`PASS ${source.runtime} → ${target.runtime}: inspect, refusal/replay, conflict, stale epoch, discarded reply lookup, confirmed handoff, terminal replay, legacy status`);
  }
  const original = servers[0];
  const history = await cli("returned-workload-old-operation", ["operation", ...identity(original, "wasmtime-handoff"), "--timeout-ms", "5000"]);
  assert.equal(history.lifecycle, "running");
  assert.equal(history.ownership, "retained");
  assert.equal(history.operation.ownership, "retired");
  assert.equal(history.operation.state, "succeeded");
  console.log("PASS round-trip history: original node runs returned workload; old handoff remains succeeded/retired in the same epoch");
}

console.log(`Control-interface artifacts: ${artifacts}`);
try {
  await main();
  await cleanup();
  writeFileSync(path.join(artifacts, "RESULTS.json"), JSON.stringify({ status: "PASS", routes: results, subprocesses_reaped: owned.size === 0 }, null, 2) + "\n");
  console.log("PASS all four runtime control workflows; all owned subprocesses reaped");
} catch (error) {
  await cleanup();
  writeFileSync(path.join(artifacts, "RESULTS.json"), JSON.stringify({ status: "FAIL", error: error.stack, routes: results, subprocesses_reaped: owned.size === 0 }, null, 2) + "\n");
  console.error(error.stack);
  process.exitCode = 1;
}
