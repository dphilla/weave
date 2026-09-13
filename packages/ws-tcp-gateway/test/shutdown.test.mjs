import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const childPath = fileURLToPath(new URL("./support/shutdown-child.mjs", import.meta.url));
const schedules = [
  "queued-manual", "queued-websocket", "error-only", "close-first",
  "observer-throws", "caller-listeners", "already-destroyed",
];

// An unhandled EventEmitter error must kill only this isolated regression
// child, never the test runner. Natural child exit also checks for live handles.
async function runChild(t, scenario) {
  const child = spawn(process.execPath, [childPath, scenario], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 10_000);
  t.after(() => {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  assert.equal(timedOut, false, `${scenario}: child did not exit naturally\n${stderr}`);
  assert.equal(result.signal, null, `${scenario}: unexpected signal\n${stderr}`);
  assert.equal(result.code, 0, `${scenario}: child failed\n${stderr}`);
  assert.deepEqual(JSON.parse(stdout), { scenario, passed: true });
}

for (const kind of ["passthrough", "socket"]) {
  for (const schedule of schedules) {
    test(`native shutdown: ${kind} ${schedule}`, { timeout: 15_000 }, (t) =>
      runChild(t, `${kind}:${schedule}`));
  }
}

for (const scenario of [
  "async-destroy:manual", "async-destroy:websocket", "async-destroy:timeout",
  "async-destroy:observer-throws", "emit-close-false:error", "emit-close-false:clean",
  "emit-close-false:async-error", "sync-duplex:clean", "sync-duplex:error",
  "silent-duplex:already-destroyed",
]) {
  test(`native shutdown: ${scenario}`, { timeout: 15_000 }, (t) => runChild(t, scenario));
}
