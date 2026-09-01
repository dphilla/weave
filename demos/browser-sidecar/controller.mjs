#!/usr/bin/env node
// Demo-only supervisor for the generic WebRTC sidecar. It owns HTTP
// rendezvous and native process policy; the sidecar itself sees only NDJSON
// control records and raw local TCP streams.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startServer } from "../browser-webrtc/server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_CONTROL_BYTES = 1024 * 1024;
const CONTROL_DECODER = new TextDecoder("utf-8", { fatal: true });

function usage() {
  return `usage: node demos/browser-sidecar/controller.mjs [options]

  --sidecar PATH       weave-rtc executable (or WEBRTC_SIDECAR_BIN)
  --weave PATH         weave executable (or WEAVE_BIN)
  --wasm PATH          woven module (or WEAVE_DEMO_WASM)
  --http HOST:PORT     signaling/static listener (default 127.0.0.1:0)
  --token TOKEN        signaling bearer token (random when omitted)
  --ice-server-json J  RTCIceServer object; repeatable
  --timeout-ms N       process/control deadline (default 90000)
  --quiet              do not mirror child diagnostics
  --help               show this message`;
}

function parseAddress(value) {
  const match = String(value).match(/^\[([^\]]+)]:(\d+)$/) ??
    String(value).match(/^([^:]+):(\d+)$/);
  if (!match) throw new Error(`invalid address ${value}; expected HOST:PORT`);
  const port = Number(match[2]);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port in ${value}`);
  }
  return { host: match[1], port };
}

function parseIceServer(raw) {
  let value;
  try { value = JSON.parse(raw); }
  catch (error) { throw new Error(`invalid --ice-server-json: ${error.message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--ice-server-json must be an object");
  }
  return value;
}

export function parseOptions(argv) {
  const options = {
    sidecar: process.env.WEBRTC_SIDECAR_BIN ?? path.join(REPO_ROOT, "target/demo-artifacts/browser-sidecar/weave-rtc"),
    weave: process.env.WEAVE_BIN ?? path.join(REPO_ROOT, "target/release/weave"),
    wasm: process.env.WEAVE_DEMO_WASM ?? path.join(REPO_ROOT, "target/demo-artifacts/browser-sidecar/counter.woven.wasm"),
    http: parseAddress("127.0.0.1:0"),
    token: process.env.WEAVE_SIGNAL_TOKEN ?? "",
    iceServers: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    quiet: false,
    help: false,
  };
  const take = (index, flag) => {
    if (index + 1 >= argv.length) throw new Error(`${flag} requires a value`);
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--sidecar": options.sidecar = path.resolve(take(i, argv[i++])); break;
      case "--weave": options.weave = path.resolve(take(i, argv[i++])); break;
      case "--wasm": options.wasm = path.resolve(take(i, argv[i++])); break;
      case "--http": options.http = parseAddress(take(i, argv[i++])); break;
      case "--token": options.token = take(i, argv[i++]); break;
      case "--ice-server-json": options.iceServers.push(parseIceServer(take(i, argv[i++]))); break;
      case "--timeout-ms": options.timeoutMs = Number(take(i, argv[i++])); break;
      case "--quiet": options.quiet = true; break;
      case "--help": options.help = true; break;
      default: throw new Error(`unknown option: ${argv[i]}`);
    }
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  return options;
}

function executable(filename) {
  try {
    fs.accessSync(filename, fs.constants.X_OK);
    return fs.statSync(filename).isFile();
  } catch { return false; }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function randomId() {
  return crypto.randomBytes(18).toString("base64url");
}

export class ProcessLog {
  constructor(name, child, { echo = false, stdout = true, stderr = true } = {}) {
    this.name = name;
    this.child = child;
    this.lines = [];
    this.partial = { stdout: "", stderr: "" };
    this.echo = echo;
    if (stdout) this.attach("stdout", child.stdout);
    if (stderr) this.attach("stderr", child.stderr);
  }

  attach(streamName, stream) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk) => {
      const text = this.partial[streamName] + chunk;
      const parts = text.split(/\r?\n/);
      this.partial[streamName] = parts.pop();
      for (const line of parts) {
        this.lines.push({ stream: streamName, line, time: Date.now() });
        if (this.echo && line) process.stderr.write(`[${this.name}:${streamName}] ${line}\n`);
      }
    });
  }

  text(stream = null, start = 0) {
    return this.lines
      .slice(start)
      .filter((entry) => stream === null || entry.stream === stream)
      .map(({ stream: source, line }) => stream === null ? `[${source}] ${line}` : line)
      .join("\n");
  }
}

function spawnLogged(name, command, args, { echo = false, stdout = true, stderr = true } = {}) {
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.spawnError = null;
  child.on("error", (error) => { child.spawnError = error; });
  return { child, log: new ProcessLog(name, child, { echo, stdout, stderr }) };
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const signal = (name) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch { /* process exited concurrently */ }
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
    } catch (error) { lastError = error; }
    await delay(30);
  }
  const suffix = details();
  throw new Error(
    `timed out waiting for ${description}${lastError ? `; ${lastError.message}` : ""}${suffix ? `\n${suffix}` : ""}`,
  );
}

async function waitForLog(description, process, predicate, start, timeoutMs) {
  return waitFor(
    description,
    () => {
      const found = process.log.lines.slice(start).find(predicate);
      if (found) return found;
      if (process.child.spawnError) throw process.child.spawnError;
      if (process.child.exitCode !== null) {
        throw new Error(`${process.log.name} exited with ${process.child.exitCode}`);
      }
      return null;
    },
    timeoutMs,
    () => process.log.text(null, Math.max(0, process.log.lines.length - 40)),
  );
}

export class SidecarClient {
  constructor(command, { timeoutMs = DEFAULT_TIMEOUT_MS, echo = false } = {}) {
    this.timeoutMs = timeoutMs;
    this.child = spawn(command, [], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child.spawnError = null;
    this.child.on("error", (error) => {
      this.child.spawnError = error;
      this.fail(error);
    });
    this.stderr = new ProcessLog("weave-rtc", this.child, {
      echo,
      stdout: false,
      stderr: true,
    });
    this.protocolLines = [];
    this.pending = new Map();
    this.nextId = 1;
    this.nextSequence = 1;
    this.output = Buffer.alloc(0);
    this.error = null;
    this.onEvent = null;
    this.onFatal = null;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.child.stdout.on("data", (chunk) => this.ingest(chunk));
    this.child.stdout.on("end", () => {
      if (this.output.length > 0) this.fail(new Error("sidecar stdout ended with a partial control record"));
    });
    this.child.once("exit", (code, signal) => {
      const result = { code, signal };
      if (!this.error && code !== 0) this.fail(new Error(`sidecar exited with ${code ?? signal}`));
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(this.error ?? new Error("sidecar exited before replying"));
      }
      this.pending.clear();
      this.resolveClosed(result);
    });
  }

  ingest(chunk) {
    if (this.error) return;
    this.output = Buffer.concat([this.output, chunk]);
    if (this.output.length > MAX_CONTROL_BYTES + 1 && this.output.indexOf(0x0a) < 0) {
      this.fail(new Error(`sidecar control record exceeds ${MAX_CONTROL_BYTES} bytes`));
      return;
    }
    for (;;) {
      const newline = this.output.indexOf(0x0a);
      if (newline < 0) return;
      let raw = this.output.subarray(0, newline);
      this.output = this.output.subarray(newline + 1);
      if (raw.length > 0 && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1);
      if (raw.length === 0 || raw.length > MAX_CONTROL_BYTES) {
        this.fail(new Error("sidecar emitted an empty or oversized control record"));
        return;
      }
      let text;
      try { text = CONTROL_DECODER.decode(raw); }
      catch {
        this.fail(new Error("sidecar emitted a control record that is not valid UTF-8"));
        return;
      }
      this.protocolLines.push(text);
      let record;
      try { record = JSON.parse(text); }
      catch (error) {
        this.fail(new Error(`sidecar emitted invalid JSON: ${error.message}`));
        return;
      }
      this.message(record);
      if (this.error) return;
    }
  }

  message(record) {
    if (!record || typeof record !== "object" || Array.isArray(record) || record.v !== 1) {
      this.fail(new Error("sidecar emitted an invalid control record"));
      return;
    }
    if (record.event === "ready") {
      if (record.protocol !== "webrtc-sidecar.control.v1") {
        this.fail(new Error(`unsupported sidecar protocol ${record.protocol}`));
        return;
      }
      this.resolveReady(record);
      return;
    }
    if (Object.hasOwn(record, "id")) {
      const pending = this.pending.get(String(record.id));
      if (!pending) {
        this.fail(new Error(`sidecar replied to unknown request ${record.id}`));
        return;
      }
      this.pending.delete(String(record.id));
      clearTimeout(pending.timer);
      if (record.ok === true) pending.resolve(record.result ?? {});
      else pending.reject(new Error(record.error?.message ?? "sidecar request failed"));
      return;
    }
    if (!Number.isSafeInteger(record.seq) || record.seq !== this.nextSequence) {
      this.fail(new Error(`sidecar event sequence mismatch: expected ${this.nextSequence}, got ${record.seq}`));
      return;
    }
    this.nextSequence += 1;
    try {
      const result = this.onEvent?.(record);
      Promise.resolve(result).catch((error) => this.fail(error));
    } catch (error) { this.fail(error); }
  }

  fail(value) {
    if (this.error) return;
    this.error = value instanceof Error ? value : new Error(String(value));
    this.rejectReady(this.error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.error);
    }
    this.pending.clear();
    this.onFatal?.(this.error);
  }

  async request(command, fields = {}) {
    await this.ready;
    if (this.error) throw this.error;
    if (this.child.exitCode !== null) throw new Error("sidecar has exited");
    const id = String(this.nextId++);
    const record = { v: 1, id, command, ...fields };
    const encoded = Buffer.from(`${JSON.stringify(record)}\n`);
    if (encoded.length > MAX_CONTROL_BYTES) throw new Error("sidecar request exceeds the control limit");
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sidecar ${command} request timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      await new Promise((resolve, reject) => {
        this.child.stdin.write(encoded, (error) => error ? reject(error) : resolve());
      });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
      throw error;
    }
    return response;
  }

  start(options) { return this.request("start", options); }

  signal(message) { return this.request("signal", { message }); }

  status() { return this.request("status"); }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.closed;
    try { await this.request("close"); }
    catch (error) {
      if (this.child.exitCode === null && !this.error) throw error;
    }
    this.child.stdin.end();
    const result = await this.closed;
    if (this.error) throw this.error;
    return result;
  }

  protocolText() { return this.protocolLines.join("\n"); }
}

class HttpSignalingPeer {
  constructor({ baseUrl, room, token, onMessage, onFatal }) {
    this.baseUrl = baseUrl;
    this.room = room;
    this.token = token;
    this.onMessage = onMessage;
    this.onFatal = onFatal;
    this.cursor = 0;
    this.controller = new AbortController();
    this.sendTail = Promise.resolve();
    this.stopped = false;
  }

  headers(extra = {}) {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  async json(response) {
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body.error ?? `signaling returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  send(message) {
    const body = JSON.stringify({ from: "b", requestId: randomId(), message });
    const operation = this.sendTail.then(() => this.sendWithRetry(body));
    this.sendTail = operation.catch(() => {});
    return operation;
  }

  async sendWithRetry(body) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}v1/signal/${encodeURIComponent(this.room)}/a`, {
          method: "POST",
          headers: this.headers({ "content-type": "application/json" }),
          body,
          signal: this.controller.signal,
        });
        await this.json(response);
        return;
      } catch (error) {
        if (this.stopped || error.name === "AbortError") throw error;
        const transient = error.status === undefined || error.status === 408 ||
          error.status === 429 || error.status >= 500;
        if (!transient || attempt >= 5) throw error;
        await delay(Math.min(250 * 2 ** attempt, 2_000));
      }
    }
  }

  start() { void this.poll(); }

  async poll() {
    while (!this.stopped) {
      try {
        const response = await fetch(
          `${this.baseUrl}v1/signal/${encodeURIComponent(this.room)}/b?after=${this.cursor}`,
          { headers: this.headers(), signal: this.controller.signal },
        );
        const batch = await this.json(response);
        for (const entry of batch.messages) {
          await this.onMessage(entry.message);
          this.cursor = entry.id;
        }
        this.cursor = Math.max(this.cursor, batch.cursor);
      } catch (error) {
        if (this.stopped || error.name === "AbortError") return;
        const transient = error.status === undefined || error.status === 408 ||
          error.status === 429 || error.status >= 500;
        if (!transient) {
          this.stop();
          this.onFatal(error);
          return;
        }
        await delay(250);
      }
    }
  }

  stop() {
    this.stopped = true;
    this.controller.abort();
  }
}

async function runCommand(name, command, args, timeoutMs, echo) {
  const process = spawnLogged(name, command, args, { echo });
  let timer;
  try {
    const result = await Promise.race([
      new Promise((resolve, reject) => {
        process.child.once("error", reject);
        process.child.once("exit", (code, signal) => resolve({ code, signal }));
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    if (result.code !== 0) {
      throw new Error(`${name} exited with ${result.code ?? result.signal}\n${process.log.text()}`);
    }
    return process.log;
  } finally {
    clearTimeout(timer);
    await terminate(process.child);
  }
}

function displayHttpAddress(address) {
  const host = address.address === "::" || address.address === "0.0.0.0"
    ? "127.0.0.1"
    : address.address.includes(":") ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}/`;
}

export async function startDemo(rawOptions) {
  const options = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    quiet: false,
    iceServers: [],
    token: "",
    http: { host: "127.0.0.1", port: 0 },
    ...rawOptions,
  };
  if (!executable(options.sidecar)) throw new Error(`sidecar is not executable: ${options.sidecar}`);
  if (!executable(options.weave)) throw new Error(`weave is not executable: ${options.weave}`);
  await fs.promises.access(options.wasm, fs.constants.R_OK);
  const token = options.token || crypto.randomBytes(24).toString("base64url");
  const room = randomId();
  const echo = !options.quiet;
  let native = null;
  let sidecar = null;
  let server = null;
  let signaling = null;
  let returnLog = null;
  let closing = null;
  let returned = false;
  let fatalError = null;
  let selectedPath = null;

  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      signaling?.stop();
      try { await sidecar?.close(); } catch { await terminate(sidecar?.child); }
      try { await server?.close(); } catch { /* another shutdown path won */ }
      await terminate(native?.child);
    })();
    return closing;
  };

  try {
    native = spawnLogged(
      "wasmtime",
      options.weave,
      ["serve", "--listen", "127.0.0.1:0"],
      { echo },
    );
    const listening = await waitForLog(
      "Wasmtime listener",
      native,
      ({ line }) => /weave: listening on 127\.0\.0\.1:(\d+)/.test(line),
      0,
      options.timeoutMs,
    );
    const nativePort = Number(listening.line.match(/:(\d+)$/)[1]);
    const nativeAddress = `127.0.0.1:${nativePort}`;

    server = await startServer({
      host: options.http.host,
      port: options.http.port,
      wasmPath: options.wasm,
      token,
      iceServers: options.iceServers,
    });
    const baseUrl = displayHttpAddress(server.address);

    sidecar = new SidecarClient(options.sidecar, { timeoutMs: options.timeoutMs, echo });
    signaling = new HttpSignalingPeer({
      baseUrl,
      room,
      token,
      onMessage(message) { return sidecar.signal(message); },
      onFatal(error) {
        fatalError = error;
        sidecar.fail(new Error(`signaling failed: ${error.message}`));
      },
    });
    // Install every asynchronous consumer before `start`: an offerer may emit
    // its description immediately after the correlated start response.
    sidecar.onEvent = (event) => {
      if (event.event === "signal") return signaling.send(event.message);
      if (event.event === "path") selectedPath = event.path;
      if (event.event === "closed" && event.reason === "failed") {
        fatalError = new Error(event.error?.message ?? "sidecar session failed");
      }
      return undefined;
    };
    sidecar.onFatal = (error) => { fatalError = error; };
    await sidecar.ready;
    const started = await sidecar.start({
      role: "answerer",
      rtcConfiguration: {
        iceServers: options.iceServers,
        iceTransportPolicy: "all",
      },
      // Human inspection may delay opening the printed browser URL.
      connectTimeoutMs: 0,
      channels: [
        {
          mapping: "browser-to-native",
          label: "browser-to-native",
          protocol: "weave.v2",
          local: {
            mode: "dial",
            host: "127.0.0.1",
            port: nativePort,
            connectOn: "first-data",
            connectTimeoutMs: Math.min(options.timeoutMs, 10_000),
          },
        },
        {
          mapping: "native-to-browser",
          label: "native-to-browser",
          protocol: "weave.v2",
          local: { mode: "listen", host: "127.0.0.1", port: 0 },
        },
      ],
    });
    const inbound = started.channels?.find(({ mapping }) => mapping === "native-to-browser");
    if (inbound?.local?.mode !== "listen" || typeof inbound.local.address !== "string") {
      throw new Error("sidecar start response did not include the native-to-browser listener");
    }
    const ingressAddress = inbound.local.address;

    signaling.start();

    const pageUrl = `${baseUrl}sidecar/#room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`;
    const migrateBack = async () => {
      if (returned) throw new Error("the native-to-browser mapping is one-shot");
      if (fatalError) throw fatalError;
      returned = true;
      returnLog = await runCommand(
        "wasmtime-return",
        options.weave,
        ["migrate", "--node", nativeAddress, "--to", ingressAddress],
        options.timeoutMs,
        echo,
      );
      return returnLog;
    };

    return {
      baseUrl,
      pageUrl,
      room,
      token,
      nativeAddress,
      ingressAddress,
      native,
      sidecar,
      server,
      get fatalError() { return fatalError; },
      get returnLog() { return returnLog; },
      get selectedPath() { return selectedPath; },
      migrateBack,
      close,
    };
  } catch (error) {
    await close();
    throw error;
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

  const demo = await startDemo(options);
  process.stdout.write(`browser/native WebRTC demo: ${demo.pageUrl}\n`);
  process.stdout.write(`native node: ${demo.nativeAddress}\n`);
  process.stdout.write(`sidecar return ingress: ${demo.ingressAddress}\n`);
  process.stdout.write(
    `after the browser migrates to native, arm the browser target and run:\n  ${options.weave} migrate --node ${demo.nativeAddress} --to ${demo.ingressAddress}\n`,
  );

  await new Promise((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await demo.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`browser-sidecar controller failed: ${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
