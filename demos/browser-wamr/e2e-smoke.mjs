#!/usr/bin/env node
// Optional, dependency-free Chrome -> WAMR -> Chrome -> WAMR smoke test.
//
// This launches the real demo UI in headless Chrome and controls it through
// the Chrome DevTools Protocol. It intentionally requires Node's built-in
// WebSocket client (Node 22+) instead of bringing in a browser automation
// dependency.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseArgs as parseRelayArgs, startRelay } from "./relay.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const DEFAULT_WAMR = path.join(REPO_ROOT, "wamr/target/debug/weave-wamr");
const DEFAULT_WASM = path.join(HERE, "counter.woven.wasm");
const DEFAULT_TIMEOUT_MS = 90_000;
const EMIT_PERIOD = 50_000;

function usage() {
  return `usage: node demos/browser-wamr/e2e-smoke.mjs [options]

  --chrome PATH          Chrome/Chromium executable (or CHROME_BIN)
  --wamr PATH            weave-wamr executable (or WAMR_BIN)
  --wasm PATH            woven counter fixture (or WEAVE_DEMO_WASM)
  --iterations N         counter iterations (default 2000000000)
  --timeout-ms N         timeout for each phase (default 90000)
  --require              missing prerequisites are failures instead of skips
  --keep-profile         retain Chrome's temporary profile for debugging
  --help                 show this message

The default artifact paths are:
  ${DEFAULT_WAMR}
  ${DEFAULT_WASM}`;
}

function parseOptions(argv) {
  const options = {
    chrome: process.env.CHROME_BIN ?? null,
    wamr: process.env.WAMR_BIN ?? DEFAULT_WAMR,
    wasm: process.env.WEAVE_DEMO_WASM ?? DEFAULT_WASM,
    iterations: 2_000_000_000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    required: process.env.WEAVE_SMOKE_REQUIRED === "1",
    keepProfile: false,
    help: false,
  };
  const value = (index, flag) => {
    if (index + 1 >= argv.length) throw new Error(`${flag} requires a value`);
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--chrome": options.chrome = value(i, argv[i++]); break;
      case "--wamr": options.wamr = value(i, argv[i++]); break;
      case "--wasm": options.wasm = value(i, argv[i++]); break;
      case "--iterations": options.iterations = Number(value(i, argv[i++])); break;
      case "--timeout-ms": options.timeoutMs = Number(value(i, argv[i++])); break;
      case "--require": options.required = true; break;
      case "--keep-profile": options.keepProfile = true; break;
      case "--help": options.help = true; break;
      default: throw new Error(`unknown option: ${argv[i]}`);
    }
  }
  if (!Number.isSafeInteger(options.iterations) || options.iterations <= 0 || options.iterations > 0x7fffffff) {
    throw new Error("--iterations must be an integer between 1 and 2147483647");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }
  return options;
}

function executable(filename) {
  if (!filename) return false;
  try {
    fs.accessSync(filename, fs.constants.X_OK);
    return fs.statSync(filename).isFile();
  } catch {
    return false;
  }
}

function findOnPath(names) {
  const directories = (process.env.PATH ?? "").split(path.delimiter);
  for (const name of names) {
    for (const directory of directories) {
      const candidate = path.join(directory, name);
      if (executable(candidate)) return candidate;
    }
  }
  return null;
}

function findChrome(explicit) {
  if (explicit) return executable(explicit) ? explicit : null;
  const fixed = process.platform === "darwin"
    ? [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    : process.platform === "win32"
      ? [
        path.join(process.env.PROGRAMFILES ?? "", "Google/Chrome/Application/chrome.exe"),
        path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Google/Chrome/Application/chrome.exe"),
      ]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return fixed.find(executable) ?? findOnPath(
    process.platform === "win32"
      ? ["chrome.exe", "chromium.exe"]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"],
  );
}

function missingPrerequisites(options) {
  const missing = [];
  if (typeof globalThis.WebSocket !== "function") missing.push("Node 22+ with built-in WebSocket");
  const chrome = findChrome(options.chrome);
  if (!chrome) missing.push(options.chrome ? `executable Chrome at ${options.chrome}` : "Chrome/Chromium");
  if (!executable(options.wamr)) missing.push(`built weave-wamr at ${options.wamr}`);
  if (!fs.existsSync(options.wasm)) missing.push(`woven demo module at ${options.wasm}`);
  return { missing, chrome };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class ProcessLog {
  constructor(name, child, { echo = false } = {}) {
    this.name = name;
    this.child = child;
    this.lines = [];
    this.partial = { stdout: "", stderr: "" };
    this.echo = echo;
    this._attach("stdout", child.stdout);
    this._attach("stderr", child.stderr);
  }

  _attach(streamName, stream) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk) => {
      const text = this.partial[streamName] + chunk;
      const parts = text.split(/\r?\n/);
      this.partial[streamName] = parts.pop();
      for (const line of parts) {
        this.lines.push({ stream: streamName, line, time: Date.now() });
        if (this.echo && !line.startsWith("EMIT ")) {
          process.stderr.write(`[${this.name}:${streamName}] ${line}\n`);
        }
      }
    });
  }

  text(stream = null, start = 0) {
    return this.lines
      .slice(start)
      .filter((entry) => stream === null || entry.stream === stream)
      .map((entry) => entry.line)
      .join("\n");
  }
}

const managedChildren = new Set();

function spawnManaged(name, command, args, options = {}) {
  const detached = process.platform !== "win32";
  const { echo = false, ...spawnOptions } = options;
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached,
    ...spawnOptions,
  });
  child.spawnError = null;
  child.on("error", (error) => { child.spawnError = error; });
  managedChildren.add(child);
  child.once("exit", () => managedChildren.delete(child));
  const log = new ProcessLog(name, child, { echo });
  return { child, log };
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const signal = (name) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      // It may have exited between the state check and kill.
    }
  };
  signal("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(2_000).then(() => false),
  ]);
  if (!exited) signal("SIGKILL");
}

async function waitFor(description, predicate, timeoutMs, details = () => "") {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(40);
  }
  const suffix = details();
  const cause = lastError ? `; last error: ${lastError.message}` : "";
  throw new Error(`timed out waiting for ${description}${cause}${suffix ? `\n${suffix}` : ""}`);
}

async function waitForProcess(description, processLog, predicate, start, timeoutMs) {
  return waitFor(
    description,
    async () => {
      const match = processLog.lines.slice(start).find(predicate);
      if (match) return match;
      if (processLog.child.spawnError) throw processLog.child.spawnError;
      if (processLog.child.exitCode !== null) {
        throw new Error(`${processLog.name} exited with ${processLog.child.exitCode}`);
      }
      return null;
    },
    timeoutMs,
    () => processLog.text(null, Math.max(0, processLog.lines.length - 30)),
  );
}

async function runCommand(name, command, args, timeoutMs) {
  const { child, log } = spawnManaged(name, command, args, { echo: true });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    const result = await Promise.race([
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }),
      timeout,
    ]);
    if (result.code !== 0) {
      throw new Error(`${name} exited with ${result.code ?? result.signal}\n${log.text()}`);
    }
    return log;
  } finally {
    clearTimeout(timer);
    await terminate(child);
  }
}

function httpJson(url, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`${url} returned HTTP ${response.statusCode}: ${body}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(new Error(`invalid JSON from ${url}: ${error.message}`)); }
      });
    });
    request.once("timeout", () => request.destroy(new Error(`${url} timed out`)));
    request.once("error", reject);
  });
}

class CdpClient {
  constructor(url, timeoutMs) {
    this.socket = new WebSocket(url);
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.exceptions = [];
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed to open")), { once: true });
    });
    this.socket.addEventListener("message", (event) => this._message(event.data));
    this.socket.addEventListener("close", () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("CDP WebSocket closed"));
      }
      this.pending.clear();
    });
  }

  _message(data) {
    const message = JSON.parse(String(data));
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`CDP ${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      this.exceptions.push(message.params.exceptionDetails.text);
    }
  }

  async command(method, params = {}) {
    await this.opened;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`browser evaluation failed: ${detail}`);
    }
    return result.result.value;
  }

  close() {
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

const UI_SNAPSHOT = `(() => ({
  ready: Boolean(document.querySelector('#runtime-state')),
  relay: document.querySelector('#relay-health')?.textContent ?? '',
  module: document.querySelector('#module-state')?.textContent ?? '',
  runtime: document.querySelector('#runtime-state')?.textContent ?? '',
  location: document.querySelector('#metric-location')?.textContent ?? '',
  migrateDisabled: document.querySelector('#migrate-browser')?.disabled ?? true,
  log: document.querySelector('#log')?.textContent ?? ''
}))()`;

async function snapshot(cdp) {
  return cdp.evaluate(UI_SNAPSHOT);
}

async function waitForUi(cdp, description, predicate, timeoutMs) {
  let last = null;
  return waitFor(
    description,
    async () => {
      last = await snapshot(cdp);
      return predicate(last) ? last : null;
    },
    timeoutMs,
    () => last ? JSON.stringify({ ...last, log: last.log.slice(-2_000) }, null, 2) : "",
  );
}

async function click(cdp, id) {
  return cdp.evaluate(`(() => {
    const element = document.getElementById(${JSON.stringify(id)});
    if (!element) throw new Error('missing element ${id}');
    if (element.disabled) throw new Error('element ${id} is disabled');
    element.click();
    return true;
  })()`);
}

async function chooseFile(cdp, selector, filename) {
  const { root } = await cdp.command("DOM.getDocument", { depth: 1, pierce: true });
  const { nodeId } = await cdp.command("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
  if (!nodeId) throw new Error(`browser file input not found: ${selector}`);
  await cdp.command("DOM.setFileInputFiles", {
    nodeId,
    files: [path.resolve(filename)],
  });
}

function emitIndices(text) {
  return [...text.matchAll(/\bEMIT (-?\d+) (-?\d+)/g)].map((match) => Number(match[1]));
}

function logLines(text) {
  const withoutTrailingNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  return withoutTrailingNewline.length === 0 ? [] : withoutTrailingNewline.split("\n");
}

// The UI keeps only its newest 500 lines. Locate the exact logical append
// boundary by matching the old log's longest suffix to the new log's prefix;
// a raw character/count offset would drift whenever old lines are evicted.
export function firstAppendedEmit(previousLog, currentLog) {
  const previous = logLines(previousLog);
  const current = logLines(currentLog);
  let overlap = Math.min(previous.length, current.length);
  for (; overlap > 0; overlap--) {
    const previousStart = previous.length - overlap;
    let matches = true;
    for (let i = 0; i < overlap; i++) {
      if (previous[previousStart + i] !== current[i]) {
        matches = false;
        break;
      }
    }
    if (matches) break;
  }
  if (previous.length > 0 && overlap === 0) {
    throw new Error("browser log rotated past the pre-arm continuity position");
  }
  return emitIndices(current.slice(overlap).join("\n"))[0] ?? null;
}

function stdoutEmitIndices(log, start = 0) {
  return log.lines
    .slice(start)
    .filter(({ stream, line }) => stream === "stdout" && /^EMIT -?\d+ -?\d+$/.test(line))
    .map(({ line }) => Number(line.split(" ")[1]));
}

function last(values, label) {
  if (values.length === 0) throw new Error(`no EMIT values observed for ${label}`);
  return values[values.length - 1];
}

function assertNext(previous, next, direction) {
  if (next !== previous + EMIT_PERIOD) {
    throw new Error(`${direction} lost continuity: last source EMIT was ${previous}, first target EMIT was ${next}`);
  }
  process.stdout.write(`ok: ${direction} continuity ${previous} -> ${next}\n`);
}

async function waitForDevtoolsPort(profile, chromeLog, timeoutMs) {
  const activePort = path.join(profile, "DevToolsActivePort");
  return waitFor(
    "Chrome DevTools endpoint",
    async () => {
      if (chromeLog.child.exitCode !== null) throw new Error(`Chrome exited with ${chromeLog.child.exitCode}`);
      if (chromeLog.child.spawnError) throw chromeLog.child.spawnError;
      try {
        const [port] = fs.readFileSync(activePort, "utf8").trim().split(/\r?\n/);
        const value = Number(port);
        return Number.isSafeInteger(value) && value > 0 ? value : null;
      } catch {
        return null;
      }
    },
    timeoutMs,
    () => chromeLog.text(null, Math.max(0, chromeLog.lines.length - 30)),
  );
}

async function waitForPage(port, pageUrl, timeoutMs) {
  return waitFor(
    "demo DevTools page",
    async () => {
      const pages = await httpJson(`http://127.0.0.1:${port}/json/list`);
      return pages.find((page) => page.type === "page" && page.url.startsWith(pageUrl));
    },
    timeoutMs,
  );
}

let cleanupPromise = null;
let relay = null;
let cdp = null;
let profile = null;
let keepProfile = false;

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    cdp?.close();
    if (relay) await relay.close();
    await Promise.all([...managedChildren].map(terminate));
    if (profile && !keepProfile) {
      await fs.promises.rm(profile, { recursive: true, force: true });
    }
  })();
  return cleanupPromise;
}

async function run(options, chrome) {
  keepProfile = options.keepProfile;
  profile = await fs.promises.mkdtemp(path.join(os.tmpdir(), "weave-chrome-smoke-"));

  const wamr = spawnManaged("wamr", options.wamr, ["serve", "--listen", "127.0.0.1:0"], { echo: true });
  const listening = await waitForProcess(
    "WAMR listener",
    wamr.log,
    ({ line }) => /weave-wamr: listening on 127\.0\.0\.1:(\d+)/.test(line),
    0,
    options.timeoutMs,
  );
  const wamrPort = Number(listening.line.match(/:(\d+)$/)[1]);

  const relayConfig = parseRelayArgs([
    "--http", "127.0.0.1:0",
    "--ingress", "127.0.0.1:0",
    "--target", `wamr=127.0.0.1:${wamrPort}`,
    "--pair-timeout-ms", String(options.timeoutMs),
    "--connect-timeout-ms", String(Math.min(options.timeoutMs, 10_000)),
  ]);
  relay = await startRelay(relayConfig);
  const relayPort = relay.addresses.http.port;
  const ingressPort = relay.addresses.ingress.port;
  const pageUrl = `http://127.0.0.1:${relayPort}/`;

  const chromeProcess = spawnManaged("chrome", chrome, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-dev-shm-usage",
    pageUrl,
  ]);
  const devtoolsPort = await waitForDevtoolsPort(profile, chromeProcess.log, options.timeoutMs);
  const page = await waitForPage(devtoolsPort, pageUrl, options.timeoutMs);
  cdp = new CdpClient(page.webSocketDebuggerUrl, Math.min(options.timeoutMs, 15_000));
  await cdp.opened;
  await cdp.command("Runtime.enable");
  await cdp.command("Page.enable");
  await cdp.command("DOM.enable");

  await waitForUi(cdp, "initialized demo UI", (ui) => ui.ready && ui.relay === "relay ready", options.timeoutMs);
  await chooseFile(cdp, "#module-file", options.wasm);
  await waitForUi(cdp, "woven demo module", (ui) => ui.module === "woven module", options.timeoutMs);
  await cdp.evaluate(`document.getElementById('entry-args').value = ${JSON.stringify(String(options.iterations))}`);

  process.stdout.write("phase 1/3: Chrome -> WAMR\n");
  await click(cdp, "start-browser");
  await waitForUi(cdp, "browser workload", (ui) => ui.runtime === "running" && !ui.migrateDisabled, options.timeoutMs);
  const firstWamrMark = wamr.log.lines.length;
  await click(cdp, "migrate-browser");
  const firstCommit = await waitForUi(
    cdp,
    "first browser migration commit",
    (ui) => ui.runtime === "migrated" && ui.log.includes("migration committed"),
    options.timeoutMs,
  );
  const browserFirstLast = last(emitIndices(firstCommit.log), "first Chrome source phase");
  await waitForProcess(
    "WAMR to receive the first browser workload",
    wamr.log,
    ({ line }) => line.includes("workload received from chrome"),
    firstWamrMark,
    options.timeoutMs,
  );
  const firstWamrEmit = await waitFor(
    "the first WAMR EMIT after Chrome",
    async () => stdoutEmitIndices(wamr.log, firstWamrMark)[0] ?? null,
    options.timeoutMs,
    () => wamr.log.text(null, firstWamrMark),
  );
  assertNext(browserFirstLast, firstWamrEmit, "Chrome -> WAMR");

  process.stdout.write("phase 2/3: WAMR -> Chrome\n");
  const browserPreArmLog = (await snapshot(cdp)).log;
  await click(cdp, "arm-target");
  await waitForUi(cdp, "armed browser target", (ui) => ui.runtime === "armed", options.timeoutMs);
  await waitFor(
    "relay browser-target registration",
    async () => (await httpJson(`${pageUrl}v1/config`)).waitingBrowsers === 1,
    options.timeoutMs,
  );
  await runCommand(
    "wamr-migrate-to-browser",
    options.wamr,
    ["migrate", "--node", `127.0.0.1:${wamrPort}`, "--to", `127.0.0.1:${ingressPort}`],
    options.timeoutMs,
  );
  // Include WAMR's whole ownership interval. It may reach the migration poll
  // immediately after the browser is armed and emit nothing between the arm
  // click and stop-and-copy.
  const wamrSourceEmits = stdoutEmitIndices(wamr.log, firstWamrMark);
  const wamrSourceLast = last(wamrSourceEmits, "WAMR source phase");
  const browserResume = await waitForUi(
    cdp,
    "browser resume from WAMR",
    (ui) => ui.runtime === "running" && ui.log.includes("accepted, committed, and verified workload from wamr"),
    options.timeoutMs,
  );
  // Continuity is defined by the first browser emission appended after the
  // target was armed. Do not skip a duplicate to find a later plausible value:
  // that would hide a replay at the ownership boundary.
  const firstBrowserAfterWamr = firstAppendedEmit(browserPreArmLog, browserResume.log) ??
    await waitFor(
      "the first browser EMIT after WAMR",
      async () => {
        const log = (await snapshot(cdp)).log;
        return firstAppendedEmit(browserPreArmLog, log);
      },
      options.timeoutMs,
    );
  assertNext(wamrSourceLast, firstBrowserAfterWamr, "WAMR -> Chrome");

  process.stdout.write("phase 3/3: Chrome -> WAMR\n");
  const finalWamrMark = wamr.log.lines.length;
  await click(cdp, "migrate-browser");
  const finalCommit = await waitForUi(
    cdp,
    "final browser migration commit",
    (ui) => ui.runtime === "migrated" && ui.log.includes("migration committed"),
    options.timeoutMs,
  );
  const browserFinalLast = last(
    emitIndices(finalCommit.log).filter((value) => value >= firstBrowserAfterWamr),
    "second Chrome source phase",
  );
  await waitForProcess(
    "WAMR to receive the final browser workload",
    wamr.log,
    ({ line }) => line.includes("workload received from chrome"),
    finalWamrMark,
    options.timeoutMs,
  );
  const finalWamrEmit = await waitFor(
    "the first final WAMR EMIT",
    async () => stdoutEmitIndices(wamr.log, finalWamrMark)[0] ?? null,
    options.timeoutMs,
    () => wamr.log.text(null, finalWamrMark),
  );
  assertNext(browserFinalLast, finalWamrEmit, "Chrome -> WAMR (return)");

  const status = await runCommand(
    "wamr-status",
    options.wamr,
    ["status", "--node", `127.0.0.1:${wamrPort}`],
    options.timeoutMs,
  );
  if (!/^ok: running/m.test(status.text("stdout"))) {
    throw new Error(`WAMR was not running after final handoff:\n${status.text()}`);
  }
  const receives = wamr.log.lines.filter(({ line }) => line.includes("workload received from chrome")).length;
  if (receives < 2) throw new Error(`expected two Chrome -> WAMR receives, saw ${receives}`);
  if (cdp.exceptions.length > 0) throw new Error(`browser exceptions:\n${cdp.exceptions.join("\n")}`);

  process.stdout.write("PASS: Chrome -> WAMR -> Chrome -> WAMR preserved the EMIT sequence and UI migration states\n");
}

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const { missing, chrome } = missingPrerequisites(options);
  if (missing.length > 0) {
    const message = `browser-wamr smoke prerequisites unavailable: ${missing.join(", ")}`;
    if (options.required) throw new Error(message);
    process.stdout.write(`SKIP: ${message}\n`);
    return;
  }

  try {
    await run(options, chrome);
  } finally {
    await cleanup();
    if (options.keepProfile && profile) process.stdout.write(`Chrome profile retained at ${profile}\n`);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(128 + (signal === "SIGINT" ? 2 : 15)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(async (error) => {
    process.stderr.write(`FAIL: ${error.stack ?? error}\n`);
    process.exitCode = 1;
    await cleanup();
  });
}
