#!/usr/bin/env node
// Optional dependency-free two-tab Chrome round-trip. Node 22+ supplies the
// WebSocket client used for Chrome DevTools Protocol; no browser test package.

import fs from "node:fs";
import dgram from "node:dgram";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startServer } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const DEFAULT_WASM = path.join(REPO_ROOT, "target/demo-artifacts/browser-webrtc/counter.woven.wasm");
const DEFAULT_TIMEOUT_MS = 90_000;
const EMIT_PERIOD = 50_000;

function usage() {
  return `usage: node demos/browser-webrtc/e2e-smoke.mjs [options]

  --chrome PATH       Chrome/Chromium executable (or CHROME_BIN)
  --wasm PATH         woven counter fixture (or WEAVE_DEMO_WASM)
  --iterations N      counter iterations (default 2000000000)
  --timeout-ms N      timeout for each phase (default 90000)
  --artifacts PATH    save peer logs and screenshots
  --require           missing prerequisites fail instead of skip
  --keep-profile      retain Chrome's temporary profile
  --help              show this message`;
}

function parseOptions(argv) {
  const options = {
    chrome: process.env.CHROME_BIN ?? null,
    wasm: process.env.WEAVE_DEMO_WASM ?? DEFAULT_WASM,
    iterations: 2_000_000_000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    artifacts: process.env.WEAVE_CI_ARTIFACT_DIR ?? null,
    required: process.env.WEAVE_SMOKE_REQUIRED === "1",
    keepProfile: false,
    help: false,
  };
  const take = (index, flag) => {
    if (index + 1 >= argv.length) throw new Error(`${flag} requires a value`);
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--chrome": options.chrome = take(i, argv[i++]); break;
      case "--wasm": options.wasm = path.resolve(take(i, argv[i++])); break;
      case "--iterations": options.iterations = Number(take(i, argv[i++])); break;
      case "--timeout-ms": options.timeoutMs = Number(take(i, argv[i++])); break;
      case "--artifacts": options.artifacts = path.resolve(take(i, argv[i++])); break;
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
    throw new Error("--timeout-ms must be positive");
  }
  return options;
}

function executable(filename) {
  if (!filename) return false;
  try {
    fs.accessSync(filename, fs.constants.X_OK);
    return fs.statSync(filename).isFile();
  } catch { return false; }
}

function findOnPath(names) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of names) {
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

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

// Minimal RFC 8489 Binding responder for deterministic same-host ICE in the
// smoke test. It does not implement authentication, allocation, or relay.
async function startLoopbackStun() {
  const socket = dgram.createSocket("udp4");
  socket.on("message", (request, remote) => {
    if (request.length < 20 || request.readUInt16BE(0) !== 0x0001 || request.readUInt32BE(4) !== 0x2112a442) return;
    const response = Buffer.alloc(32);
    response.writeUInt16BE(0x0101, 0); // Binding Success Response
    response.writeUInt16BE(12, 2);
    response.writeUInt32BE(0x2112a442, 4);
    request.copy(response, 8, 8, 20);
    response.writeUInt16BE(0x0020, 20); // XOR-MAPPED-ADDRESS
    response.writeUInt16BE(8, 22);
    response[24] = 0;
    response[25] = 1; // IPv4
    response.writeUInt16BE(remote.port ^ 0x2112, 26);
    const address = remote.address.split(".").map(Number);
    for (let i = 0; i < 4; i++) response[28 + i] = address[i] ^ response[4 + i];
    socket.send(response, remote.port, remote.address);
  });
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      socket.off("error", reject);
      resolve();
    });
  });
  return {
    port: socket.address().port,
    close: () => new Promise((resolve) => socket.close(resolve)),
  };
}

async function waitFor(description, predicate, timeoutMs, details = () => "") {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(40);
  }
  const suffix = details();
  throw new Error(
    `timed out waiting for ${description}${lastError ? `; last error: ${lastError.message}` : ""}${suffix ? `\n${suffix}` : ""}`,
  );
}

function httpJson(url, { method = "GET", timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if ((response.statusCode ?? 500) >= 300) {
          reject(new Error(`${url} returned HTTP ${response.statusCode}: ${body}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(new Error(`invalid JSON from ${url}: ${error.message}`)); }
      });
    });
    request.once("timeout", () => request.destroy(new Error(`${url} timed out`)));
    request.once("error", reject);
    request.end();
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
    this.socket.addEventListener("message", (event) => this.message(event.data));
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP WebSocket closed"));
      }
      this.pending.clear();
    });
  }

  message(raw) {
    const message = JSON.parse(String(raw));
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
      this.exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
  }

  async command(method, params = {}) {
    await this.opened;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    }
    return response.result.value;
  }

  close() { try { this.socket.close(); } catch { /* already closed */ } }
}

const UI = `(() => ({
  ready: Boolean(document.querySelector('#runtime-state')),
  connection: document.querySelector('#connection-state')?.textContent ?? '',
  module: document.querySelector('#module-state')?.textContent ?? '',
  runtime: document.querySelector('#runtime-state')?.textContent ?? '',
  owner: document.querySelector('#metric-owner')?.textContent ?? '',
  path: document.querySelector('#metric-path')?.textContent ?? '',
  startDisabled: document.querySelector('#start-workload')?.disabled ?? true,
  migrateDisabled: document.querySelector('#migrate-workload')?.disabled ?? true,
  log: document.querySelector('#log')?.textContent ?? ''
}))()`;

async function snapshot(client) { return client.evaluate(UI); }

async function waitForUi(client, description, predicate, timeoutMs) {
  let last = null;
  return waitFor(
    description,
    async () => {
      last = await snapshot(client);
      return predicate(last) ? last : null;
    },
    timeoutMs,
    () => last ? JSON.stringify({ ...last, log: last.log.slice(-2500) }, null, 2) : "",
  );
}

async function click(client, id) {
  await client.evaluate(`(() => {
    const element = document.getElementById(${JSON.stringify(id)});
    if (!element) throw new Error('missing ${id}');
    if (element.disabled) throw new Error('${id} is disabled');
    element.click();
    return true;
  })()`);
}

function emitIndices(text) {
  return [...text.matchAll(/\bEMIT (-?\d+) (-?\d+)/g)].map((match) => Number(match[1]));
}

function lines(text) {
  const value = text.endsWith("\n") ? text.slice(0, -1) : text;
  return value ? value.split("\n") : [];
}

function firstAppendedEmit(before, after) {
  const oldLines = lines(before);
  const newLines = lines(after);
  let overlap = Math.min(oldLines.length, newLines.length);
  for (; overlap > 0; overlap--) {
    const start = oldLines.length - overlap;
    if (oldLines.slice(start).every((line, index) => line === newLines[index])) break;
  }
  if (oldLines.length && !overlap) throw new Error("peer log rotated past the ownership boundary");
  return emitIndices(newLines.slice(overlap).join("\n"))[0] ?? null;
}

function lastEmit(text, label) {
  const values = emitIndices(text);
  if (!values.length) throw new Error(`no EMIT values in ${label}`);
  return values[values.length - 1];
}

function assertNext(previous, next, direction) {
  if (next !== previous + EMIT_PERIOD) {
    throw new Error(`${direction} lost continuity: ${previous} -> ${next}`);
  }
  process.stdout.write(`ok: ${direction} continuity ${previous} -> ${next}\n`);
}

async function screenshot(client, filename) {
  const result = await client.command("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  await fs.promises.writeFile(filename, Buffer.from(result.data, "base64"));
}

function spawnManaged(command, args) {
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    // Chrome owns renderer/network descendants. A process group lets cleanup
    // terminate the whole disposable tree instead of only its browser parent.
    detached: process.platform !== "win32",
  });
  child.spawnError = null;
  child.on("error", (error) => { child.spawnError = error; });
  return child;
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const send = (signal) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // It may have exited between the state check and signal delivery.
    }
  };
  const waitForExit = (milliseconds) => Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(milliseconds).then(() => false),
  ]);
  send("SIGTERM");
  if (await waitForExit(2_000)) return;
  send("SIGKILL");
  await waitForExit(2_000);
}

let activeRun = null;
let terminatingSignal = null;

function reportCleanupFailures(label, results) {
  for (const result of results) {
    if (result.status === "rejected") {
      process.stderr.write(`cleanup warning (${label}): ${result.reason?.stack ?? result.reason}\n`);
    }
  }
}

async function saveArtifacts(resources) {
  if (!resources.artifacts) return;
  await fs.promises.mkdir(resources.artifacts, { recursive: true });
  const peerTasks = [["peer-a", resources.a], ["peer-b", resources.b]]
    .filter(([, client]) => client)
    .map(async ([name, client]) => {
      const final = await snapshot(client);
      await fs.promises.writeFile(path.join(resources.artifacts, `${name}.log`), final.log);
      await screenshot(client, path.join(resources.artifacts, `${name}.png`));
    });
  const results = await Promise.allSettled([
    ...peerTasks,
    fs.promises.writeFile(path.join(resources.artifacts, "chrome.log"), resources.chromeOutput),
  ]);
  reportCleanupFailures("artifacts", results);
}

async function cleanupRun(resources) {
  if (resources.cleanupPromise) return resources.cleanupPromise;
  resources.cleanupPromise = (async () => {
    // Capture page state before closing CDP or terminating Chrome. Artifact
    // failures are independent and must not prevent process/socket cleanup.
    await Promise.resolve().then(() => saveArtifacts(resources)).catch((error) => {
      process.stderr.write(`cleanup warning (artifacts): ${error.stack ?? error}\n`);
    });

    try { resources.a?.close(); } catch { /* already closed */ }
    try { resources.b?.close(); } catch { /* already closed */ }

    const shutdown = await Promise.allSettled([
      Promise.resolve().then(() => terminate(resources.chromeProcess)),
      Promise.resolve().then(() => resources.server?.close()),
      Promise.resolve().then(() => resources.stun?.close()),
    ]);
    reportCleanupFailures("services", shutdown);

    if (resources.profile && !resources.keepProfile) {
      const removed = await Promise.allSettled([
        fs.promises.rm(resources.profile, { recursive: true, force: true }),
      ]);
      reportCleanupFailures("profile", removed);
    } else if (resources.profile && resources.keepProfile) {
      process.stdout.write(`Chrome profile retained at ${resources.profile}\n`);
    }
  })();
  return resources.cleanupPromise;
}

async function run(options, chrome) {
  const artifacts = options.artifacts ? path.resolve(options.artifacts) : null;
  const resources = {
    profile: null,
    artifacts,
    keepProfile: options.keepProfile,
    stun: null,
    server: null,
    chromeProcess: null,
    chromeOutput: "",
    a: null,
    b: null,
    cleanupPromise: null,
  };
  activeRun = resources;
  let profile = null;
  let stun = null;
  let server = null;
  let chromeProcess = null;
  let chromeOutput = "";
  let a = null;
  let b = null;
  try {
    profile = resources.profile = await fs.promises.mkdtemp(path.join(os.tmpdir(), "weave-browser-peer-"));
    if (artifacts) await fs.promises.mkdir(artifacts, { recursive: true });
    stun = resources.stun = await startLoopbackStun();
    const token = "e2e_access_0123456789abcdef0123456789abcdef";
    server = resources.server = await startServer({
      host: "127.0.0.1",
      port: 0,
      wasmPath: options.wasm,
      token,
      iceServers: [{ urls: `stun:127.0.0.1:${stun.port}` }],
    });
    const base = `http://127.0.0.1:${server.address.port}/`;
    const room = "e2e_0123456789abcdef0123456789abcdef";
    const peerAUrl = `${base}#room=${room}&peer=a&token=${token}`;
    const peerBUrl = `${base}#room=${room}&peer=b&token=${token}`;
    chromeProcess = resources.chromeProcess = spawnManaged(chrome, [
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
      // Isolated headless profiles on macOS cannot resolve Chrome's generated
      // .local host-candidate names. Normal interactive profiles can; expose
      // literal loopback candidates only inside this disposable smoke profile.
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--allow-loopback-in-peer-connection",
      peerAUrl,
    ]);
    const appendChromeOutput = (chunk) => {
      chromeOutput += chunk;
      resources.chromeOutput = chromeOutput;
    };
    chromeProcess.stdout?.on("data", appendChromeOutput);
    chromeProcess.stderr?.on("data", appendChromeOutput);

    const activePortPath = path.join(profile, "DevToolsActivePort");
    const devtoolsPort = await waitFor("Chrome DevTools endpoint", async () => {
      if (chromeProcess.spawnError) throw chromeProcess.spawnError;
      if (chromeProcess.exitCode !== null) throw new Error(`Chrome exited ${chromeProcess.exitCode}`);
      try {
        const port = Number((await fs.promises.readFile(activePortPath, "utf8")).split(/\r?\n/)[0]);
        return Number.isSafeInteger(port) && port > 0 ? port : null;
      } catch { return null; }
    }, options.timeoutMs, () => chromeOutput.slice(-3000));

    const pageA = await waitFor("peer A page", async () => {
      const pages = await httpJson(`http://127.0.0.1:${devtoolsPort}/json/list`);
      return pages.find((page) => page.type === "page" && page.url.includes("peer=a"));
    }, options.timeoutMs);
    const pageB = await httpJson(
      `http://127.0.0.1:${devtoolsPort}/json/new?${encodeURIComponent(peerBUrl)}`,
      { method: "PUT" },
    );
    a = resources.a = new CdpClient(pageA.webSocketDebuggerUrl, Math.min(options.timeoutMs, 15_000));
    b = resources.b = new CdpClient(pageB.webSocketDebuggerUrl, Math.min(options.timeoutMs, 15_000));
    await Promise.all([a.opened, b.opened]);
    for (const client of [a, b]) {
      await client.command("Runtime.enable");
      await client.command("Page.enable");
    }

    try {
      await Promise.all([
        waitForUi(a, "peer A WebRTC connection", (ui) => ui.connection === "connected" && ui.module === "woven module" && !ui.startDisabled, options.timeoutMs),
        waitForUi(b, "peer B WebRTC connection", (ui) => ui.connection === "connected" && ui.module === "woven module", options.timeoutMs),
      ]);
    } catch (error) {
      const peerA = await snapshot(a);
      const peerB = await snapshot(b);
      const queuedForB = await b.evaluate(`fetch('/v1/signal/${room}/b?after=0', {
          headers: {authorization: 'Bearer ${token}'}
        })
        .then(async response => ({status: response.status, body: await response.text()}))`);
      throw new Error(`${error.message}\npeer A: ${JSON.stringify(peerA, null, 2)}\npeer B: ${JSON.stringify(peerB, null, 2)}\nqueued for B: ${JSON.stringify(queuedForB)}`);
    }
    await a.evaluate(`document.getElementById('entry-args').value = ${JSON.stringify(String(options.iterations))}`);

    process.stdout.write("phase 1/2: peer A -> peer B\n");
    await click(a, "start-workload");
    await waitForUi(a, "peer A running", (ui) => ui.runtime === "running" && !ui.migrateDisabled && emitIndices(ui.log).length >= 2, options.timeoutMs);
    await click(a, "migrate-workload");
    const [aMigrated, bRunning] = await Promise.all([
      waitForUi(a, "peer A retirement", (ui) => ui.runtime === "migrated" && ui.log.includes("migration committed"), options.timeoutMs),
      waitForUi(b, "peer B ownership", (ui) => ui.runtime === "running" && ui.log.includes("accepted and verified workload") && emitIndices(ui.log).length >= 1, options.timeoutMs),
    ]);
    assertNext(lastEmit(aMigrated.log, "peer A source"), emitIndices(bRunning.log)[0], "peer A -> peer B");

    process.stdout.write("phase 2/2: peer B -> peer A\n");
    const aBeforeReturn = aMigrated.log;
    await waitForUi(b, "peer B migration control", (ui) => ui.runtime === "running" && !ui.migrateDisabled && emitIndices(ui.log).length >= 2, options.timeoutMs);
    await click(b, "migrate-workload");
    const [bMigrated, aRunning] = await Promise.all([
      waitForUi(b, "peer B retirement", (ui) => ui.runtime === "migrated" && ui.log.includes("migration committed"), options.timeoutMs),
      waitForUi(a, "peer A resumed ownership", (ui) => ui.runtime === "running" && ui.log.includes("accepted and verified workload") && firstAppendedEmit(aBeforeReturn, ui.log) !== null, options.timeoutMs),
    ]);
    assertNext(
      lastEmit(bMigrated.log, "peer B source"),
      firstAppendedEmit(aBeforeReturn, aRunning.log),
      "peer B -> peer A",
    );

    await waitForUi(a, "selected ICE path", (ui) => ui.path !== "not selected", options.timeoutMs);
    if (a.exceptions.length || b.exceptions.length) {
      throw new Error(`browser exceptions:\nA: ${a.exceptions.join("\n")}\nB: ${b.exceptions.join("\n")}`);
    }
    process.stdout.write("PASS: browser A -> browser B -> browser A preserved exact EMIT continuity over WebRTC\n");
  } finally {
    resources.chromeOutput = chromeOutput;
    await cleanupRun(resources);
    if (activeRun === resources) activeRun = null;
  }
}

async function main() {
  let options;
  try { options = parseOptions(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const chrome = findChrome(options.chrome);
  const missing = [];
  if (typeof globalThis.WebSocket !== "function") missing.push("Node 22+ with built-in WebSocket");
  if (!chrome) missing.push(options.chrome ? `Chrome at ${options.chrome}` : "Chrome/Chromium");
  if (!fs.existsSync(options.wasm)) missing.push(`woven module at ${options.wasm}`);
  if (missing.length) {
    const message = `browser-webrtc smoke prerequisites unavailable: ${missing.join(", ")}`;
    if (options.required) throw new Error(message);
    process.stdout.write(`SKIP: ${message}\n`);
    return;
  }
  await run(options, chrome);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (terminatingSignal) return;
    terminatingSignal = signal;
    const code = 128 + (signal === "SIGINT" ? 2 : 15);
    const cleanup = activeRun ? cleanupRun(activeRun) : Promise.resolve();
    void cleanup.finally(() => process.exit(code));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(async (error) => {
    process.stderr.write(`FAIL: ${error.stack ?? error}\n`);
    process.exitCode = 1;
    if (activeRun) await cleanupRun(activeRun);
  });
}
