import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";

export const APP_KINDS = ["wamr", "sidecar", "peer"];
const DIRECTORIES = { wamr: "browser-wamr", sidecar: "browser-sidecar", peer: "browser-webrtc" };

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function flush() {
  // A bounded microtask drain, not a wall-clock delay. App awaits can traverse
  // several nested handlers before their final refreshControls call.
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

class FakeEventTarget {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, details = {}) {
    for (const listener of [...this.listeners.get(type) ?? []]) {
      listener({ type, target: this, ...details });
    }
  }
}

class FakeElement extends FakeEventTarget {
  value = "";
  textContent = "";
  className = "";
  _disabled = false;
  get disabled() { return this._disabled; }
  set disabled(value) {
    const changed = this._disabled !== value;
    this._disabled = value;
    // Tests can model a MutationObserver/automation reaction at the same
    // microtask boundary as an actual DOM attribute change.
    if (changed && this.listeners.has("disabledchange")) {
      queueMicrotask(() => this.emit("disabledchange", { disabled: value }));
    }
  }
  hidden = false;
  files = [];
  scrollTop = 0;
  scrollHeight = 0;
  replaceChildren(...children) { this.children = children; }
}

export class FakeChannel extends FakeEventTarget {
  constructor(label) {
    super();
    Object.assign(this, {
      label, readyState: "open", ordered: true, maxRetransmits: null,
      maxPacketLifeTime: null, protocol: label === "control" ? "weave.control.v1" : "weave.v2",
      bufferedAmount: 0, sent: [],
    });
  }
  send(value) {
    if (this.readyState !== "open") throw new Error("channel is closed");
    this.sent.push(JSON.parse(value));
  }
  message(value) { this.emit("message", { data: JSON.stringify(value) }); }
  close() { this.readyState = "closed"; this.emit("close"); }
}

class FakeTimers {
  next = 1;
  pending = new Map();
  setTimeout = (callback, delay = 0) => {
    const id = this.next++;
    this.pending.set(id, { id, callback, delay });
    return id;
  };
  clearTimeout = (id) => { this.pending.delete(id); };
  capture(delay) { return [...this.pending.values()].filter((timer) => timer.delay === delay); }
  fire(delay) {
    for (const timer of this.capture(delay)) {
      this.pending.delete(timer.id);
      timer.callback();
    }
  }
}

function abortError() {
  const error = new Error("test cancelled");
  error.name = "AbortError";
  return error;
}

/** Evaluate the whole real app; only browser/engine/transport boundaries are
 * replaced. No handler bodies are extracted, rewritten, or reimplemented. */
export async function loadApp(kind, root = process.env.WEAVE_BROWSER_TEST_ROOT ?? fileURLToPath(new URL("../../", import.meta.url))) {
  const file = path.join(root, "demos", DIRECTORIES[kind], "app.mjs");
  const original = await fs.readFile(file, "utf8");
  const nodes = new Map();
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, new FakeElement());
      return nodes.get(selector);
    },
    createElement() { return new FakeElement(); },
  };
  const timers = new FakeTimers();
  const instances = [];
  const streams = [];
  const acceptances = [];
  const relayAcceptances = [];
  let nextInitError = null;
  let nextStreamError = null;

  class FakeInstance {
    constructor(bytes, services, options) {
      Object.assign(this, {
        bytes, services, options, pollCount: 0, instantiateCalls: 0, initCalls: 0,
        driveCalls: [], instantiation: deferred(), completion: deferred(),
        initError: nextInitError,
      });
      nextInitError = null;
      instances.push(this);
    }
    instantiate() { this.instantiateCalls++; return this.instantiation.promise; }
    init() { this.initCalls++; if (this.initError) throw this.initError; }
    drive(entry, args, onPoll) {
      this.driveCalls.push({ entry, args, onPoll });
      return this.completion.promise;
    }
  }

  class FakeStream {
    constructor(channel, options = {}) {
      if (nextStreamError) {
        const error = nextStreamError;
        nextStreamError = null;
        throw error;
      }
      Object.assign(this, { channel, signal: options.signal, closed: false });
      streams.push(this);
    }
    async close() { this.closed = true; }
    async write() {}
  }

  const imports = {
    FT: { ABORT: 1 },
    frame() { return new Uint8Array(); },
    Writer: class { u32() { return this; } str() { return this; } out() { return new Uint8Array(); } },
    WeaveInstance: FakeInstance,
    SourceMigration: class {
      constructor(stream) { this.t = stream; this.totalPages = 0; }
      async handshake() {}
      async precopyStep() { return false; }
      async finish() { return { commitConfirmed: true, totalPages: 0, rounds: 0, finalPages: 0 }; }
    },
    RTCDataChannelByteStream: FakeStream,
    WEAVE_DATA_CHANNEL_PROTOCOL: "weave.v2",
    extractMeta() { return { entries: [{ name: "run", params: [] }], memories: ["memory"], pollPeriod: 1 }; },
    acceptMigration(stream, services, options) {
      const gate = deferred();
      acceptances.push({ gate, stream, services, options });
      stream.signal?.addEventListener("abort", () => gate.reject(abortError()), { once: true });
      return gate.promise;
    },
    acceptRelay(url, options) {
      const gate = deferred();
      relayAcceptances.push({ gate, url, options });
      options.signal?.addEventListener("abort", () => gate.reject(abortError()), { once: true });
      return gate.promise;
    },
    async connectRelay() { return new FakeStream(new FakeChannel("relay")); },
    WebRTCSession: class { constructor() { throw new Error("bootstrap fetch must remain deferred"); } },
    async getSelectedCandidatePath() { return null; },
  };

  const context = vm.createContext({
    __imports: imports,
    document,
    window: new FakeEventTarget(),
    location: { origin: "https://example.test", href: "https://example.test/#room=test&peer=a", hash: "#room=test&peer=a" },
    history: { replaceState() {} },
    navigator: { clipboard: { async writeText() {} } },
    URL, URLSearchParams, AbortController, TextEncoder, TextDecoder,
    crypto: webcrypto,
    btoa: (text) => Buffer.from(text, "binary").toString("base64"),
    queueMicrotask,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setTimeout,
    clearInterval: timers.clearTimeout,
    // Bootstrap requests remain pending and cannot race our deterministic
    // ready-state setup. No actual network requests occur.
    fetch: () => new Promise(() => {}),
    console,
  });
  const script = original.replace(
    /^import\s*\{([^}]+)\}\s*from\s*["'][^"']+["'];/gm,
    (_, bindings) => `const {${bindings}} = globalThis.__imports;`,
  );
  const exposed = kind === "peer"
    ? "start: startWorkload, arm: () => armIncomingMigration(inboundLabel()), handleControlMessage, registerDataChannel"
    : "start: startBrowserWorkload, arm: armBrowserTarget, cancel: cancelBrowserTarget";
  new vm.Script(`${script}\n;globalThis.__app = { state, elements, refreshControls, requestMigration, ${exposed} };`, { filename: file })
    .runInContext(context);
  const app = context.__app;
  app.state.moduleBytes = Uint8Array.of(0, 97, 115, 109);
  app.state.moduleHashHex = "test-hash";
  app.state.moduleMeta = imports.extractMeta();
  app.elements.entry.value = "run";
  app.elements.entryArgs.value = "";
  if (app.elements.targetName) app.elements.targetName.value = "native";
  const channels = new Map();
  if (kind === "peer") {
    for (const label of ["control", "a-to-b", "b-to-a"]) {
      const channel = new FakeChannel(label);
      channels.set(label, channel);
      app.registerDataChannel(channel);
    }
  } else if (kind === "sidecar") {
    for (const label of ["browser-to-native", "native-to-browser"]) {
      const channel = new FakeChannel(label);
      channels.set(label, channel);
      app.state.channels.set(label, channel);
    }
  }
  await flush();
  app.refreshControls();

  return {
    ...app, kind, timers, instances, streams, acceptances, relayAcceptances, channels,
    get startButton() { return app.elements.startBrowser ?? app.elements.startWorkload; },
    get migrateButton() { return app.elements.migrateBrowser ?? app.elements.migrateWorkload; },
    get control() { return channels.get("control"); },
    pagehide() { context.window.emit("pagehide"); },
    failNextInit(error = new Error("init failed")) { nextInitError = error; },
    failNextStream(error = new Error("stream construction failed")) { nextStreamError = error; },
    async instantiate(index = 0) { instances[index].instantiation.resolve(); await flush(); },
    async complete(index = 0) {
      instances[index].completion.resolve({ status: "done", results: [7] });
      await flush();
    },
    async dispose() {
      // Settle only stub boundaries; preserve the real handlers' own cleanup.
      for (const acceptance of relayAcceptances) acceptance.gate.reject(abortError());
      for (const acceptance of acceptances) acceptance.gate.reject(abortError());
      for (const instance of instances) {
        instance.instantiation.resolve();
        instance.completion.resolve({ status: "done", results: [] });
      }
      for (const timer of timers.capture(10_000)) timer.callback();
      timers.pending.clear();
      await flush();
    },
  };
}

export async function runningApp(kind) {
  const app = await loadApp(kind);
  const start = app.start();
  await app.instantiate();
  return { app, start };
}
