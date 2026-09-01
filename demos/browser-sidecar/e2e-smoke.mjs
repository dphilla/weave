#!/usr/bin/env node
// Real Chrome/V8 -> Go/Pion sidecar -> unmodified Wasmtime TCP node -> same
// sidecar -> Chrome/V8 continuity smoke. Node 22+ supplies the CDP WebSocket.

import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ProcessLog, startDemo } from "./controller.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const DEFAULT_TIMEOUT_MS = 90_000;
const EMIT_PERIOD = 50_000;

function usage() {
  return `usage: node demos/browser-sidecar/e2e-smoke.mjs [options]

  --chrome PATH       Chrome/Chromium executable (or CHROME_BIN)
  --sidecar PATH      weave-rtc executable (or WEBRTC_SIDECAR_BIN)
  --weave PATH        weave executable (or WEAVE_BIN)
  --wasm PATH         woven counter fixture (or WEAVE_DEMO_WASM)
  --iterations N      counter iterations (default 2000000000)
  --timeout-ms N      timeout for each phase (default 90000)
  --artifacts PATH    save logs, screenshot, and result JSON
  --require           missing prerequisites fail instead of skip
  --keep-profile      retain Chrome's temporary profile
  --help              show this message`;
}

function parseOptions(argv) {
  const options = {
    chrome: process.env.CHROME_BIN ?? null,
    sidecar: process.env.WEBRTC_SIDECAR_BIN ?? path.join(REPO_ROOT, "target/demo-artifacts/browser-sidecar/weave-rtc"),
    weave: process.env.WEAVE_BIN ?? path.join(REPO_ROOT, "target/release/weave"),
    wasm: process.env.WEAVE_DEMO_WASM ?? path.join(REPO_ROOT, "target/demo-artifacts/browser-sidecar/counter.woven.wasm"),
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
      case "--sidecar": options.sidecar = path.resolve(take(i, argv[i++])); break;
      case "--weave": options.weave = path.resolve(take(i, argv[i++])); break;
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
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
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

function missingPrerequisites(options) {
  const missing = [];
  if (typeof globalThis.WebSocket !== "function") missing.push("Node 22+ with built-in WebSocket");
  const chrome = findChrome(options.chrome);
  if (!chrome) missing.push(options.chrome ? `executable Chrome at ${options.chrome}` : "Chrome/Chromium");
  if (!executable(options.sidecar)) missing.push(`built weave-rtc at ${options.sidecar}`);
  if (!executable(options.weave)) missing.push(`built weave at ${options.weave}`);
  if (!fs.existsSync(options.wasm)) missing.push(`woven module at ${options.wasm}`);
  return { missing, chrome };
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function startLoopbackStun() {
  const socket = dgram.createSocket("udp4");
  socket.on("message", (request, remote) => {
    if (request.length < 20 || request.readUInt16BE(0) !== 0x0001 || request.readUInt32BE(4) !== 0x2112a442) return;
    const response = Buffer.alloc(32);
    response.writeUInt16BE(0x0101, 0);
    response.writeUInt16BE(12, 2);
    response.writeUInt32BE(0x2112a442, 4);
    request.copy(response, 8, 8, 20);
    response.writeUInt16BE(0x0020, 20);
    response.writeUInt16BE(8, 22);
    response[24] = 0;
    response[25] = 1;
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
  armDisabled: document.querySelector('#arm-target')?.disabled ?? true,
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
    () => last ? JSON.stringify({ ...last, log: last.log.slice(-3_000) }, null, 2) : "",
  );
}

async function click(client, id) {
  return client.evaluate(`(() => {
    const element = document.getElementById(${JSON.stringify(id)});
    if (!element) throw new Error('missing element ${id}');
    if (element.disabled) throw new Error('element ${id} is disabled');
    element.click();
    return true;
  })()`);
}

function logLines(text) {
  const value = text.endsWith("\n") ? text.slice(0, -1) : text;
  return value ? value.split("\n") : [];
}

function emitIndices(text) {
  return [...text.matchAll(/\bEMIT (-?\d+) (-?\d+)/g)].map((match) => Number(match[1]));
}

function firstAppendedEmit(previousLog, currentLog) {
  const previous = logLines(previousLog);
  const current = logLines(currentLog);
  let overlap = Math.min(previous.length, current.length);
  for (; overlap > 0; overlap--) {
    const previousStart = previous.length - overlap;
    if (previous.slice(previousStart).every((line, index) => line === current[index])) break;
  }
  if (previous.length > 0 && overlap === 0) {
    throw new Error("browser log rotated past the pre-return continuity position");
  }
  return emitIndices(current.slice(overlap).join("\n"))[0] ?? null;
}

function nativeEmits(log, start = 0) {
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

function mappingStatus(status, mapping) {
  return status?.channels?.find((channel) => channel.mapping === mapping) ?? null;
}

async function waitForDevtoolsPort(profile, chromeLog, timeoutMs) {
  const activePort = path.join(profile, "DevToolsActivePort");
  return waitFor(
    "Chrome DevTools endpoint",
    () => {
      if (chromeLog.child.spawnError) throw chromeLog.child.spawnError;
      if (chromeLog.child.exitCode !== null) throw new Error(`Chrome exited with ${chromeLog.child.exitCode}`);
      try {
        const [raw] = fs.readFileSync(activePort, "utf8").trim().split(/\r?\n/);
        const port = Number(raw);
        return Number.isSafeInteger(port) && port > 0 ? port : null;
      } catch { return null; }
    },
    timeoutMs,
    () => chromeLog.text(null, Math.max(0, chromeLog.lines.length - 30)),
  );
}

async function waitForPage(port, pageUrl, timeoutMs) {
  return waitFor(
    "sidecar demo DevTools page",
    async () => {
      const pages = await httpJson(`http://127.0.0.1:${port}/json/list`);
      return pages.find((page) => page.type === "page" && page.url.startsWith(pageUrl));
    },
    timeoutMs,
  );
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const signal = (name) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch { /* exited concurrently */ }
  };
  signal("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(2_000).then(() => false),
  ]);
  if (!exited) signal("SIGKILL");
}

async function writeArtifacts(directory, values) {
  if (!directory) return;
  await fs.promises.mkdir(directory, { recursive: true });
  const writes = [];
  if (values.browserLog !== null) writes.push(fs.promises.writeFile(path.join(directory, "browser.log"), values.browserLog));
  if (values.chromeLog) writes.push(fs.promises.writeFile(path.join(directory, "chrome.log"), values.chromeLog));
  if (values.demo) {
    writes.push(fs.promises.writeFile(path.join(directory, "native.log"), `${values.demo.native.log.text()}\n`));
    writes.push(fs.promises.writeFile(path.join(directory, "sidecar-control.ndjson"), `${values.demo.sidecar.protocolText()}\n`));
    writes.push(fs.promises.writeFile(path.join(directory, "sidecar.stderr.log"), `${values.demo.sidecar.stderr.text("stderr")}\n`));
    if (values.demo.returnLog) {
      writes.push(fs.promises.writeFile(path.join(directory, "return-command.log"), `${values.demo.returnLog.text()}\n`));
    }
  }
  if (values.screenshot) writes.push(fs.promises.writeFile(path.join(directory, "browser.png"), values.screenshot, "base64"));
  writes.push(fs.promises.writeFile(
    path.join(directory, "result.json"),
    `${JSON.stringify(values.result, null, 2)}\n`,
  ));
  await Promise.all(writes);
}

async function run(options, chrome) {
  const profile = await fs.promises.mkdtemp(path.join(os.tmpdir(), "weave-sidecar-chrome-"));
  const stun = await startLoopbackStun();
  let demo = null;
  let chromeProcess = null;
  let chromeLog = null;
  let cdp = null;
  let browserLog = null;
  let screenshot = null;
  const result = { ok: false, continuity: {} };

  try {
    demo = await startDemo({
      sidecar: options.sidecar,
      weave: options.weave,
      wasm: options.wasm,
      timeoutMs: options.timeoutMs,
      quiet: true,
      iceServers: [{ urls: `stun:127.0.0.1:${stun.port}` }],
    });
    const spawned = spawn(chrome, [
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
      // Keep this disposable same-host smoke independent of headless mDNS
      // resolution. Normal profiles retain Chrome's default privacy behavior.
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--allow-loopback-in-peer-connection",
      demo.pageUrl,
    ], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    spawned.spawnError = null;
    spawned.on("error", (error) => { spawned.spawnError = error; });
    chromeProcess = spawned;
    chromeLog = new ProcessLog("chrome", spawned, { echo: false });

    const devtoolsPort = await waitForDevtoolsPort(profile, chromeLog, options.timeoutMs);
    const page = await waitForPage(devtoolsPort, demo.pageUrl, options.timeoutMs);
    cdp = new CdpClient(page.webSocketDebuggerUrl, Math.min(options.timeoutMs, 15_000));
    await cdp.opened;
    await cdp.command("Runtime.enable");
    await cdp.command("Page.enable");

    await waitForUi(
      cdp,
      "connected sidecar page",
      (ui) => ui.ready && ui.connection === "connected" && ui.module === "woven module" && !ui.startDisabled,
      options.timeoutMs,
    );
    const beforePayloadStatus = await waitFor(
      "sidecar channel readiness before the first payload",
      async () => {
        const status = await demo.sidecar.status();
        const channel = mappingStatus(status, "browser-to-native");
        return channel?.rtcReady ? status : null;
      },
      options.timeoutMs,
      () => demo.sidecar.protocolText().slice(-4_000),
    );
    const beforePayloadChannel = mappingStatus(beforePayloadStatus, "browser-to-native");
    if (beforePayloadChannel.localReady !== false || beforePayloadChannel.state !== "waiting") {
      throw new Error(
        `first-data mapping dialed before browser payload: ${JSON.stringify(beforePayloadChannel)}`,
      );
    }
    process.stdout.write("ok: first-data held the native dial until browser bytes\n");
    result.firstDataGate = { beforePayload: beforePayloadChannel };
    result.sidecarSelectedPathAtGate = beforePayloadStatus.path ?? demo.selectedPath ?? null;
    await cdp.evaluate(`document.getElementById('entry-args').value = ${JSON.stringify(String(options.iterations))}`);

    process.stdout.write("phase 1/2: Chrome/V8 -> sidecar -> Wasmtime\n");
    await click(cdp, "start-workload");
    await waitForUi(cdp, "browser workload", (ui) => ui.runtime === "running" && !ui.migrateDisabled, options.timeoutMs);
    const nativeStart = demo.native.log.lines.length;
    await click(cdp, "migrate-workload");
    const migrated = await waitForUi(
      cdp,
      "browser migration to native",
      (ui) => ui.runtime === "migrated" && ui.owner === "native" && ui.log.includes("migration committed to native"),
      options.timeoutMs,
    );
    const browserLast = last(emitIndices(migrated.log), "browser source phase");
    await waitFor(
      "Wasmtime target admission",
      () => demo.native.log.lines.slice(nativeStart).some(({ line }) => line.includes("workload received, resuming")),
      options.timeoutMs,
      () => demo.native.log.text(null, nativeStart),
    );
    const nativeFirst = await waitFor(
      "first native EMIT",
      () => nativeEmits(demo.native.log, nativeStart)[0] ?? null,
      options.timeoutMs,
      () => demo.native.log.text(null, nativeStart),
    );
    assertNext(browserLast, nativeFirst, "Chrome -> Wasmtime");
    result.continuity.browserToNative = { previous: browserLast, next: nativeFirst };
    const afterPayloadStatus = await demo.sidecar.status();
    const afterPayloadChannel = mappingStatus(afterPayloadStatus, "browser-to-native");
    if (afterPayloadChannel?.localReady !== true) {
      throw new Error(
        `first-data mapping did not report a completed native dial: ${JSON.stringify(afterPayloadChannel)}`,
      );
    }
    result.firstDataGate.afterPayload = afterPayloadChannel;
    result.sidecarSelectedPath = afterPayloadStatus.path ??
      result.sidecarSelectedPathAtGate ?? demo.selectedPath ?? null;

    process.stdout.write("phase 2/2: Wasmtime -> sidecar -> Chrome/V8\n");
    const browserBeforeReturn = (await snapshot(cdp)).log;
    await click(cdp, "arm-target");
    await waitForUi(cdp, "armed browser target", (ui) => ui.runtime === "armed", options.timeoutMs);
    await demo.migrateBack();
    await waitFor(
      "native source migration completion",
      () => demo.native.log.lines.slice(nativeStart).some(({ line }) => line === "WEAVE_MIGRATED"),
      options.timeoutMs,
      () => demo.native.log.text(null, nativeStart),
    );
    const nativeLast = last(nativeEmits(demo.native.log, nativeStart), "native source phase");
    const resumed = await waitForUi(
      cdp,
      "browser resume from native",
      (ui) => ui.runtime === "running" && ui.owner === "browser" &&
        ui.log.includes("accepted and verified workload from wasmtime"),
      options.timeoutMs,
    );
    const browserFirst = firstAppendedEmit(browserBeforeReturn, resumed.log) ?? await waitFor(
      "first browser EMIT after native",
      async () => firstAppendedEmit(browserBeforeReturn, (await snapshot(cdp)).log),
      options.timeoutMs,
    );
    assertNext(nativeLast, browserFirst, "Wasmtime -> Chrome");
    result.continuity.nativeToBrowser = { previous: nativeLast, next: browserFirst };

    if (cdp.exceptions.length > 0) {
      throw new Error(`browser exceptions:\n${cdp.exceptions.join("\n")}`);
    }
    const final = await snapshot(cdp);
    browserLog = final.log;
    const capture = await cdp.command("Page.captureScreenshot", { format: "png" });
    screenshot = capture.data;
    if (demo.fatalError) throw demo.fatalError;
    result.ok = true;
    result.browserSelectedPath = final.path || null;
    result.nativeAddress = demo.nativeAddress;
    result.sidecarIngress = demo.ingressAddress;
    process.stdout.write(`ok: browser/native WebRTC round trip (${final.path || "candidate path unavailable"})\n`);
  } catch (error) {
    result.error = error.stack ?? String(error);
    if (cdp) {
      try {
        const final = await snapshot(cdp);
        browserLog = final.log;
        screenshot = (await cdp.command("Page.captureScreenshot", { format: "png" })).data;
      } catch { /* preserve the primary failure */ }
    }
    throw error;
  } finally {
    cdp?.close();
    await demo?.close();
    await terminate(chromeProcess);
    await stun.close();
    result.sidecarSelectedPath ??= result.sidecarSelectedPathAtGate ?? demo?.selectedPath ?? null;
    await writeArtifacts(options.artifacts, {
      browserLog,
      chromeLog: chromeLog?.text() ?? "",
      demo,
      screenshot,
      result,
    });
    if (!options.keepProfile) await fs.promises.rm(profile, { recursive: true, force: true });
    else process.stderr.write(`retained Chrome profile: ${profile}\n`);
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
  const { missing, chrome } = missingPrerequisites(options);
  if (missing.length > 0) {
    const message = `browser-sidecar smoke prerequisites missing: ${missing.join(", ")}`;
    if (options.required) throw new Error(message);
    process.stdout.write(`SKIP: ${message}\n`);
    return;
  }
  await run(options, chrome);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`browser-sidecar smoke failed: ${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
