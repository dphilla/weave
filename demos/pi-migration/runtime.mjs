import { WeaveInstance, SourceMigration, acceptMigration, sha256, hex } from "../../js/weave.mjs";
import { RTCDataChannelByteStream } from "../../packages/browser-transports/src/index.mjs";
import { WebRTCSession } from "../../packages/webrtc-session/src/index.mjs";
import { TabByteStream } from "./tab-stream.mjs";

// Both transports carry the same unmodified Weave migration protocol. The
// default local stream uses a dedicated, bounded browser channel. Optional
// WebRTC uses BroadcastChannel only for discovery, commands and SDP/ICE.
const VERSION = 1;
const PROTOCOL = "weave.pi.migration.v1";
const NODE_STATES = new Set(["idle", "starting", "running", "connecting", "receiving", "precopy", "finalizing", "retired", "uncertain", "stopped", "failed", "duplicate"]);
const emptyProgress = () => ({ terms: "0", estimate: 0, sequence: "0" });
const messageOf = (error) => error instanceof Error ? error.message : String(error);
const uuid = () => globalThis.crypto.randomUUID();
const cancelledTurn = () => new DOMException("The computation task was cancelled", "AbortError");

// The core driver still yields through its own timer. Crossing a posted-message
// task in our callback breaks a chain of nested timers, which Chrome otherwise
// batches once per minute after a tab has been hidden for five minutes. This is
// one event-loop turn per genuine Wasm safe point, never a busy loop or a fake
// progress timer. Normal browser CPU budgeting and suspension still apply.
export class TaskTurnScheduler {
  constructor(MessageChannelConstructor = globalThis.MessageChannel) {
    if (typeof MessageChannelConstructor !== "function") throw new Error("This browser needs MessageChannel to schedule background computation");
    this.channel = new MessageChannelConstructor();
    this.pending = null;
    this.nextId = 0;
    this.closed = false;
    this.onMessage = ({ data }) => {
      if (!this.closed && this.pending?.id === data) this._settle();
    };
    this.onMessageError = () => this.close(new Error("The computation task could not be delivered"));
    this.channel.port1.addEventListener("message", this.onMessage);
    this.channel.port1.addEventListener("messageerror", this.onMessageError);
    this.channel.port1.start();
  }

  yield(signal) {
    if (this.closed || signal?.aborted) return Promise.reject(cancelledTurn());
    if (this.pending) return Promise.reject(new Error("A computation task yield is already pending"));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const abort = () => this._settle(cancelledTurn());
      this.pending = { id, resolve, reject, signal, abort };
      signal?.addEventListener("abort", abort, { once: true });
      try { this.channel.port2.postMessage(id); }
      catch (error) { this.close(error); }
    });
  }

  _settle(error = null) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.signal?.removeEventListener("abort", pending.abort);
    if (error) pending.reject(error);
    else pending.resolve();
  }

  close(error = cancelledTurn()) {
    if (this.closed) return;
    this.closed = true;
    this.channel.port1.removeEventListener("message", this.onMessage);
    this.channel.port1.removeEventListener("messageerror", this.onMessageError);
    this.channel.port1.close();
    this.channel.port2.close();
    this._settle(error);
  }
}

export function makeProgressServices(onProgress = () => {}) {
  let terms = 0n;
  let estimate = 0;
  let sequence = 0n;
  return new Map([["demo.pi.progress.v1", {
    imports: { demo: { progress(nextTerms, nextEstimate) {
      if (typeof nextTerms !== "bigint" || nextTerms !== terms + 32768n || !Number.isFinite(nextEstimate)) {
        throw new Error("Pi host progress must be finite and advance exactly 32,768 terms");
      }
      terms = nextTerms;
      estimate = nextEstimate;
      sequence += 1n;
      onProgress({ terms: terms.toString(), estimate, sequence: sequence.toString() }, false);
    } } },
    snapshot() {
      const bytes = new Uint8Array(24);
      const view = new DataView(bytes.buffer);
      view.setBigUint64(0, terms, true);
      view.setFloat64(8, estimate, true);
      view.setBigUint64(16, sequence, true);
      return bytes;
    },
    restore(bytes) {
      if (!(bytes instanceof Uint8Array) || bytes.length !== 24) throw new Error("Pi service snapshot must be 24 bytes");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const nextTerms = view.getBigUint64(0, true);
      const nextEstimate = view.getFloat64(8, true);
      const nextSequence = view.getBigUint64(16, true);
      if (!Number.isFinite(nextEstimate) || nextTerms !== nextSequence * 32768n) {
        throw new Error("Pi service snapshot has inconsistent progress");
      }
      terms = nextTerms;
      estimate = nextEstimate;
      sequence = nextSequence;
      onProgress({ terms: terms.toString(), estimate, sequence: sequence.toString() }, true);
    },
  }]]);
}

export class TabRuntime {
  constructor({ role, nodeId = null, room, wasmBytes, transport = "local", onEvent = () => {}, timeoutMs = 45_000,
    channelFactory = (name) => new BroadcastChannel(name), RTCPeerConnection = globalThis.RTCPeerConnection } = {}) {
    if (role !== "controller" && role !== "node") throw new TypeError("role must be controller or node");
    if (typeof room !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(room)) throw new TypeError("room must be a random URL-safe token");
    if (role === "node" && !/^[1-6]$/.test(String(nodeId))) throw new TypeError("nodeId must be 1 through 6");
    if (!(wasmBytes instanceof Uint8Array)) throw new TypeError("wasmBytes must be Uint8Array");
    if (transport !== "local" && transport !== "webrtc") throw new TypeError("transport must be local or webrtc");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) throw new TypeError("timeoutMs must be at least 100 ms");
    this.role = role;
    this.nodeId = role === "node" ? String(nodeId) : null;
    this.room = room;
    this.transport = transport;
    this.wasmBytes = wasmBytes.slice();
    this.moduleHash = hex(sha256(this.wasmBytes));
    this.moduleCache = new Map([[this.moduleHash, this.wasmBytes]]);
    this.instanceId = uuid();
    this.controllerId = role === "controller" ? this.instanceId : null;
    this.onEvent = onEvent;
    this.timeoutMs = timeoutMs;
    this.RTCPeerConnection = RTCPeerConnection;
    this.channelFactory = channelFactory;
    this.state = "idle";
    this.ownership = "none";
    this.progress = emptyProgress();
    this.everStarted = false;
    this.error = null;
    this.operation = null;
    this.peers = new Map();
    this.pendingCommands = new Map();
    this.commandRecords = new Map();
    this.links = new Map();
    this.instance = null;
    this.runner = null;
    this.driveController = null;
    this.outbound = null;
    this.incoming = null;
    this.closed = false;
    this.initialized = false;
    this.generation = 0;
    this.busy = false;
    this.lastProgressAt = 0;
    this.boundary = null;
  }

  async init() {
    if (this.initialized) return this.getSnapshot();
    if (this.closed) throw new Error("runtime is closed");
    if (this.transport === "webrtc" && typeof this.RTCPeerConnection !== "function") throw new Error("This browser does not support WebRTC DataChannels");
    if (!WebAssembly.validate(this.wasmBytes)) throw new Error("Embedded Pi WebAssembly is invalid");
    this.channel = this.channelFactory(`weave-pi-v1-${this.room}`);
    this.channel.addEventListener("message", this._messageListener = ({ data }) => {
      void this._receive(data).catch((error) => this._log(messageOf(error), "error"));
    });
    this.initialized = true;
    this._post({ type: "hello", peer: this._self() });
    this.heartbeat = setInterval(() => {
      this._presence();
      this._emit({ type: "state" });
    }, 2000);
    this._emit({ type: "state" });
    return this.getSnapshot();
  }

  getSnapshot() {
    const now = Date.now();
    const nodes = [...this.peers.values()].filter((peer) => peer.role === "node").map((peer) => ({
      ...peer, progress: { ...peer.progress }, online: !peer.closed && now - peer.lastSeen < 15_000,
      ownership: peer.closed || now - peer.lastSeen >= 15_000 ? "unknown" : peer.ownership,
      duplicate: [...this.peers.values()].some((other) => other.role === "node" && other.nodeId === peer.nodeId && other.instanceId !== peer.instanceId && !other.closed),
    })).sort((a, b) => Number(a.nodeId) - Number(b.nodeId) || a.instanceId.localeCompare(b.instanceId));
    return {
      role: this.role, nodeId: this.nodeId, instanceId: this.instanceId, transport: this.transport,
      state: this.state, ownership: this.instance?.lifecycle === "retired" ? "retired" : this.ownership,
      everStarted: this.everStarted, progress: { ...this.progress }, nodes,
      operation: this.operation ? { ...this.operation } : null, error: this.error, moduleHash: this.moduleHash,
    };
  }

  _self() {
    return { role: this.role, nodeId: this.nodeId, instanceId: this.instanceId, transport: this.transport,
      state: this.state, ownership: this.instance?.lifecycle === "retired" ? "retired" : this.ownership,
      progress: { ...this.progress }, everStarted: this.everStarted, controllerId: this.controllerId };
  }

  _post(message) {
    if (!this.closed && this.channel) this.channel.postMessage({ version: VERSION, sender: this.instanceId, ...message });
  }

  _emit(event) {
    try { this.onEvent({ nodeId: this.nodeId, timestamp: Date.now(), ...event }); } catch { /* Observers cannot interrupt ownership or cleanup. */ }
  }

  _log(message, level = "info") { this._emit({ type: "log", message, level }); }

  _presence() { this._post({ type: "presence", peer: this._self() }); }

  _setState(state, ownership = this.ownership) {
    this.state = state;
    this.ownership = ownership;
    this._presence();
    this._emit({ type: "state" });
  }

  _setOperation(change) {
    this.operation = { ...this.operation, ...change };
    this._post({ type: "operation", operation: this.operation });
    this._emit({ type: "operation", operation: { ...this.operation } });
  }

  _publishBoundary(kind, operationId = null) {
    const event = { type: "boundary", kind, operationId, nodeId: this.nodeId, ...this.progress };
    this._post({ type: "event", event });
    this._emit(event);
  }

  _services() {
    return makeProgressServices((progress, restored) => {
      this.progress = progress;
      if (restored) return; // A restored snapshot is not another host call.
      if (this.boundary) {
        this._publishBoundary(this.boundary.kind, this.boundary.operationId);
        this.boundary = null;
      }
      if (Date.now() - this.lastProgressAt >= 100) {
        this.lastProgressAt = Date.now();
        this._presence();
        this._post({ type: "event", event: { type: "progress", nodeId: this.nodeId, ...progress } });
        this._emit({ type: "progress", ...progress });
      }
    });
  }

  async _receive(message) {
    if (this.closed || !message || message.version !== VERSION || typeof message.sender !== "string" || message.sender === this.instanceId) return;
    if (message.to && message.to !== this.instanceId) return;
    const { type, sender } = message;
    if (type === "hello" || type === "presence") {
      const peer = message.peer;
      if (!peer || peer.instanceId !== sender || !NODE_STATES.has(peer.state) || !["node", "controller"].includes(peer.role)) return;
      if (peer.role === "node" && !/^[1-6]$/.test(peer.nodeId)) return;
      this.peers.set(sender, { ...peer, lastSeen: Date.now(), closed: false });
      this.everStarted ||= peer.everStarted === true;
      if (peer.transport !== this.transport) {
        this.error = "Tabs in this room use different transport modes. Close them and open a fresh room with one shared mode.";
        if (this.role === "controller") this.busy = true;
      }
      if (this.role === "controller" && peer.role === "node" && peer.controllerId && peer.controllerId !== this.instanceId) {
        this.error = "This room belongs to another controller session. Existing compute tabs keep their workload; close them before opening a fresh room.";
        this.busy = true;
      }
      if (peer.role === "controller") {
        if (this.role === "node" && this.controllerId === null) this.controllerId = sender;
        else if (this.controllerId !== sender) {
          this.error = "Another controller joined this room. Open a fresh demo room; this controller cannot issue commands.";
          if (this.role === "controller") this.busy = true;
        }
      }
      if (this.role === "node" && peer.role === "node" && peer.nodeId === this.nodeId) {
        this.error = `Tab ${this.nodeId} is open more than once. Close the duplicate and use a fresh room.`;
        // A duplicate cannot retire a running workload; prohibit new commands.
        if (!this.instance && !this.incoming && this.state !== "duplicate") this._setState("duplicate", "none");
      }
      // A foreground dashboard probes all nodes. Reply from this message task
      // so idle background tabs are not marked lost merely because Chrome has
      // throttled their own chained heartbeat timers. Node presence does not
      // trigger another reply, and only the pinned controller can probe us.
      if (type === "hello" || (this.role === "node" && peer.role === "controller" && sender === this.controllerId)) this._presence();
      this._emit({ type: "state" });
      return;
    }
    if (type === "bye") {
      const peer = this.peers.get(sender);
      if (peer) this.peers.set(sender, { ...peer, closed: true, lastSeen: Date.now() });
      this._emit({ type: "state" });
      return;
    }
    if (type === "event" && this.peers.get(sender)?.role === "node") {
      const event = message.event;
      if (event?.nodeId === this.peers.get(sender).nodeId && ["progress", "boundary"].includes(event.type)) this._emit(event);
      return;
    }
    if (type === "operation" && this.role === "controller") {
      const next = message.operation;
      if (next?.id === this.operation?.id && this.peers.get(sender)?.nodeId === this.operation.source) {
        this.operation = { ...next };
        this._emit({ type: "operation", operation: { ...next } });
        if (["succeeded", "failed", "uncertain"].includes(next.status)) {
          for (const [commandId, pending] of this.pendingCommands) {
            if (pending.target !== sender || pending.action !== "migrate" || pending.args.id !== next.id) continue;
            clearTimeout(pending.timer);
            this.pendingCommands.delete(commandId);
            pending.resolve({ ...next });
          }
        }
      }
      return;
    }
    if (type === "reply" && this.role === "controller") {
      const pending = this.pendingCommands.get(message.commandId);
      if (!pending || pending.target !== sender) return;
      this.pendingCommands.delete(message.commandId);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || "Node command failed"));
      return;
    }
    if (type === "signal") {
      const link = this.links.get(message.operationId);
      if (!link || !link.session || link.peer !== sender || link.done) return;
      try { await link.session.receiveSignal(message.signal); }
      catch (error) { this._failLink(link, error); }
      return;
    }
    if (type === "command" && this.role === "node" && sender === this.controllerId) {
      if (typeof message.commandId !== "string") return;
      let record = this.commandRecords.get(message.commandId);
      if (!record) {
        if (this.commandRecords.size >= 512 && message.action !== "stop") {
          this._post({ type: "reply", to: sender, commandId: message.commandId, ok: false, error: "This demo room reached its 512-command limit; create a new room." });
          return;
        }
        record = { fingerprint: JSON.stringify([message.action, message.args]), promise: this._handleCommand(message.action, message.args) };
        // Explicit terminal stop remains usable even after the bounded ledger
        // fills. It is inherently idempotent and cannot restart this room.
        if (this.commandRecords.size < 512) this.commandRecords.set(message.commandId, record);
      } else if (record.fingerprint !== JSON.stringify([message.action, message.args])) return;
      try {
        const result = await record.promise;
        this._post({ type: "reply", to: sender, commandId: message.commandId, ok: true, result });
      } catch (error) {
        this._post({ type: "reply", to: sender, commandId: message.commandId, ok: false, error: messageOf(error) });
      }
    }
  }

  _node(nodeId) {
    const matches = this.getSnapshot().nodes.filter((node) => node.nodeId === String(nodeId) && node.online);
    if (matches.length !== 1 || matches[0].duplicate) throw new Error(`Tab ${nodeId} is missing, unresponsive, or duplicated`);
    if (matches[0].transport !== this.transport) throw new Error(`Tab ${nodeId} uses a different transport mode`);
    return matches[0];
  }

  _command(peer, action, args = {}) {
    const commandId = uuid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        reject(new Error(action === "prepare"
          ? "Target preparation timed out; no source migration was requested."
          : `${action} timed out; its outcome is unknown. Do not start another workload. Keep tabs open and inspect their state.`));
      }, this.timeoutMs);
      this.pendingCommands.set(commandId, { target: peer.instanceId, action, args, resolve, reject, timer });
      this._post({ type: "command", to: peer.instanceId, commandId, action, args });
    });
  }

  _requireController() {
    if (this.role !== "controller" || this.closed || !this.initialized) throw new Error("An open initialized controller is required");
    if (this.error) throw new Error(`This controller is blocked: ${this.error}`);
    if (this.busy) throw new Error("Another operation is in progress or this controller is blocked");
  }

  async start(nodeId) {
    this._requireController();
    if (this.everStarted || this.getSnapshot().nodes.some((node) => node.everStarted)) throw new Error("This room already started a workload. Create a new room to restart.");
    const node = this._node(nodeId);
    if (node.state !== "idle") throw new Error("The starting tab is not idle");
    this.busy = true;
    this.everStarted = true; // A lost reply must never permit a second start.
    this._presence();
    try { return await this._command(node, "start"); }
    finally { this.busy = false; this._emit({ type: "state" }); }
  }

  async migrate(sourceId, targetId) {
    this._requireController();
    if (String(sourceId) === String(targetId)) throw new Error("Source and target must be different tabs");
    const source = this._node(sourceId);
    const target = this._node(targetId);
    if (source.state !== "running" || source.ownership !== "retained") throw new Error("Source does not report a running workload");
    if (!["idle", "retired"].includes(target.state)) throw new Error("Target is not available to receive a workload");
    const id = uuid();
    this.busy = true;
    let sourceRequested = false;
    this._setOperation({ id, source: String(sourceId), target: String(targetId), phase: "connecting", status: "pending",
      message: this.transport === "webrtc" ? "Connecting the tabs directly with WebRTC" : "Connecting the tabs with a dedicated bounded browser stream" });
    try {
      await this._command(target, "prepare", { id, source: source.instanceId, sourceId: String(sourceId) });
      sourceRequested = true;
      const result = await this._command(source, "migrate", { id, target: target.instanceId, targetId: String(targetId) });
      this.operation = { ...this.operation, ...result };
      this._emit({ type: "operation", operation: { ...this.operation } });
      return { ...this.operation };
    } catch (error) {
      // A timeout is not evidence that a source retains execution authority.
      const uncertain = sourceRequested && /timed out|outcome is unknown/.test(messageOf(error));
      const message = sourceRequested ? messageOf(error)
        : `Source migration was never requested; source retains execution ownership. ${messageOf(error)}`;
      this.operation = { ...this.operation, phase: uncertain ? "uncertain" : "failed", status: uncertain ? "uncertain" : "failed", message };
      this._emit({ type: "operation", operation: { ...this.operation } });
      throw new Error(message, { cause: error });
    } finally { this.busy = false; this._emit({ type: "state" }); }
  }

  async stopAll() {
    if (this.role !== "controller" || this.closed) throw new Error("An open controller is required");
    // Explicit stop may cancel a pending migration. Never restart in this room.
    this.everStarted = true;
    const allPeers = this.getSnapshot().nodes;
    // Send stop to quiet peers too: a suspended tab can receive the explicit
    // stop when it wakes, even if its acknowledgement misses our deadline.
    const peers = allPeers.filter((node) => !node.closed);
    const results = await Promise.allSettled(peers.map((peer) => this._command(peer, "stop")));
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length) throw new Error(`Could not confirm stop in ${failed.length} tab(s). Close those tabs before creating a new room.`);
    return { stopped: peers.length };
  }

  async _handleCommand(action, args = {}) {
    if (action === "stop") { await this._stop(); return { stopped: true }; }
    if (this.closed || this.state === "stopped" || this.state === "duplicate" || this.error) throw new Error(this.error || "This tab cannot accept commands");
    if (action === "start") {
      if (this.state !== "idle" || this.instance || this.incoming || this.runner) throw new Error("Tab is not idle");
      const generation = this.generation;
      this.everStarted = true;
      this._setState("starting", "none");
      try {
        const inst = new WeaveInstance(this.wasmBytes, this._services(), { yieldMs: 16 });
        await inst.instantiate();
        if (generation !== this.generation || this.closed) throw new Error("Start was cancelled");
        inst.init();
        this.boundary = { kind: "start", operationId: null };
        this._launch(inst, "run", []);
        return { started: this.nodeId };
      } catch (error) {
        if (generation === this.generation) this._setState("failed", "none");
        throw error;
      }
    }
    if (action === "prepare") {
      if (!["idle", "retired"].includes(this.state) || this.instance || this.incoming || this.runner) throw new Error("Target already owns or stages a workload");
      if (typeof args.id !== "string" || this.links.has(args.id) || this.peers.get(args.source)?.nodeId !== args.sourceId) throw new Error("Unknown or reused migration identity");
      const link = this._newLink(args.id, args.source, "answerer");
      link.previousState = this.state;
      link.previousOwnership = this.ownership;
      this.incoming = link;
      this._setState("receiving", "none");
      if (link.session) await link.session.start();
      return { prepared: args.id };
    }
    if (action === "migrate") {
      if (this.state !== "running" || !this.instance || this.outbound) throw new Error("Source is not available for migration");
      if (typeof args.id !== "string" || this.links.has(args.id) || this.peers.get(args.target)?.nodeId !== args.targetId) throw new Error("Unknown or reused migration identity");
      const link = this._newLink(args.id, args.target, "offerer");
      this._setOperation({ id: args.id, source: this.nodeId, target: args.targetId, phase: "connecting", status: "pending",
        message: this.transport === "webrtc" ? "Establishing a reliable DataChannel" : "Establishing an acknowledged browser-local byte stream" });
      this._setState("connecting", "retained");
      try {
        if (link.session) {
          const channel = link.session.createDataChannel("weave-pi", { ordered: true, protocol: PROTOCOL });
          link.stream = this._stream(channel);
          link.ready = Promise.all([link.session.start(), link.stream.opened]);
        } else link.ready = link.stream.opened;
        void link.ready.catch(() => {});
        this.outbound = link;
        return new Promise((resolve) => { link.resolve = resolve; });
      } catch (error) {
        this._disposeLink(link);
        this._setState("running", "retained");
        throw error;
      }
    }
    throw new Error(`Unknown demo command ${action}`);
  }

  _stream(channel) {
    return new RTCDataChannelByteStream(channel, {
      requiredProtocol: PROTOCOL, connectTimeoutMs: 12_000, drainTimeoutMs: 12_000,
      closeTimeoutMs: 1000, maxBufferedBytes: 8 * 1024 * 1024, maxWriteBytes: 4 * 1024 * 1024,
    });
  }

  _newLink(id, peer, role) {
    const link = { id, peer, role, stream: null, done: false, generation: this.generation };
    if (this.transport === "local") {
      link.stream = new TabByteStream({ room: this.room, operationId: id, localId: this.instanceId, remoteId: peer,
        timeoutMs: 12_000, channelFactory: this.channelFactory });
      this.links.set(id, link);
      void link.stream.opened.then(() => {
        if (role === "answerer" && !link.done && link.generation === this.generation && !this.closed) {
          link.accepting = true;
          void this._accept(link);
        }
      }).catch((error) => this._failLink(link, error));
      void link.stream.closed.then((error) => {
        // EOF may follow a successfully delivered COMMIT_OK. Once a reader is
        // armed, its protocol result—not a generic close notification—decides
        // whether this was failure or ordinary post-commit cleanup.
        if (!link.done && role === "answerer" && !link.accepting) this._failLink(link, error ?? new Error("The peer closed its local byte stream"));
      });
      return link;
    }
    link.session = new WebRTCSession({
      role, RTCPeerConnection: this.RTCPeerConnection, rtcConfiguration: { iceServers: [] }, connectTimeoutMs: 12_000,
      sendSignal: (signal) => this._post({ type: "signal", to: peer, operationId: id, signal }),
      onDataChannel: (channel, { origin }) => {
        if (origin !== "remote") return;
        if (role !== "answerer" || link.stream || channel.label !== "weave-pi") { channel.close(); return; }
        try {
          link.stream = this._stream(channel);
          void this._accept(link);
        } catch (error) { this._failLink(link, error); }
      },
      onError: (error, { fatal }) => { if (fatal) this._failLink(link, error); },
    });
    this.links.set(id, link);
    return link;
  }

  _disposeLink(link) {
    if (!link || link.done) return;
    link.done = true;
    if (link.stream) void link.stream.close().catch(() => {});
    if (link.session) void link.session.close();
    this.links.delete(link.id);
  }

  _failLink(link, error) {
    if (link.done) return;
    this._log(`Connection failed: ${messageOf(error)}`, "error");
    this._disposeLink(link);
    if (this.incoming === link) {
      this.incoming = null;
      if (link.generation === this.generation && !this.closed) this._setState(link.previousState ?? "idle", link.previousOwnership ?? "none");
    }
    // The source drive loop owns its rollback/retirement decision.
  }

  async _accept(link) {
    try {
      const { inst, commitAckError } = await acceptMigration(link.stream, () => this._services(), {
        runtimeName: `pi-tab-${this.nodeId}`, moduleCache: this.moduleCache, yieldMs: 16,
        maxModuleBytes: this.wasmBytes.length, maxMemoryBytes: 8 * 1024 * 1024,
        targetReadTimeoutMs: 12_000, targetSessionTimeoutMs: 40_000, commitAckWriteTimeoutMs: 1000,
        authorizeOffer: ({ moduleHashHex, moduleSize }) => moduleHashHex === this.moduleHash && moduleSize === this.wasmBytes.length,
      });
      if (link.generation !== this.generation || this.closed) return; // Explicit stop drops even a just-committed workload.
      this.everStarted = true;
      this.incoming = null;
      this.boundary = { kind: "resume", operationId: link.id };
      if (commitAckError) this._log("Target owns the workload, but the source may not have received commit confirmation", "warning");
      this._launch(inst, null, null);
    } catch (error) {
      if (link.generation === this.generation && !this.closed && this.incoming === link) {
        this.incoming = null;
        this._setState(link.previousState, link.previousOwnership);
        this._log(`Incoming migration failed: ${messageOf(error)}`, "error");
      }
    } finally { this._disposeLink(link); }
  }

  _launch(inst, entry, args) {
    this.instance = inst;
    const controller = new AbortController();
    this.driveController = controller;
    this._setState("running", "retained");
    const runner = this._drive(inst, entry, args, controller);
    this.runner = runner;
    void runner.finally(() => {
      if (this.runner === runner) this.runner = null;
      if (this.instance === inst) this.instance = null;
      if (this.driveController === controller) this.driveController = null;
    }).catch(() => {});
  }

  _completeOutbound(link, change) {
    if (this.outbound === link) this.outbound = null;
    this._setOperation(change);
    link.resolve?.({ ...this.operation });
    this._disposeLink(link);
  }

  async _drive(inst, entry, args, controller) {
    let migration = null;
    let link = null;
    let taskTurns = null;
    try {
      taskTurns = new TaskTurnScheduler();
      for (;;) {
        const outcome = await inst.drive(entry, args, async () => {
          await taskTurns.yield(controller.signal);
          if (!migration && this.outbound) {
            link = this.outbound;
            try {
              await link.ready;
              if (controller.signal.aborted) return "continue";
              migration = new SourceMigration(link.stream, inst, `pi-tab-${this.nodeId}`, {
                budgetBytes: 256 * 1024, dirtyPageThreshold: 4, maxRounds: 4, readTimeoutMs: 12_000, commitTimeoutMs: 4000,
              });
              await migration.handshake();
              this._setState("precopy", "retained");
              this._setOperation({ phase: "precopy", message: "Copying memory while the Wasm computation continues" });
            } catch (error) {
              migration = null;
              this._setState("running", "retained");
              this._completeOutbound(link, { phase: "failed", status: "failed", message: `Connection failed before commit; source continues: ${messageOf(error)}` });
              link = null;
            }
          }
          if (migration) {
            try { if (await migration.precopyStep()) return "hold"; }
            catch (error) {
              migration = null;
              this._setState("running", "retained");
              this._completeOutbound(link, { phase: "failed", status: "failed", message: `Pre-copy failed; source continues: ${messageOf(error)}` });
              link = null;
            }
          }
          return "continue";
        }, { signal: controller.signal });
        if (outcome.status === "done") { this._setState("stopped", "none"); return; }
        this._setState("finalizing", "unknown");
        this._setOperation({ phase: "finalizing", message: "Pausing at a safe point; transferring stack, globals and host-service state" });
        this._publishBoundary("final", link.id);
        try {
          const stats = await migration.finish();
          const status = stats.commitConfirmed ? "succeeded" : "uncertain";
          this._setState(stats.commitConfirmed ? "retired" : "uncertain", "retired");
          this._completeOutbound(link, { phase: stats.commitConfirmed ? "committed" : "uncertain", status,
            message: stats.commitConfirmed ? "Committed. Source retired; target continues the same stack." : `Commit confirmation lost. Source permanently retired: ${stats.commitError}`, ...stats });
          return;
        } catch (error) {
          if (inst.lifecycle === "retired") {
            this._setState("uncertain", "retired");
            this._completeOutbound(link, { phase: "uncertain", status: "uncertain", message: `Source retired: ${messageOf(error)}` });
            return;
          }
          this._setState("running", "retained");
          this._completeOutbound(link, { phase: "failed", status: "failed", message: `Final copy failed before commit; source resumes: ${messageOf(error)}` });
          migration = null;
          link = null;
          entry = null;
          args = null;
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        if (migration && inst.lifecycle !== "retired") { try { await migration.abort(); } catch { /* In-flight transport closes below. */ } }
        this._setState("stopped", "none");
      } else {
        this.error = messageOf(error);
        this._setState(inst.lifecycle === "retired" ? "uncertain" : "failed", inst.lifecycle === "retired" ? "retired" : "none");
        this._log(`Computation stopped: ${messageOf(error)}`, "error");
      }
      if (this.outbound) this._completeOutbound(this.outbound, { phase: "failed", status: "failed", message: controller.signal.aborted ? "Stopped by user" : messageOf(error) });
    } finally { taskTurns?.close(); }
  }

  async _stop() {
    this.generation += 1;
    this.everStarted = true;
    this.driveController?.abort();
    for (const link of [...this.links.values()]) this._disposeLink(link);
    this.incoming = null;
    if (this.runner) await this.runner;
    this.instance = null;
    this._setState("stopped", "none");
  }

  async close() {
    if (this.closed) return;
    this._post({ type: "bye" });
    this.closed = true;
    clearInterval(this.heartbeat);
    if (this.channel) {
      this.channel.removeEventListener("message", this._messageListener);
      this.channel.close();
    }
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Controller closed; command outcome may be unknown"));
    }
    this.pendingCommands.clear();
    // Closing a controller never stops independent compute tabs.
    if (this.role === "node") await this._stop();
  }
}
