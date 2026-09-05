import {
  FT,
  SourceMigration,
  WeaveInstance,
  Writer,
  acceptMigration,
  extractMeta,
  frame,
} from "/weave.mjs";
import {
  RTCDataChannelByteStream,
  WEAVE_DATA_CHANNEL_PROTOCOL,
} from "/weave-browser.mjs";
import {
  WebRTCSession,
  getSelectedCandidatePath,
} from "/packages/webrtc-session/src/index.mjs";

const OUTBOUND_LABEL = "browser-to-native";
const INBOUND_LABEL = "native-to-browser";

const $ = (selector) => document.querySelector(selector);
const elements = {
  roomName: $("#room-name"),
  connectionState: $("#connection-state"),
  moduleState: $("#module-state"),
  moduleDetail: $("#module-detail"),
  entry: $("#entry"),
  entryArgs: $("#entry-args"),
  startWorkload: $("#start-workload"),
  migrateWorkload: $("#migrate-workload"),
  armTarget: $("#arm-target"),
  cancelTarget: $("#cancel-target"),
  runtimeState: $("#runtime-state"),
  metricOwner: $("#metric-owner"),
  metricPolls: $("#metric-polls"),
  metricPages: $("#metric-pages"),
  metricPath: $("#metric-path"),
  clearLog: $("#clear-log"),
  log: $("#log"),
};

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
const room = /^[A-Za-z0-9_-]{1,64}$/.test(fragment.get("room") ?? "")
  ? fragment.get("room")
  : randomId();
const token = fragment.get("token") ?? "";
fragment.set("room", room);
if (token) fragment.set("token", token);
history.replaceState(null, "", `#${fragment}`);
elements.roomName.textContent = room;

const state = {
  session: null,
  peerConnection: null,
  signaling: null,
  channels: new Map(),
  statsTimer: null,
  moduleBytes: null,
  moduleHashHex: null,
  moduleMeta: null,
  moduleCache: new Map(),
  active: null,
  runner: null,
  starting: false,
  accepting: false,
  incomingController: null,
  incomingStream: null,
  migrationRequested: false,
  outboundStream: null,
  usedInbound: false,
  usedOutbound: false,
  everStarted: false,
  location: "none",
  logLines: [],
};

function timestamp() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

function log(message, kind = "info") {
  const marker = kind === "error" ? "!" : kind === "wire" ? ">" : "·";
  state.logLines.push(`${timestamp()} ${marker} ${message}`);
  if (state.logLines.length > 800) state.logLines.splice(0, state.logLines.length - 800);
  elements.log.textContent = `${state.logLines.join("\n")}\n`;
  elements.log.scrollTop = elements.log.scrollHeight;
}

function setBadge(element, text, style = "muted") {
  element.textContent = text;
  element.className = `badge ${style}`;
}

function channelOpen(label) {
  return state.channels.get(label)?.readyState === "open";
}

function refreshControls() {
  const running = state.active !== null && state.runner !== null;
  elements.startWorkload.disabled = state.everStarted || !state.moduleBytes ||
    !channelOpen(OUTBOUND_LABEL) || !channelOpen(INBOUND_LABEL) ||
    running || state.starting || state.accepting;
  elements.migrateWorkload.disabled = !running || !channelOpen(OUTBOUND_LABEL) ||
    state.migrationRequested || state.usedOutbound;
  elements.armTarget.disabled = !state.everStarted || running || state.starting || state.accepting ||
    state.usedInbound || !state.moduleBytes || !channelOpen(INBOUND_LABEL);
  elements.armTarget.hidden = state.accepting;
  elements.cancelTarget.hidden = !state.accepting;
  elements.metricOwner.textContent = state.accepting
    ? "browser (staging)"
    : state.location;
  elements.metricPolls.textContent = state.active?.pollCount?.toLocaleString() ?? "0";
}

class SignalingClient {
  constructor({ roomName, accessToken, onMessage, onFatal }) {
    this.roomName = roomName;
    this.accessToken = accessToken;
    this.onMessage = onMessage;
    this.onFatal = onFatal;
    this.cursor = 0;
    this.controller = new AbortController();
    this.sendTail = Promise.resolve();
    this.stopped = false;
  }

  headers(extra = {}) {
    return {
      ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
      ...extra,
    };
  }

  async responseJson(response) {
    let body;
    try { body = await response.json(); }
    catch {
      const error = new Error(`signaling returned HTTP ${response.status} with a non-JSON body`);
      error.status = response.status;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(body.error ?? `signaling returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  send(message) {
    if (this.stopped || this.controller.signal.aborted) {
      const error = new Error("signaling session is stopped");
      error.name = "AbortError";
      return Promise.reject(error);
    }
    const body = JSON.stringify({ from: "a", requestId: randomId(), message });
    const operation = this.sendTail.then(() => this.sendWithRetry(body));
    this.sendTail = operation.catch(() => {});
    return operation;
  }

  async sendWithRetry(body) {
    for (let attempt = 0; ; attempt++) {
      if (this.stopped || this.controller.signal.aborted) {
        const error = new Error("signaling session is stopped");
        error.name = "AbortError";
        throw error;
      }
      const attemptController = new AbortController();
      let timedOut = false;
      const forwardAbort = () => attemptController.abort();
      const timer = setTimeout(() => {
        timedOut = true;
        attemptController.abort();
      }, 5_000);
      this.controller.signal.addEventListener("abort", forwardAbort, { once: true });
      try {
        const response = await fetch(`/v1/signal/${encodeURIComponent(this.roomName)}/b`, {
          method: "POST",
          headers: this.headers({ "content-type": "application/json" }),
          body,
          signal: attemptController.signal,
        });
        await this.responseJson(response);
        return;
      } catch (error) {
        if (this.stopped) throw error;
        if (timedOut) error = new Error("signaling POST timed out after 5000 ms");
        const transient = error.status === undefined || error.status === 408 ||
          error.status === 429 || error.status >= 500;
        if (!transient || attempt >= 5) throw error;
        await this.wait(Math.min(250 * 2 ** attempt, 2_000));
      } finally {
        clearTimeout(timer);
        this.controller.signal.removeEventListener("abort", forwardAbort);
      }
    }
  }

  start() { void this.poll(); }

  wait(delayMs) {
    if (this.controller.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.controller.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, delayMs);
      this.controller.signal.addEventListener("abort", done, { once: true });
    });
  }

  async poll() {
    while (!this.stopped) {
      try {
        const response = await fetch(
          `/v1/signal/${encodeURIComponent(this.roomName)}/a?after=${this.cursor}`,
          { headers: this.headers(), signal: this.controller.signal, cache: "no-store" },
        );
        const batch = await this.responseJson(response);
        for (const entry of batch.messages) {
          try { await this.onMessage(entry.message); }
          catch (error) {
            this.fail(new Error(`could not apply signaling message ${entry.id}: ${error.message}`));
            return;
          }
          this.cursor = entry.id;
        }
        this.cursor = Math.max(this.cursor, batch.cursor);
      } catch (error) {
        if (this.stopped || error.name === "AbortError") return;
        const transient = error.status === undefined || error.status === 408 ||
          error.status === 429 || error.status >= 500;
        if (!transient) {
          this.fail(error);
          return;
        }
        log(`signaling poll failed; retrying: ${error.message}`, "error");
        await this.wait(500);
      }
    }
  }

  fail(error) {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
    this.onFatal?.(error);
  }

  stop() {
    this.stopped = true;
    this.controller.abort();
  }
}

function migrationMaxMessageSize() {
  const negotiated = state.peerConnection?.sctp?.maxMessageSize;
  return negotiated === Infinity || Number.isSafeInteger(negotiated) && negotiated >= 0
    ? negotiated
    : undefined;
}

function registerDataChannel(channel) {
  if (state.channels.has(channel.label)) {
    channel.close();
    throw new Error(`duplicate RTCDataChannel label ${channel.label}`);
  }
  if (channel.label !== OUTBOUND_LABEL && channel.label !== INBOUND_LABEL) {
    channel.close();
    throw new Error(`unexpected RTCDataChannel label ${channel.label}`);
  }
  if (!channel.ordered || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
    channel.close();
    throw new Error(`channel ${channel.label} is not reliable and ordered`);
  }
  if (channel.protocol !== WEAVE_DATA_CHANNEL_PROTOCOL) {
    channel.close();
    throw new Error(
      `channel ${channel.label} uses protocol ${channel.protocol || "<empty>"}, expected ${WEAVE_DATA_CHANNEL_PROTOCOL}`,
    );
  }
  state.channels.set(channel.label, channel);
  let opened = false;
  const markOpen = () => {
    if (opened) return;
    opened = true;
    log(`${channel.label} data channel open`, "wire");
    refreshControls();
  };
  channel.addEventListener("open", markOpen);
  channel.addEventListener("close", () => {
    log(`${channel.label} data channel closed`);
    refreshControls();
  });
  channel.addEventListener("error", () => log(`${channel.label} data channel failed`, "error"));
  if (channel.readyState === "open") queueMicrotask(markOpen);
}

async function updateSelectedPath() {
  if (!state.session || state.peerConnection?.connectionState !== "connected") return;
  try {
    const selected = await getSelectedCandidatePath(state.session);
    if (!selected) return;
    elements.metricPath.textContent = selected.relayed
      ? `TURN relay (${selected.protocol})`
      : `${selected.localCandidateType} ↔ ${selected.remoteCandidateType} (${selected.protocol})`;
  } catch {
    // Candidate statistics are diagnostic and differ slightly by browser.
  }
}

async function startPeerConnection() {
  const configResponse = await fetch("/v1/config", {
    cache: "no-store",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (configResponse.status === 401) {
    throw new Error("this signaling server requires a token in the URL fragment");
  }
  if (!configResponse.ok) throw new Error(`config returned HTTP ${configResponse.status}`);
  const config = await configResponse.json();

  let signaling;
  const session = new WebRTCSession({
    role: "offerer",
    rtcConfiguration: { iceServers: config.iceServers },
    // A developer may leave the printed URL unopened while inspecting the
    // native processes. The controller and CI impose their own deadlines.
    connectTimeoutMs: 0,
    sendSignal(message) { return signaling.send(message); },
    onDataChannel(channel) {
      try { registerDataChannel(channel); }
      catch (error) {
        try { channel.close(); } catch { /* rejection already reported */ }
        log(`rejected data channel: ${error.message}`, "error");
      }
    },
    onStateChange({ connectionState }) {
      setBadge(
        elements.connectionState,
        connectionState,
        connectionState === "connected"
          ? ""
          : connectionState === "failed" || connectionState === "closed" ? "error" : "busy",
      );
      log(`peer connection ${connectionState}`, connectionState === "failed" ? "error" : "wire");
      if (connectionState === "connected") void updateSelectedPath();
      refreshControls();
    },
    onIceCandidateError(event) {
      log(
        `ICE server error ${event.errorCode ?? ""}: ${event.errorText ?? "candidate gathering failed"}`,
        "error",
      );
    },
    onError(error, { fatal, phase }) {
      if (fatal) log(`WebRTC ${phase} failed: ${error.message}`, "error");
    },
  });
  state.session = session;
  state.peerConnection = session.peerConnection;
  void session.connected.catch(() => {});

  signaling = new SignalingClient({
    roomName: room,
    accessToken: token,
    onMessage(message) { return session.receiveSignal(message); },
    onFatal(error) {
      session.fail(error);
      setBadge(elements.connectionState, "signaling failed", "error");
      log(`signaling session stopped: ${error.message}; restart the demo`, "error");
      refreshControls();
    },
  });
  state.signaling = signaling;
  void session.closed.then(() => {
    if (state.signaling === signaling) signaling.stop();
  });

  session.createDataChannel(OUTBOUND_LABEL, {
    ordered: true,
    protocol: WEAVE_DATA_CHANNEL_PROTOCOL,
  });
  session.createDataChannel(INBOUND_LABEL, {
    ordered: true,
    protocol: WEAVE_DATA_CHANNEL_PROTOCOL,
  });
  await session.start();
  signaling.start();
  log("offer published; waiting for the native sidecar answer", "wire");
  state.statsTimer = setInterval(() => { void updateSelectedPath(); }, 2_000);
}

function byteHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function loadModule() {
  const response = await fetch("/counter.woven.wasm", {
    cache: "no-store",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error(`module returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const meta = extractMeta(bytes);
  state.moduleBytes = bytes;
  state.moduleMeta = meta;
  state.moduleHashHex = byteHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  elements.entry.replaceChildren(...meta.entries.map((entry) => {
    const option = document.createElement("option");
    option.value = entry.name;
    option.textContent = `${entry.name} (${entry.params.join(", ")})`;
    return option;
  }));
  elements.entry.disabled = false;
  elements.moduleDetail.textContent = `${bytes.length.toLocaleString()} bytes · ${meta.memories.length} memory export(s) · poll period ${meta.pollPeriod}`;
  setBadge(elements.moduleState, "woven module", "");
  log(`loaded counter.woven.wasm (${state.moduleHashHex.slice(0, 12)}…)`);
  refreshControls();
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

function breathe() { return new Promise((resolve) => setTimeout(resolve, 0)); }

async function closeQuietly(stream) {
  if (!stream) return;
  try { await stream.close(); } catch { /* already failed */ }
}

async function driveWorkload(instance, entry, args) {
  state.active = instance;
  state.location = "browser";
  elements.metricPages.textContent = "0";
  setBadge(elements.runtimeState, "running", "");
  log(entry === null ? "resuming received workload in browser" : `starting ${entry} in browser`);
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
          state.usedOutbound = true;
          try {
            setBadge(elements.runtimeState, "connecting", "busy");
            stream = new RTCDataChannelByteStream(state.channels.get(OUTBOUND_LABEL), {
              connectTimeoutMs: 0,
              highWaterMark: 2 * 1024 * 1024,
              maxMessageSize: migrationMaxMessageSize(),
            });
            state.outboundStream = stream;
            migration = new SourceMigration(stream, instance, "chrome-sidecar", {
              budgetBytes: 2 * 1024 * 1024,
              dirtyPageThreshold: 64,
              maxRounds: 10,
            });
            await migration.handshake();
            setBadge(elements.runtimeState, "pre-copy", "busy");
            log("sidecar connected the browser channel to the native TCP target", "wire");
          } catch (error) {
            await closeQuietly(stream);
            state.outboundStream = null;
            state.migrationRequested = false;
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
            state.outboundStream = null;
            migration = null;
            state.migrationRequested = false;
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
        log(`workload completed in browser: ${renderValues(outcome.results)}`);
        state.location = "none";
        setBadge(elements.runtimeState, "complete", "");
        return;
      }

      try {
        setBadge(elements.runtimeState, "stop + copy", "busy");
        const stats = await migration.finish();
        elements.metricPages.textContent = stats.totalPages.toLocaleString();
        void closeQuietly(migration.t);
        state.outboundStream = null;
        state.location = "native";
        state.active = null;
        if (stats.commitConfirmed) {
          log(`migration committed to native: ${stats.rounds} round(s), ${stats.totalPages} page sends, ${stats.finalPages} during pause`, "wire");
          setBadge(elements.runtimeState, "migrated", "");
        } else {
          log(`migration commit confirmation lost; browser retired without rollback: ${stats.commitError}`, "error");
          setBadge(elements.runtimeState, "commit uncertain", "error");
        }
        return;
      } catch (error) {
        await closeQuietly(migration?.t);
        state.outboundStream = null;
        log(`final copy failed; rewinding locally: ${error.message}`, "error");
        migration = null;
        state.migrationRequested = false;
        setBadge(elements.runtimeState, "running", "");
        phaseEntry = null;
        phaseArgs = null;
        refreshControls();
      }
    }
  } catch (error) {
    state.location = "none";
    setBadge(elements.runtimeState, "failed", "error");
    log(`workload failed: ${error.stack ?? error}`, "error");
  } finally {
    state.active = null;
    state.runner = null;
    state.migrationRequested = false;
    refreshControls();
  }
}

async function startBrowserWorkload() {
  if (!state.moduleBytes || state.starting || state.runner || state.accepting || state.everStarted) return;
  state.starting = true;
  refreshControls();
  try {
    const entry = elements.entry.value;
    const args = parseEntryArgs(state.moduleMeta, entry, elements.entryArgs.value);
    const instance = new WeaveInstance(state.moduleBytes, makeEmitServices(), { yieldMs: 25 });
    setBadge(elements.runtimeState, "instantiating", "busy");
    await instance.instantiate();
    instance.init();
    state.everStarted = true;
    state.runner = driveWorkload(instance, entry, args);
    state.starting = false;
    refreshControls();
    await state.runner;
  } catch (error) {
    state.location = "none";
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
  if (state.starting || state.runner || state.accepting || state.usedInbound || !state.moduleBytes) return;
  state.accepting = true;
  state.usedInbound = true;
  state.incomingController = new AbortController();
  setBadge(elements.runtimeState, "armed", "busy");
  log("browser target armed; run the controller's native return command", "wire");
  refreshControls();

  try {
    const stream = new RTCDataChannelByteStream(state.channels.get(INBOUND_LABEL), {
      signal: state.incomingController.signal,
      connectTimeoutMs: 0,
      highWaterMark: 2 * 1024 * 1024,
      maxMessageSize: migrationMaxMessageSize(),
    });
    state.incomingStream = stream;
    const { inst, sourceRuntime, commitAckError } = await acceptMigration(
      stream,
      makeEmitServices,
      {
        runtimeName: "chrome-sidecar",
        moduleCache: state.moduleCache,
        yieldMs: 25,
        maxModuleBytes: state.moduleBytes.length,
        maxMemoryBytes: 64 * 1024 * 1024,
        authorizeOffer({ moduleHashHex, moduleSize }) {
          return moduleHashHex === state.moduleHashHex && moduleSize === state.moduleBytes.length
            ? true
            : "this demo accepts only the generated module served for this room";
        },
      },
    );
    void closeQuietly(stream);
    state.incomingStream = null;
    state.incomingController = null;
    state.accepting = false;
    state.location = "browser";
    log(`accepted and verified workload from ${sourceRuntime}`, "wire");
    if (commitAckError) {
      log(`COMMIT arrived but COMMIT_OK delivery failed; browser resumes as owner: ${commitAckError}`, "error");
    }
    state.runner = driveWorkload(inst, null, null);
    refreshControls();
    await state.runner;
  } catch (error) {
    const cancelled = state.incomingController?.signal.aborted;
    await closeQuietly(state.incomingStream);
    state.incomingStream = null;
    state.incomingController = null;
    state.accepting = false;
    setBadge(
      elements.runtimeState,
      cancelled ? "incoming cancelled" : "incoming failed",
      cancelled ? "muted" : "error",
    );
    log(
      cancelled ? "incoming migration cancelled" : `incoming migration failed: ${error.message}`,
      cancelled ? "info" : "error",
    );
    refreshControls();
  }
}

function requestMigration() {
  if (!state.active || !state.runner || state.migrationRequested || state.usedOutbound) return;
  state.migrationRequested = true;
  setBadge(elements.runtimeState, "queued", "busy");
  log("migration to native requested; waiting for the next guest poll", "wire");
  refreshControls();
}

function cancelBrowserTarget() {
  state.incomingController?.abort();
  void closeQuietly(state.incomingStream);
}

elements.startWorkload.addEventListener("click", () => { void startBrowserWorkload(); });
elements.migrateWorkload.addEventListener("click", requestMigration);
elements.armTarget.addEventListener("click", () => { void armBrowserTarget(); });
elements.cancelTarget.addEventListener("click", cancelBrowserTarget);
elements.clearLog.addEventListener("click", () => {
  state.logLines = [];
  elements.log.textContent = "";
});

window.addEventListener("pagehide", () => {
  if (state.statsTimer !== null) clearInterval(state.statsTimer);
  state.signaling?.stop();
  state.incomingController?.abort();
  void closeQuietly(state.incomingStream);
  void closeQuietly(state.outboundStream);
  void state.session?.close();
});

log("sidecar demo initialized");
refreshControls();
Promise.all([loadModule(), startPeerConnection()]).catch((error) => {
  setBadge(elements.runtimeState, "startup failed", "error");
  log(`startup failed: ${error.stack ?? error}`, "error");
  refreshControls();
});
