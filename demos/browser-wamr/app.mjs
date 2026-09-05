import {
  FT,
  SourceMigration,
  WeaveInstance,
  Writer,
  acceptMigration,
  extractMeta,
  frame,
} from "/weave.mjs";
import { acceptRelay, connectRelay } from "/weave-browser.mjs";

const $ = (selector) => document.querySelector(selector);
const elements = {
  relayUrl: $("#relay-url"),
  relayToken: $("#relay-token"),
  relayHealth: $("#relay-health"),
  targetName: $("#target-name"),
  relayTargets: $("#relay-targets"),
  ingressAddress: $("#ingress-address"),
  moduleFile: $("#module-file"),
  loadDemo: $("#load-demo"),
  moduleState: $("#module-state"),
  moduleDetail: $("#module-detail"),
  entry: $("#entry"),
  entryArgs: $("#entry-args"),
  startBrowser: $("#start-browser"),
  armTarget: $("#arm-target"),
  cancelTarget: $("#cancel-target"),
  migrateBrowser: $("#migrate-browser"),
  runtimeState: $("#runtime-state"),
  metricLocation: $("#metric-location"),
  metricPolls: $("#metric-polls"),
  metricPages: $("#metric-pages"),
  clearLog: $("#clear-log"),
  log: $("#log"),
};

const state = {
  moduleBytes: null,
  moduleMeta: null,
  active: null,
  runner: null,
  starting: false,
  accepting: false,
  acceptController: null,
  acceptStream: null,
  migrationRequested: false,
  migrationTarget: null,
  moduleCache: new Map(),
  logLines: [],
};

elements.relayUrl.value = location.origin;

function timestamp() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

function log(message, kind = "info") {
  const marker = kind === "error" ? "!" : kind === "wire" ? ">" : "·";
  state.logLines.push(`${timestamp()} ${marker} ${message}`);
  if (state.logLines.length > 500) state.logLines.splice(0, state.logLines.length - 500);
  elements.log.textContent = `${state.logLines.join("\n")}\n`;
  elements.log.scrollTop = elements.log.scrollHeight;
}

function setBadge(element, text, style = "muted") {
  element.textContent = text;
  element.className = `badge ${style}`;
}

function refreshControls() {
  const running = state.active !== null && state.runner !== null;
  const occupied = running || state.starting || state.accepting;
  elements.startBrowser.disabled = !state.moduleBytes || occupied;
  elements.armTarget.disabled = occupied;
  elements.armTarget.hidden = state.accepting;
  elements.cancelTarget.hidden = !state.accepting;
  elements.migrateBrowser.disabled = !running || state.migrationRequested;
  elements.moduleFile.disabled = occupied;
  elements.loadDemo.disabled = occupied;
  elements.metricLocation.textContent = running ? "Chrome" : state.accepting ? "awaiting ingress" : "none";
  elements.metricPolls.textContent = state.active?.pollCount?.toLocaleString() ?? "0";
}

function relayOptions(extra = {}) {
  return {
    token: elements.relayToken.value,
    highWaterMark: 2 * 1024 * 1024,
    ...extra,
  };
}

const MASK64 = (1n << 64n) - 1n;
const signed64 = (value) => BigInt.asIntN(64, value & MASK64);

function makeEmitServices() {
  const make = (name, implementation) => {
    const serviceState = { count: 0n, sum: 0n };
    return {
      imports: { env: { [name.slice(4)]: implementation(serviceState) } },
      snapshot() {
        const bytes = new Uint8Array(16);
        const view = new DataView(bytes.buffer);
        view.setBigUint64(0, serviceState.count & MASK64, true);
        view.setBigInt64(8, signed64(serviceState.sum), true);
        return bytes;
      },
      restore(bytes) {
        if (bytes.length !== 16) throw new Error(`${name} service snapshot is not 16 bytes`);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        serviceState.count = view.getBigUint64(0, true);
        serviceState.sum = view.getBigInt64(8, true);
      },
    };
  };

  return new Map([
    ["env.emit", make("env.emit", (s) => (index, hash) => {
      s.count += 1n;
      s.sum = signed64(s.sum + hash + BigInt(index));
      log(`EMIT ${index} ${hash}`);
    })],
    ["env.emit32", make("env.emit32", (s) => (value) => {
      s.count += 1n;
      s.sum = signed64(s.sum + BigInt(value));
      log(`EMIT32 ${value}`);
    })],
    ["env.emit64", make("env.emit64", (s) => (value) => {
      s.count += 1n;
      s.sum = signed64(s.sum + value);
      log(`EMIT64 ${value}`);
    })],
  ]);
}

function parseEntryArgs(meta, entryName, text) {
  const entry = meta.entries.find(({ name }) => name === entryName);
  if (!entry) throw new Error(`module has no entry named ${entryName}`);
  const raw = text.trim() === "" ? [] : text.trim().split(/[\s,]+/);
  if (raw.length !== entry.params.length) {
    throw new Error(`${entryName} takes ${entry.params.length} argument(s), got ${raw.length}`);
  }
  return raw.map((value, index) => {
    switch (entry.params[index]) {
      case "i32": return Number(value) | 0;
      case "i64": return BigInt(value);
      case "f32":
      case "f64": return Number(value);
      default: throw new Error(`the demo cannot enter a ${entry.params[index]} argument`);
    }
  });
}

function renderValues(values) {
  return `[${values.map((value) => value.toString()).join(", ")}]`;
}

function setModule(bytes, name) {
  const meta = extractMeta(bytes);
  state.moduleBytes = bytes;
  state.moduleMeta = meta;
  elements.entry.replaceChildren(...meta.entries.map((entry) => {
    const option = document.createElement("option");
    option.value = entry.name;
    option.textContent = `${entry.name} (${entry.params.join(", ")})`;
    return option;
  }));
  elements.entry.disabled = false;
  elements.moduleDetail.textContent = `${name} · ${bytes.length.toLocaleString()} bytes · ${meta.memories.length} memory export(s) · poll period ${meta.pollPeriod}`;
  setBadge(elements.moduleState, "woven module", "");
  log(`loaded ${name}`);
  refreshControls();
}

async function closeQuietly(stream) {
  if (!stream) return;
  try { await stream.close(); } catch { /* already failed */ }
}

function breathe() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function driveWorkload(instance, entry, args) {
  state.active = instance;
  elements.metricPages.textContent = "0";
  elements.metricPolls.textContent = instance.pollCount.toLocaleString();
  setBadge(elements.runtimeState, "running", "");
  log(entry === null ? "resuming received workload in Chrome" : `starting ${entry} in Chrome`);
  refreshControls();
  let phaseEntry = entry;
  let phaseArgs = args;
  let migration = null;
  let lastMetricUpdate = 0;

  try {
    for (;;) {
      const outcome = await instance.drive(phaseEntry, phaseArgs, async () => {
        await breathe();
        const now = Date.now();
        if (now - lastMetricUpdate > 100) {
          lastMetricUpdate = now;
          elements.metricPolls.textContent = instance.pollCount.toLocaleString();
          if (migration) elements.metricPages.textContent = migration.totalPages.toLocaleString();
        }

        if (!migration && state.migrationRequested) {
          let stream = null;
          try {
            setBadge(elements.runtimeState, "connecting", "busy");
            stream = await connectRelay(
              elements.relayUrl.value,
              state.migrationTarget,
              relayOptions(),
            );
            migration = new SourceMigration(stream, instance, "chrome", {
              budgetBytes: 2 * 1024 * 1024,
              dirtyPageThreshold: 64,
              maxRounds: 10,
            });
            await migration.handshake();
            setBadge(elements.runtimeState, "pre-copy", "busy");
            log(`connected to relay target ${state.migrationTarget}; pre-copy started`, "wire");
          } catch (error) {
            await closeQuietly(stream);
            state.migrationRequested = false;
            state.migrationTarget = null;
            migration = null;
            setBadge(elements.runtimeState, "running", "");
            log(`migration could not start: ${error.message}`, "error");
            refreshControls();
          }
        }

        if (migration) {
          try {
            const ready = await migration.precopyStep();
            elements.metricPages.textContent = migration.totalPages.toLocaleString();
            if (ready) return "hold";
          } catch (error) {
            await closeQuietly(migration.t);
            migration = null;
            state.migrationRequested = false;
            state.migrationTarget = null;
            setBadge(elements.runtimeState, "running", "");
            log(`pre-copy failed; continuing locally: ${error.message}`, "error");
            refreshControls();
          }
        }
        return "continue";
      });

      if (outcome.status === "done") {
        if (migration) {
          try {
            await migration.t.write(frame(
              FT.ABORT,
              new Writer().u32(10).str("completed before checkpoint").out(),
            ));
          } catch { /* peer may already be gone */ }
          await closeQuietly(migration.t);
        }
        log(`workload completed in Chrome: ${renderValues(outcome.results)}`);
        setBadge(elements.runtimeState, "complete", "");
        return;
      }

      // Held means the guest is fully unwound and pre-copy converged.
      try {
        setBadge(elements.runtimeState, "stop + copy", "busy");
        const stats = await migration.finish();
        elements.metricPages.textContent = stats.totalPages.toLocaleString();
        // finish() has crossed the PREPARED/COMMIT ownership boundary. Socket
        // shutdown is best-effort and must not delay retiring this source.
        void closeQuietly(migration.t);
        if (stats.commitConfirmed) {
          log(`migration committed: ${stats.rounds} round(s), ${stats.totalPages} page sends, ${stats.finalPages} during pause`, "wire");
          setBadge(elements.runtimeState, "migrated", "");
        } else {
          log(`migration commit confirmation lost; browser source retired without rollback: ${stats.commitError}`, "error");
          setBadge(elements.runtimeState, "commit uncertain", "error");
        }
        state.active = null;
        return;
      } catch (error) {
        await closeQuietly(migration?.t);
        log(`final copy failed; rewinding locally: ${error.message}`, "error");
        migration = null;
        state.migrationRequested = false;
        state.migrationTarget = null;
        setBadge(elements.runtimeState, "running", "");
        phaseEntry = null;
        phaseArgs = null;
        refreshControls();
      }
    }
  } catch (error) {
    setBadge(elements.runtimeState, "failed", "error");
    log(`workload failed: ${error.stack ?? error}`, "error");
  } finally {
    state.active = null;
    state.runner = null;
    state.migrationRequested = false;
    state.migrationTarget = null;
    refreshControls();
  }
}

async function startBrowserWorkload() {
  if (!state.moduleBytes || state.starting || state.runner || state.accepting) return;
  // Reserve the source slot synchronously: instantiation yields before a
  // runner exists, and another Start or incoming Arm must not occupy it.
  state.starting = true;
  refreshControls();
  try {
    const entry = elements.entry.value;
    const args = parseEntryArgs(state.moduleMeta, entry, elements.entryArgs.value);
    const instance = new WeaveInstance(state.moduleBytes, makeEmitServices(), { yieldMs: 25 });
    setBadge(elements.runtimeState, "instantiating", "busy");
    await instance.instantiate();
    instance.init();
    state.runner = driveWorkload(instance, entry, args);
    state.starting = false;
    refreshControls();
    await state.runner;
  } catch (error) {
    setBadge(elements.runtimeState, "failed", "error");
    log(`could not start workload: ${error.message}`, "error");
    state.runner = null;
    state.active = null;
  } finally {
    state.starting = false;
    refreshControls();
  }
}

async function armBrowserTarget() {
  if (state.starting || state.runner || state.accepting) return;
  state.accepting = true;
  state.acceptController = new AbortController();
  setBadge(elements.runtimeState, "armed", "busy");
  log(`browser target armed; migrate WAMR to ${elements.ingressAddress.textContent}`, "wire");
  refreshControls();

  try {
    const stream = await acceptRelay(
      elements.relayUrl.value,
      relayOptions({ signal: state.acceptController.signal }),
    );
    state.acceptStream = stream;
    const { inst, sourceRuntime, commitAckError } = await acceptMigration(stream, makeEmitServices, {
      runtimeName: "chrome",
      moduleCache: state.moduleCache,
      yieldMs: 25,
    });
    // COMMIT has made this browser the owner. Resume immediately even if the
    // peer never completes the WebSocket close handshake.
    void closeQuietly(stream);
    state.acceptStream = null;
    state.accepting = false;
    state.acceptController = null;
    log(`accepted, committed, and verified workload from ${sourceRuntime}`, "wire");
    if (commitAckError) {
      log(`COMMIT was received but COMMIT_OK delivery failed; Chrome resumes as owner: ${commitAckError}`, "error");
    }
    state.runner = driveWorkload(inst, null, null);
    refreshControls();
    await state.runner;
  } catch (error) {
    const cancelled = state.acceptController?.signal.aborted;
    await closeQuietly(state.acceptStream);
    state.acceptStream = null;
    state.accepting = false;
    state.acceptController = null;
    if (cancelled) {
      log("browser target wait cancelled");
      setBadge(elements.runtimeState, "idle", "idle");
    } else {
      log(`incoming migration failed: ${error.message}`, "error");
      setBadge(elements.runtimeState, "failed", "error");
    }
    refreshControls();
  }
}

function cancelBrowserTarget() {
  state.acceptController?.abort();
  void closeQuietly(state.acceptStream);
}

function requestMigration() {
  if (!state.active || !state.runner || state.migrationRequested) return;
  const target = elements.targetName.value.trim();
  if (!target) {
    log("enter a relay target alias first", "error");
    return;
  }
  state.migrationRequested = true;
  state.migrationTarget = target;
  setBadge(elements.runtimeState, "queued", "busy");
  log(`migration to ${target} requested; waiting for the next guest poll`, "wire");
  refreshControls();
}

async function loadDemoModule() {
  try {
    const response = await fetch("/counter.woven.wasm", { cache: "no-store" });
    if (!response.ok) throw new Error(await response.text());
    setModule(new Uint8Array(await response.arrayBuffer()), "counter.woven.wasm");
  } catch (error) {
    setBadge(elements.moduleState, "not generated", "error");
    log(`demo module unavailable: ${error.message.trim()}`, "error");
  }
}

async function refreshRelayConfig() {
  try {
    const base = new URL(elements.relayUrl.value, location.href);
    if (base.protocol === "ws:") base.protocol = "http:";
    if (base.protocol === "wss:") base.protocol = "https:";
    const response = await fetch(new URL("/v1/config", base), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const config = await response.json();
    elements.ingressAddress.textContent = config.ingress;
    elements.relayTargets.replaceChildren(...config.targets.map((name) => {
      const option = document.createElement("option");
      option.value = name;
      return option;
    }));
    if (!config.targets.includes(elements.targetName.value) && config.targets[0]) {
      elements.targetName.value = config.targets[0];
    }
    setBadge(elements.relayHealth, "relay ready", "");
  } catch (error) {
    setBadge(elements.relayHealth, "unreachable", "error");
    elements.ingressAddress.textContent = "relay unavailable";
    log(`relay config unavailable: ${error.message}`, "error");
  }
}

elements.moduleFile.addEventListener("change", async () => {
  const [file] = elements.moduleFile.files;
  if (!file) return;
  try {
    setModule(new Uint8Array(await file.arrayBuffer()), file.name);
  } catch (error) {
    setBadge(elements.moduleState, "invalid module", "error");
    log(`module rejected: ${error.message}`, "error");
  }
});
elements.loadDemo.addEventListener("click", () => { void loadDemoModule(); });
elements.startBrowser.addEventListener("click", () => { void startBrowserWorkload(); });
elements.armTarget.addEventListener("click", () => { void armBrowserTarget(); });
elements.cancelTarget.addEventListener("click", cancelBrowserTarget);
elements.migrateBrowser.addEventListener("click", requestMigration);
elements.clearLog.addEventListener("click", () => {
  state.logLines = [];
  elements.log.textContent = "";
});
elements.relayUrl.addEventListener("change", () => { void refreshRelayConfig(); });

log("demo initialized");
refreshControls();
void refreshRelayConfig();
