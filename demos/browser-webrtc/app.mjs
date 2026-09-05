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

const $ = (selector) => document.querySelector(selector);
const elements = {
  peerRole: $("#peer-role"),
  roomName: $("#room-name"),
  peerAUrl: $("#peer-a-url"),
  peerBUrl: $("#peer-b-url"),
  copyOther: $("#copy-other"),
  connectionState: $("#connection-state"),
  moduleState: $("#module-state"),
  moduleDetail: $("#module-detail"),
  entry: $("#entry"),
  entryArgs: $("#entry-args"),
  startWorkload: $("#start-workload"),
  migrateWorkload: $("#migrate-workload"),
  runtimeState: $("#runtime-state"),
  metricOwner: $("#metric-owner"),
  metricPolls: $("#metric-polls"),
  metricPages: $("#metric-pages"),
  metricPath: $("#metric-path"),
  clearLog: $("#clear-log"),
  log: $("#log"),
};

function randomRoom() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
const peer = fragment.get("peer") === "b" ? "b" : "a";
const otherPeer = peer === "a" ? "b" : "a";
const room = /^[A-Za-z0-9_-]{1,64}$/.test(fragment.get("room") ?? "")
  ? fragment.get("room")
  : randomRoom();
const token = fragment.get("token") ?? "";
fragment.set("room", room);
fragment.set("peer", peer);
if (token) fragment.set("token", token);
history.replaceState(null, "", `#${fragment}`);

const state = {
  session: null,
  peerConnection: null,
  signaling: null,
  channels: new Map(),
  control: null,
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
  pendingArm: null,
  usedInbound: new Set(),
  usedOutbound: new Set(),
  everStarted: false,
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

function outboundLabel() { return `${peer}-to-${otherPeer}`; }
function inboundLabel() { return `${otherPeer}-to-${peer}`; }

function dataPlaneReady() {
  return state.control?.readyState === "open" &&
    state.channels.get(outboundLabel())?.readyState === "open" &&
    state.channels.get(inboundLabel())?.readyState === "open";
}

function outboundReady() {
  return state.control?.readyState === "open" &&
    state.channels.get(outboundLabel())?.readyState === "open";
}

function refreshControls() {
  const running = state.active !== null && state.runner !== null;
  const ready = dataPlaneReady();
  elements.startWorkload.disabled = peer !== "a" || state.everStarted || !state.moduleBytes || !ready || running || state.starting || state.accepting;
  elements.migrateWorkload.disabled = !running || !outboundReady() || state.migrationRequested || state.pendingArm !== null || state.usedOutbound.has(outboundLabel());
  elements.metricOwner.textContent = running
    ? `peer ${peer.toUpperCase()}`
    : state.accepting ? `peer ${peer.toUpperCase()} (staging)` : "none";
  elements.metricPolls.textContent = state.active?.pollCount?.toLocaleString() ?? "0";
}

class SignalingClient {
  constructor({ roomName, peerName, accessToken, onMessage, onFatal }) {
    this.roomName = roomName;
    this.peerName = peerName;
    this.otherName = peerName === "a" ? "b" : "a";
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
    // Keep one request ID across retries. The server deduplicates it, so a
    // response lost after acceptance cannot apply SDP/ICE twice.
    const body = JSON.stringify({
      from: this.peerName,
      requestId: randomRoom(),
      message,
    });
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
        const response = await fetch(`/v1/signal/${encodeURIComponent(this.roomName)}/${this.otherName}`, {
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
        const transient = error.status === undefined || error.status === 408 || error.status === 429 || error.status >= 500;
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
          `/v1/signal/${encodeURIComponent(this.roomName)}/${this.peerName}?after=${this.cursor}`,
          { headers: this.headers(), signal: this.controller.signal, cache: "no-store" },
        );
        const batch = await this.responseJson(response);
        for (const entry of batch.messages) {
          try {
            await this.onMessage(entry.message);
          } catch (error) {
            // WebRTC description application is stateful and not generally
            // replay-safe. Stop this session instead of retrying a message
            // after it may already have mutated RTCPeerConnection.
            this.fail(new Error(`could not apply signaling message ${entry.id}: ${error.message}`));
            return;
          }
          this.cursor = entry.id;
        }
        this.cursor = Math.max(this.cursor, batch.cursor);
      } catch (error) {
        if (this.stopped || error.name === "AbortError") return;
        const transient = error.status === undefined || error.status === 408 || error.status === 429 || error.status >= 500;
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

function controlSend(message) {
  if (state.control?.readyState !== "open") throw new Error("control channel is not open");
  state.control.send(JSON.stringify(message));
}

function migrationMaxMessageSize() {
  const negotiated = state.peerConnection?.sctp?.maxMessageSize;
  return negotiated === Infinity || Number.isSafeInteger(negotiated) && negotiated >= 0
    ? negotiated
    : undefined;
}

function byteHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function registerDataChannel(channel) {
  if (state.channels.has(channel.label)) {
    channel.close();
    throw new Error(`duplicate RTCDataChannel label ${channel.label}`);
  }
  const allowed = new Set(["control", "a-to-b", "b-to-a"]);
  if (!allowed.has(channel.label)) {
    channel.close();
    throw new Error(`unexpected RTCDataChannel label ${channel.label}`);
  }
  if (!channel.ordered || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
    channel.close();
    throw new Error(`channel ${channel.label} is not reliable and ordered`);
  }
  const expectedProtocol = channel.label === "control" ? "weave.control.v1" : WEAVE_DATA_CHANNEL_PROTOCOL;
  if (channel.protocol !== expectedProtocol) {
    channel.close();
    throw new Error(`channel ${channel.label} uses protocol ${channel.protocol || "<empty>"}, expected ${expectedProtocol}`);
  }
  state.channels.set(channel.label, channel);
  let opened = false;
  const markOpen = () => {
    if (opened) return;
    opened = true;
    log(`${channel.label} data channel open`, "wire");
    if (channel.label === "control") {
      state.control = channel;
      channel.addEventListener("message", (event) => { void handleControlMessage(event.data); });
    }
    refreshControls();
  };
  channel.addEventListener("open", markOpen);
  channel.addEventListener("close", () => {
    log(`${channel.label} data channel closed`);
    if (channel.label === "control") state.control = null;
    if (channel.label === "control" || state.pendingArm?.label === channel.label) {
      state.pendingArm?.reject(new Error(`${channel.label} data channel closed while arming`));
    }
    refreshControls();
  });
  channel.addEventListener("error", () => log(`${channel.label} data channel failed`, "error"));
  if (channel.readyState === "open") {
    queueMicrotask(() => {
      if (channel.readyState === "open") markOpen();
    });
  }
}

async function handleControlMessage(raw) {
  try {
    if (typeof raw !== "string" || raw.length > 16 * 1024) throw new Error("invalid control message");
    const message = JSON.parse(raw);
    switch (message.type) {
      case "prepare-migration":
        await armIncomingMigration(message.channel);
        break;
      case "migration-armed":
        if (state.pendingArm?.label === message.channel) state.pendingArm.resolve();
        break;
      case "migration-rejected":
        if (state.pendingArm?.label === message.channel) {
          state.pendingArm.reject(new Error(message.reason || "target rejected migration"));
        }
        break;
      case "cancel-migration":
        if (message.channel === inboundLabel()) state.incomingController?.abort();
        break;
      default:
        throw new Error(`unknown control message ${message.type}`);
    }
  } catch (error) {
    log(`control message failed: ${error.message}`, "error");
  }
}

async function armIncomingMigration(label) {
  const reject = (reason) => {
    controlSend({ type: "migration-rejected", channel: label, reason });
    log(`rejected incoming migration: ${reason}`, "error");
  };
  if (label !== inboundLabel()) return reject(`unexpected channel ${label}`);
  if (state.starting || state.active || state.runner || state.accepting) return reject("target already owns or stages a workload");
  if (state.usedInbound.has(label)) return reject("migration channel has already been used");
  if (!state.moduleBytes || !state.moduleHashHex) return reject("target module policy is not ready");
  const channel = state.channels.get(label);
  if (channel?.readyState !== "open") return reject("migration channel is not open");

  let stream = null;
  let controller = null;
  try {
    state.accepting = true;
    state.usedInbound.add(label);
    controller = new AbortController();
    state.incomingController = controller;
    setBadge(elements.runtimeState, "staging incoming", "busy");
    refreshControls();
    stream = new RTCDataChannelByteStream(channel, {
      signal: controller.signal,
      connectTimeoutMs: 0,
      highWaterMark: 2 * 1024 * 1024,
      maxMessageSize: migrationMaxMessageSize(),
    });
    state.incomingStream = stream;
    // acceptMigration reaches its first read before the acknowledgement is
    // sent, so HELLO cannot race ahead of an armed target reader. Attach a
    // handler immediately because publishing the acknowledgement can fail.
    const acceptance = acceptMigration(stream, makeEmitServices, {
      runtimeName: `chrome-${peer}`,
      moduleCache: state.moduleCache,
      yieldMs: 25,
      maxModuleBytes: state.moduleBytes.length,
      maxMemoryBytes: 64 * 1024 * 1024,
      authorizeOffer({ moduleHashHex, moduleSize }) {
        return moduleHashHex === state.moduleHashHex && moduleSize === state.moduleBytes.length
          ? true
          : "this demo accepts only the module served for this room";
      },
    });
    void acceptance.catch(() => {});
    controlSend({ type: "migration-armed", channel: label });
    log(`armed ${label} for an incoming Weave session`, "wire");

    const { inst, sourceRuntime, commitAckError } = await acceptance;
    void closeQuietly(stream);
    state.incomingStream = null;
    state.incomingController = null;
    state.accepting = false;
    state.everStarted = true;
    log(`accepted and verified workload from ${sourceRuntime}`, "wire");
    if (commitAckError) log(`target owns state, but COMMIT_OK delivery failed: ${commitAckError}`, "error");
    state.runner = driveWorkload(inst, null, null);
    refreshControls();
    await state.runner;
  } catch (error) {
    const cancelled = controller?.signal.aborted;
    if (!cancelled) controller?.abort();
    await closeQuietly(stream);
    state.incomingStream = null;
    state.incomingController = null;
    state.accepting = false;
    setBadge(elements.runtimeState, cancelled ? "incoming cancelled" : "incoming failed", cancelled ? "muted" : "error");
    log(cancelled ? "incoming migration cancelled" : `incoming migration failed: ${error.message}`, cancelled ? "info" : "error");
    refreshControls();
  }
}

async function updateSelectedPath() {
  if (!state.session || state.peerConnection?.connectionState !== "connected") return;
  try {
    const path = await getSelectedCandidatePath(state.peerConnection);
    if (!path) return;
    elements.metricPath.textContent = path.relayed
      ? `TURN relay (${path.protocol ?? "unknown"})`
      : `${path.localCandidateType ?? "direct"} ↔ ${path.remoteCandidateType ?? "direct"} (${path.protocol ?? "unknown"})`;
  } catch {
    // Stats availability differs slightly among browsers; it is diagnostic.
  }
}

async function startPeerConnection() {
  const configResponse = await fetch("/v1/config", {
    cache: "no-store",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (configResponse.status === 401) throw new Error("this signaling server requires a token in the URL fragment");
  if (!configResponse.ok) throw new Error(`config returned HTTP ${configResponse.status}`);
  const config = await configResponse.json();
  if (config.tokenRequired && !token) throw new Error("this signaling server requires a token in the URL fragment");

  let signaling;
  const session = new WebRTCSession({
    role: peer === "a" ? "offerer" : "answerer",
    rtcConfiguration: { iceServers: config.iceServers },
    // A human may copy the link and open peer B long after peer A starts.
    connectTimeoutMs: 0,
    sendSignal(message) {
      return signaling.send(message);
    },
    onDataChannel(channel) {
      try {
        registerDataChannel(channel);
      } catch (error) {
        try { channel.close(); } catch { /* rejection is already being reported */ }
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
      log(
        `peer connection ${connectionState}`,
        connectionState === "failed" ? "error" : "wire",
      );
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
  // The demo waits for connection state and its explicit three-channel gate
  // independently. Observe terminal pre-connection failures without leaving
  // an unhandled promise rejection in a human-driven page.
  void session.connected.catch(() => {});

  signaling = new SignalingClient({
    roomName: room,
    peerName: peer,
    accessToken: token,
    onMessage(message) {
      return session.receiveSignal(message);
    },
    onFatal(error) {
      session.fail(error);
      setBadge(elements.connectionState, "signaling failed", "error");
      log(`signaling session stopped: ${error.message}; reload both peers`, "error");
      refreshControls();
    },
  });
  state.signaling = signaling;
  void session.closed.then(() => {
    if (state.signaling === signaling) signaling.stop();
  });

  if (peer === "a") {
    for (const [label, protocol] of [
      ["control", "weave.control.v1"],
      ["a-to-b", WEAVE_DATA_CHANNEL_PROTOCOL],
      ["b-to-a", WEAVE_DATA_CHANNEL_PROTOCOL],
    ]) {
      session.createDataChannel(label, { ordered: true, protocol });
    }
  }

  // Construction, callbacks, and the package's PeerConnection listeners are
  // complete before polling can deliver a pre-existing offer or candidate.
  await session.start();
  signaling.start();

  if (peer === "a") {
    log("offer published; open the peer B link", "wire");
  } else {
    log("waiting for peer A's offer", "wire");
  }

  state.statsTimer = setInterval(() => { void updateSelectedPath(); }, 2_000);
}

const MASK64 = (1n << 64n) - 1n;
const signed64 = (value) => BigInt.asIntN(64, value & MASK64);

function makeEmitServices() {
  const serviceState = { count: 0n, sum: 0n };
  return new Map([["env.emit", {
    imports: { env: { emit(index, hash) {
      serviceState.count += 1n;
      serviceState.sum = signed64(serviceState.sum + hash + BigInt(index));
      log(`EMIT ${index} ${hash}`);
    } } },
    snapshot() {
      const bytes = new Uint8Array(16);
      const view = new DataView(bytes.buffer);
      view.setBigUint64(0, serviceState.count & MASK64, true);
      view.setBigInt64(8, signed64(serviceState.sum), true);
      return bytes;
    },
    restore(bytes) {
      if (bytes.length !== 16) throw new Error("env.emit service snapshot is not 16 bytes");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      serviceState.count = view.getBigUint64(0, true);
      serviceState.sum = view.getBigInt64(8, true);
    },
  }]]);
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
  elements.metricPages.textContent = "0";
  setBadge(elements.runtimeState, "running", "");
  log(entry === null ? `resuming workload in peer ${peer.toUpperCase()}` : `starting ${entry} in peer ${peer.toUpperCase()}`);
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
          try {
            setBadge(elements.runtimeState, "handshaking", "busy");
            migration = new SourceMigration(state.outboundStream, instance, `chrome-${peer}`, {
              budgetBytes: 2 * 1024 * 1024,
              dirtyPageThreshold: 64,
              maxRounds: 10,
            });
            await migration.handshake();
            setBadge(elements.runtimeState, "pre-copy", "busy");
            log(`WebRTC migration handshake complete on ${outboundLabel()}`, "wire");
          } catch (error) {
            await closeQuietly(state.outboundStream);
            state.outboundStream = null;
            state.migrationRequested = false;
            migration = null;
            setBadge(elements.runtimeState, "running", "");
            log(`migration could not start; continuing locally: ${error.message}`, "error");
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
            state.outboundStream = null;
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
        log(`workload completed in peer ${peer.toUpperCase()}: ${renderValues(outcome.results)}`);
        setBadge(elements.runtimeState, "complete", "");
        return;
      }

      try {
        setBadge(elements.runtimeState, "stop + copy", "busy");
        const stats = await migration.finish();
        elements.metricPages.textContent = stats.totalPages.toLocaleString();
        void closeQuietly(migration.t);
        if (stats.commitConfirmed) {
          log(`migration committed: ${stats.rounds} round(s), ${stats.totalPages} page sends, ${stats.finalPages} during pause`, "wire");
          setBadge(elements.runtimeState, "migrated", "");
        } else {
          log(`commit confirmation lost; source retired: ${stats.commitError}`, "error");
          setBadge(elements.runtimeState, "commit uncertain", "error");
        }
        state.active = null;
        return;
      } catch (error) {
        await closeQuietly(migration?.t);
        log(`final copy failed; rewinding locally: ${error.message}`, "error");
        migration = null;
        state.outboundStream = null;
        state.migrationRequested = false;
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
    if (state.pendingArm?.instance === instance) {
      state.pendingArm.reject(new Error("workload stopped before target was armed"));
    }
    if (state.outboundStream) {
      // ACK can queue a stream after the guest's last poll. If it completes
      // before a migration driver starts, release the peer's armed wait too.
      if (!migration) {
        try { controlSend({ type: "cancel-migration", channel: outboundLabel() }); }
        catch { /* the data channel close also releases the target */ }
      }
      // Never let a close handshake delay post-COMMIT source retirement.
      void closeQuietly(state.outboundStream);
    }
    state.active = null;
    state.runner = null;
    state.migrationRequested = false;
    state.outboundStream = null;
    refreshControls();
  }
}

async function loadModule() {
  const response = await fetch("/counter.woven.wasm", {
    cache: "no-store",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error((await response.text()).trim());
  const bytes = new Uint8Array(await response.arrayBuffer());
  const meta = extractMeta(bytes);
  const moduleHash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  state.moduleBytes = bytes;
  state.moduleHashHex = byteHex(moduleHash);
  state.moduleCache.set(state.moduleHashHex, bytes);
  state.moduleMeta = meta;
  elements.entry.replaceChildren(...meta.entries.map((entry) => {
    const option = document.createElement("option");
    option.value = entry.name;
    option.textContent = `${entry.name} (${entry.params.join(", ")})`;
    return option;
  }));
  elements.entry.disabled = false;
  elements.moduleDetail.textContent = `${bytes.length.toLocaleString()} bytes · ${meta.memories.length} memory export(s) · poll period ${meta.pollPeriod}`;
  setBadge(elements.moduleState, "woven module", "");
  log("loaded counter.woven.wasm");
  refreshControls();
}

async function startWorkload() {
  if (state.starting || elements.startWorkload.disabled) return;
  state.starting = true;
  refreshControls();
  let runner;
  try {
    const entry = elements.entry.value;
    const args = parseEntryArgs(state.moduleMeta, entry, elements.entryArgs.value);
    const instance = new WeaveInstance(state.moduleBytes, makeEmitServices(), { yieldMs: 25 });
    setBadge(elements.runtimeState, "instantiating", "busy");
    await instance.instantiate();
    instance.init();
    state.everStarted = true;
    runner = driveWorkload(instance, entry, args);
    state.runner = runner;
  } catch (error) {
    state.runner = null;
    state.active = null;
    setBadge(elements.runtimeState, "failed", "error");
    log(`could not start workload: ${error.message}`, "error");
  } finally {
    state.starting = false;
    refreshControls();
  }
  return runner;
}

async function requestMigration() {
  if (state.pendingArm || state.migrationRequested || !state.active || !state.runner || elements.migrateWorkload.disabled) return;
  const label = outboundLabel();
  const channel = state.channels.get(label);
  if (channel?.readyState !== "open") return;

  const instance = state.active;
  const runner = state.runner;
  let resolveArm, rejectArm;
  const armed = new Promise((resolve, reject) => {
    resolveArm = resolve;
    rejectArm = reject;
  });
  // A synchronous send failure or channel-close callback can reject before
  // the await below is reached. Observe the operation from its creation.
  void armed.catch(() => {});
  let timer;
  let settled = false;
  let cancelled = null;
  const pending = {
    label,
    instance,
    resolve() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveArm();
    },
    reject(error) {
      // Cancellation can arrive after ACK resolved the promise but before its
      // continuation runs. Keep that fact even though rejection is now inert.
      cancelled ??= error;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectArm(error);
    },
  };
  // Reserve before refresh/send/await; repeated activation must not overwrite
  // the pending request or leave its ten-second timer behind.
  state.pendingArm = pending;
  timer = setTimeout(() => {
    if (!settled) pending.reject(new Error("target arm timed out after 10 seconds"));
  }, 10_000);
  setBadge(elements.runtimeState, "arming peer", "busy");
  log(`asking peer ${otherPeer.toUpperCase()} to arm ${label}`, "wire");
  refreshControls();

  try {
    controlSend({ type: "prepare-migration", channel: label });
    await armed;
    if (state.pendingArm !== pending) return;
    if (cancelled) throw cancelled;
    if (state.active !== instance || state.runner !== runner) {
      throw new Error("workload stopped before target was armed");
    }
    if (!outboundReady()) throw new Error("migration channel closed while arming");
    state.usedOutbound.add(label);
    state.outboundStream = new RTCDataChannelByteStream(channel, {
      connectTimeoutMs: 0,
      highWaterMark: 2 * 1024 * 1024,
      maxMessageSize: migrationMaxMessageSize(),
    });
    state.migrationRequested = true;
    setBadge(elements.runtimeState, "queued", "busy");
    log("target armed; migration begins at the next guest poll", "wire");
  } catch (error) {
    if (state.pendingArm !== pending) return;
    state.pendingArm = null;
    try { controlSend({ type: "cancel-migration", channel: label }); } catch { /* connection failed */ }
    const stillRunning = state.active === instance && state.runner === runner;
    if (stillRunning) setBadge(elements.runtimeState, "running", "");
    log(`target could not be armed: ${error.message}`, stillRunning ? "error" : "info");
  } finally {
    clearTimeout(timer);
    if (state.pendingArm === pending) state.pendingArm = null;
    refreshControls();
  }
}

function peerUrl(name) {
  const url = new URL(location.href);
  const params = new URLSearchParams({ room, peer: name });
  if (token) params.set("token", token);
  url.hash = params;
  return url.href;
}

elements.peerRole.textContent = `Peer ${peer.toUpperCase()}${peer === "a" ? " · initial source" : " · initial target"}`;
elements.roomName.textContent = room;
elements.peerAUrl.href = peerUrl("a");
elements.peerBUrl.href = peerUrl("b");
elements.copyOther.textContent = `Copy peer ${otherPeer.toUpperCase()} link`;
elements.copyOther.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(peerUrl(otherPeer));
    elements.copyOther.textContent = "Copied";
    setTimeout(() => { elements.copyOther.textContent = `Copy peer ${otherPeer.toUpperCase()} link`; }, 1500);
  } catch (error) {
    log(`could not copy link: ${error.message}`, "error");
  }
});
elements.startWorkload.addEventListener("click", () => { void startWorkload(); });
elements.migrateWorkload.addEventListener("click", () => { void requestMigration(); });
elements.clearLog.addEventListener("click", () => {
  state.logLines = [];
  elements.log.textContent = "";
});
window.addEventListener("pagehide", () => {
  state.pendingArm?.reject(new Error("page closed while arming"));
  clearInterval(state.statsTimer);
  state.signaling?.stop();
  void state.session?.close();
});

setBadge(elements.runtimeState, peer === "a" ? "idle source" : "idle target", "muted");
setBadge(elements.connectionState, "starting", "busy");
elements.metricPath.textContent = "not selected";
log(`peer ${peer.toUpperCase()} joined room ${room}`);
refreshControls();

Promise.all([loadModule(), startPeerConnection()]).catch((error) => {
  state.signaling?.stop();
  void state.session?.close();
  setBadge(elements.connectionState, "setup failed", "error");
  log(`demo setup failed: ${error.stack ?? error}`, "error");
  refreshControls();
});
