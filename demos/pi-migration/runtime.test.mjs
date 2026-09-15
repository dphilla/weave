import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { TabRuntime, TaskTurnScheduler, makeProgressServices } from "./runtime.mjs";
import { loadPiWasm } from "./test-fixture.mjs";

let wasmBytes;
function wasm() { return wasmBytes ??= loadPiWasm(); }
function finitePiWasm() {
  // Keep the genuine transformed arithmetic, nested frames and polls, changing
  // only Pi's 2^51-pair termination bound to 2^20 pairs (64 host progress calls).
  // Fixed-width signed LEB preserves every section size and code offset. This
  // also exercises natural completion in the deliberately CLI-free JS lane.
  const bytes = wasm().slice();
  const originalLimit = Buffer.from([0x42, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x04]);
  const offset = Buffer.from(bytes).indexOf(originalLimit);
  assert.ok(offset >= 0, "transformed Pi must contain its documented i64 pair bound");
  assert.equal(Buffer.from(bytes).indexOf(originalLimit, offset + 1), -1, "the loop-limit instruction must be unambiguous");
  let limit = 1n << 20n;
  for (let index = 1; index < originalLimit.length; index++) {
    bytes[offset + index] = Number(limit & 127n) | (index + 1 < originalLimit.length ? 0x80 : 0);
    limit >>= 7n;
  }
  assert.equal(limit, 0n);
  assert.equal(WebAssembly.validate(bytes), true);
  return bytes;
}
const integration = { timeout: 15_000 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Test condition timed out");
    await sleep(5);
  }
}
async function within(promise, timeout, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
function event(type, values) { const result = new Event(type); Object.assign(result, values); return result; }

class ManualTaskChannel {
  constructor() {
    this.messages = [];
    this.port1 = new EventTarget();
    this.port1.start = () => { this.started = true; };
    this.port1.close = () => { this.firstClosed = true; };
    this.port2 = {
      postMessage: (value) => this.messages.push(value),
      close: () => { this.secondClosed = true; },
    };
  }
  deliver() { this.port1.dispatchEvent(event("message", { data: this.messages.shift() })); }
}

test("task scheduling crosses a real MessageChannel turn and closes both ports", async () => {
  const scheduler = new TaskTurnScheduler();
  try {
    let settled = false;
    const turn = scheduler.yield().then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, "a microtask alone does not complete the task yield");
    await turn;
    assert.equal(settled, true);
    assert.equal(scheduler.pending, null);
  } finally { scheduler.close(); }
  assert.equal(scheduler.closed, true);
  await assert.rejects(scheduler.yield(), { name: "AbortError" });
});

test("task scheduler bounds its queue and cancellation discards stale posted messages", async () => {
  const scheduler = new TaskTurnScheduler(ManualTaskChannel);
  const signal = new AbortController();
  const first = scheduler.yield(signal.signal);
  await assert.rejects(scheduler.yield(), /already pending/);
  signal.abort();
  await assert.rejects(first, { name: "AbortError" });
  const second = scheduler.yield();
  scheduler.channel.deliver(); // The cancelled task's queued message is stale.
  assert.ok(scheduler.pending);
  scheduler.channel.deliver();
  await second;
  assert.equal(scheduler.pending, null);
  scheduler.close();
  assert.ok(scheduler.channel.firstClosed && scheduler.channel.secondClosed);
});

test("closing a task scheduler cancels pending work and removes its delivery listeners", async () => {
  const scheduler = new TaskTurnScheduler(ManualTaskChannel);
  const pending = scheduler.yield();
  scheduler.close();
  scheduler.close();
  await assert.rejects(pending, { name: "AbortError" });
  scheduler.channel.deliver();
  assert.equal(scheduler.pending, null);
  assert.ok(scheduler.channel.firstClosed && scheduler.channel.secondClosed);
  const preCancelled = new AbortController();
  preCancelled.abort();
  const another = new TaskTurnScheduler(ManualTaskChannel);
  await assert.rejects(another.yield(preCancelled.signal), { name: "AbortError" });
  assert.equal(another.channel.messages.length, 0);
  another.close();
});

test("task message delivery failure rejects the wait and releases its ports", async () => {
  const scheduler = new TaskTurnScheduler(ManualTaskChannel);
  const turn = scheduler.yield();
  scheduler.channel.port1.dispatchEvent(new Event("messageerror"));
  await assert.rejects(turn, /could not be delivered/);
  assert.ok(scheduler.closed && scheduler.channel.firstClosed && scheduler.channel.secondClosed);
});

class Bus {
  constructor() { this.channels = new Set(); this.drop = () => false; this.messages = []; }
  open = (name) => {
    const channel = new EventTarget();
    channel.name = name;
    this.channels.add(channel);
    channel.postMessage = (message) => {
      this.messages.push(message);
      if (this.drop(message)) return;
      for (const target of this.channels) {
        if (target !== channel && target.name === name) queueMicrotask(() => {
          if (this.channels.has(target)) target.dispatchEvent(event("message", { data: structuredClone(message) }));
        });
      }
    };
    channel.close = () => this.channels.delete(channel);
    return channel;
  };
}

// A structural browser peer implementation tests our orchestration through the
// actual session, byte-stream and migration libraries. The separate Chrome
// suite verifies real ICE/SCTP, popup policy and browser background scheduling.
class FakeChannel extends EventTarget {
  static intercept = null;
  constructor(label, options) {
    super();
    Object.assign(this, { label, protocol: options.protocol, ordered: true, maxRetransmits: null, maxPacketLifeTime: null,
      readyState: "connecting", bufferedAmount: 0 });
  }
  send(bytes) {
    if (this.readyState !== "open") throw new Error("Channel is not open");
    const copy = bytes.slice();
    if (FakeChannel.intercept?.(copy, this) === false) return;
    queueMicrotask(() => this.remote.dispatchEvent(event("message", { data: copy.buffer })));
  }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    queueMicrotask(() => {
      this.dispatchEvent(new Event("close"));
      if (this.remote && this.remote.readyState !== "closed") this.remote.close();
    });
  }
}
class FakeRTC extends EventTarget {
  static peers = new Map();
  constructor(config) {
    super();
    assert.deepEqual(config.iceServers, []);
    this.id = crypto.randomUUID();
    FakeRTC.peers.set(this.id, this);
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.signalingState = "stable";
    this.channels = [];
    this.sctp = { maxMessageSize: 65536 };
  }
  createDataChannel(label, options) {
    const channel = new FakeChannel(label, options);
    this.channels.push(channel);
    return channel;
  }
  async createOffer() { return { type: "offer", sdp: this.id }; }
  async createAnswer() { return { type: "answer", sdp: this.id }; }
  async setLocalDescription(description) { this.localDescription = description; }
  async addIceCandidate() {}
  async setRemoteDescription(description) {
    this.remoteDescription = description;
    this.remote = FakeRTC.peers.get(description.sdp);
    if (description.type !== "answer") return;
    this.connect(this.remote);
  }
  connect(remote) {
    for (const channel of this.channels) {
      const other = new FakeChannel(channel.label, channel);
      channel.remote = other;
      other.remote = channel;
      remote.channels.push(other);
      remote.dispatchEvent(event("datachannel", { channel: other }));
      for (const endpoint of [channel, other]) {
        endpoint.readyState = "open";
        endpoint.dispatchEvent(new Event("open"));
      }
    }
    for (const peer of [this, remote]) {
      peer.connectionState = "connected";
      peer.iceConnectionState = "connected";
      peer.dispatchEvent(new Event("connectionstatechange"));
    }
  }
  close() {
    this.connectionState = "closed";
    for (const channel of this.channels) channel.close();
    FakeRTC.peers.delete(this.id);
  }
}

// SDP completes normally, but native ICE/SCTP readiness remains pending until
// the test releases it. Holding an SDP promise instead would miss the actual
// browser failure: successful signaling with no usable candidate pair.
function controlledRTC() {
  const attempts = [];
  class DelayedRTC extends FakeRTC {
    connect(remote) {
      attempts.push({
        source: this,
        target: remote,
        release: () => {
          if (this.connectionState === "closed" || remote.connectionState === "closed") {
            // A queued native notification may arrive after close. It must not
            // revive a stopped generation or start a migration.
            for (const peer of [this, remote]) {
              for (const channel of peer.channels) channel.dispatchEvent(new Event("open"));
              peer.dispatchEvent(new Event("connectionstatechange"));
            }
            return;
          }
          super.connect(remote);
        },
        reject: () => {
          for (const peer of [this, remote]) {
            if (peer.connectionState === "closed") continue;
            peer.connectionState = "failed";
            peer.iceConnectionState = "failed";
            peer.dispatchEvent(new Event("connectionstatechange"));
          }
        },
      });
    }
  }
  return { attempts, RTCPeerConnection: DelayedRTC };
}

async function pendingConnection(transport, options = {}) {
  const rtc = controlledRTC();
  const fixture = await room(2, { ...options, transport, RTCPeerConnection: rtc.RTCPeerConnection });
  const held = [];
  const observedChannels = new Set();
  if (transport === "local") fixture.bus.drop = (message) => {
    if (!["hello", "ready"].includes(message.kind)) return false;
    held.push(structuredClone(message));
    return true;
  };
  return {
    ...fixture,
    async pending(attempt = 0) {
      await until(() => fixture.nodes[0].state === "connecting" && fixture.nodes[0].outbound
        && (transport === "webrtc" ? rtc.attempts.length > attempt : held.length > 0));
      if (transport === "local") for (const channel of fixture.bus.channels) {
        if (channel.name.endsWith(`-${fixture.nodes[0].outbound.id}`)) observedChannels.add(channel);
      }
    },
    release(attempt = 0) {
      if (transport === "webrtc") return rtc.attempts[attempt].release();
      fixture.bus.drop = () => false;
      // Replay only the held native transport envelopes to their dedicated
      // channel. No migration bytes or guest checkpoints are synthesized.
      for (const message of held.splice(0)) {
        for (const channel of new Set([...observedChannels, ...fixture.bus.channels])) {
          if (channel.name.endsWith(`-${message.operationId}`)) {
            channel.dispatchEvent(event("message", { data: structuredClone(message) }));
          }
        }
      }
    },
    reject() {
      if (transport === "webrtc") rtc.attempts[0].reject();
      else fixture.nodes[0].outbound.stream.channel.dispatchEvent(new Event("messageerror"));
    },
  };
}

async function assertExactHandoff(fixture, result) {
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  await until(() => fixture.events.some((item) => item.type === "boundary" && item.kind === "resume" && item.operationId === result.id));
  const final = fixture.events.find((item) => item.type === "boundary" && item.kind === "final" && item.operationId === result.id);
  const resumed = fixture.events.find((item) => item.type === "boundary" && item.kind === "resume" && item.operationId === result.id);
  assert.equal(BigInt(resumed.sequence), BigInt(final.sequence) + 1n);
  assert.equal(BigInt(resumed.terms), BigInt(final.terms) + 32768n);
  assert.equal(fixture.nodes.filter((node) => node.ownership === "retained").length, 1);
  assert.equal(fixture.events.filter((item) => item.type === "boundary" && item.kind === "start").length, 1);
}

async function room(count = 2, options = {}) {
  const bus = new Bus();
  const events = [];
  const common = { room: crypto.randomUUID(), wasmBytes: wasm(), transport: "webrtc", channelFactory: bus.open, RTCPeerConnection: FakeRTC, ...options };
  const controller = new TabRuntime({ ...common, role: "controller", onEvent: (item) => events.push(item) });
  const nodes = Array.from({ length: count }, (_, index) => new TabRuntime({ ...common, role: "node", nodeId: String(index + 1) }));
  await controller.init();
  for (const node of nodes) await node.init();
  await until(() => controller.getSnapshot().nodes.length === count && nodes.every((node) => node.controllerId));
  return { bus, controller, nodes, events, async close() { await controller.close(); await Promise.all(nodes.map((node) => node.close())); } };
}

test("portable Pi host service restores exact i64 sequence and f64 estimate", () => {
  const original = makeProgressServices().get("demo.pi.progress.v1");
  original.imports.demo.progress(32768n, 3.1415);
  original.imports.demo.progress(65536n, 3.14159);
  const events = [];
  const restored = makeProgressServices((value, isRestore) => events.push([value, isRestore])).get("demo.pi.progress.v1");
  restored.restore(original.snapshot());
  restored.imports.demo.progress(98304n, 3.141592);
  assert.deepEqual(events, [
    [{ terms: "65536", estimate: 3.14159, sequence: "2" }, true],
    [{ terms: "98304", estimate: 3.141592, sequence: "3" }, false],
  ]);
  assert.throws(() => restored.imports.demo.progress(98304n, 3.14), /32,768/);
  assert.throws(() => restored.imports.demo.progress(163840n, 3.14), /32,768/);
  assert.throws(() => restored.restore(new Uint8Array(16)), /24 bytes/);
  const corrupt = original.snapshot();
  new DataView(corrupt.buffer).setBigUint64(16, 99n, true);
  assert.throws(() => restored.restore(corrupt), /inconsistent/);
});

test("six-tab loop uses real Weave stack and host-service migration without repeated effects", integration, async () => {
  const fixture = await room(6);
  try {
    await fixture.controller.start("1");
    await until(() => BigInt(fixture.nodes[0].progress.sequence) > 1n);
    for (let source = 1; source <= 6; source++) {
      const target = source % 6 + 1;
      const result = await fixture.controller.migrate(String(source), String(target));
      assert.equal(result.status, "succeeded", JSON.stringify(result));
      await until(() => fixture.events.some((item) => item.type === "boundary" && item.kind === "resume" && item.operationId === result.id));
      const final = fixture.events.find((item) => item.type === "boundary" && item.kind === "final" && item.operationId === result.id);
      const resumed = fixture.events.find((item) => item.type === "boundary" && item.kind === "resume" && item.operationId === result.id);
      assert.equal(BigInt(resumed.sequence), BigInt(final.sequence) + 1n);
      assert.equal(BigInt(resumed.terms), BigInt(final.terms) + 32768n);
      assert.equal(fixture.nodes[source - 1].ownership, "retired");
      assert.equal(fixture.nodes.filter((node) => node.instance?.lifecycle === "running" || node.ownership === "retained").length, 1);
    }
    assert.equal(fixture.events.filter((item) => item.type === "boundary" && item.kind === "start").length, 1);
    assert.ok(fixture.bus.messages.some((item) => item.type === "signal"));
    assert.ok(fixture.bus.messages.every((item) => !JSON.stringify(item).includes("wasmBytes")), "No Wasm state is copied through signaling");
    await fixture.controller.stopAll();
    assert.ok(fixture.nodes.every((node) => node.state === "stopped" && !node.instance));
    await assert.rejects(fixture.controller.start("1"), /already started/);
  } finally { await fixture.close(); }
});

test("pending WebRTC readiness keeps real Wasm progressing, then hands off exactly", integration, async () => {
  const rtc = controlledRTC();
  const fixture = await room(2, rtc);
  let moving;
  try {
    await fixture.controller.start("1");
    await until(() => BigInt(fixture.nodes[0].progress.sequence) > 1n);
    moving = fixture.controller.migrate("1", "2");
    void moving.catch(() => {});
    await until(() => rtc.attempts.length === 1 && fixture.nodes[0].state === "connecting");
    const before = BigInt(fixture.nodes[0].progress.sequence);
    await until(() => BigInt(fixture.nodes[0].progress.sequence) >= before + 3n, 2000);
    assert.equal(fixture.nodes[0].ownership, "retained");
    assert.equal(fixture.nodes[1].instance, null);
    assert.ok(!fixture.events.some((item) => item.type === "boundary" && item.kind === "final"));
    rtc.attempts[0].release();
    const result = await moving;
    assert.equal(result.status, "succeeded");
    await until(() => fixture.events.some((item) => item.type === "boundary" && item.kind === "resume" && item.operationId === result.id));
    const final = fixture.events.find((item) => item.type === "boundary" && item.kind === "final" && item.operationId === result.id);
    const resumed = fixture.events.find((item) => item.type === "boundary" && item.kind === "resume" && item.operationId === result.id);
    assert.equal(BigInt(resumed.sequence), BigInt(final.sequence) + 1n);
    assert.equal(BigInt(resumed.terms), BigInt(final.terms) + 32768n);
    assert.equal(fixture.nodes[0].ownership, "retired");
    assert.equal(fixture.nodes[1].ownership, "retained");
  } finally {
    for (const attempt of rtc.attempts) attempt.release();
    await fixture.close();
    await moving?.catch(() => {});
  }
});

test("pending local stream readiness keeps real Wasm progressing, then hands off exactly", integration, async () => {
  const fixture = await pendingConnection("local");
  let moving;
  try {
    await fixture.controller.start("1");
    moving = fixture.controller.migrate("1", "2");
    void moving.catch(() => {});
    await fixture.pending();
    const before = BigInt(fixture.nodes[0].progress.sequence);
    await until(() => BigInt(fixture.nodes[0].progress.sequence) >= before + 3n, 2000);
    assert.equal(fixture.nodes[0].ownership, "retained");
    assert.equal(fixture.nodes[1].instance, null);
    assert.ok(!fixture.events.some((item) => item.type === "boundary" && item.kind === "final"));
    fixture.release();
    await assertExactHandoff(fixture, await moving);
  } finally {
    await fixture.close();
    await moving?.catch(() => {});
  }
});

for (const transport of ["webrtc", "local"]) {
  test(`${transport} natural guest completion settles a pending handoff without a late resume`, integration, async () => {
    const fixture = await pendingConnection(transport, { wasmBytes: finitePiWasm() });
    let moving;
    try {
      const source = fixture.nodes[0];
      const launch = source._launch.bind(source);
      source._launch = (inst, ...args) => {
        // Public poll-count mode guarantees a genuine initial unwind even on
        // machines that could finish this bounded guest within one time slice.
        inst.pollMode = { afterPolls: 1 };
        launch(inst, ...args);
      };
      await fixture.controller.start("1");
      moving = fixture.controller.migrate("1", "2");
      void moving.catch(() => {});
      await fixture.pending();
      const link = source.outbound;
      source.instance.pollMode = "run";
      await until(() => source.state === "stopped" && source.runner === null);
      assert.equal(source.progress.sequence, "64", "the real guest returned after exactly 64 progress calls");
      assert.equal(source.progress.terms, "2097152");
      const result = await within(moving, 2000, "Natural guest completion left the public migration command pending");
      assert.equal(result.status, "failed");
      assert.equal(result.phase, "failed");
      assert.match(result.message, /complet|finish|ended/i);
      assert.equal(fixture.controller.busy, false);
      assert.equal(fixture.controller.pendingCommands.size, 0);
      assert.equal(source.ownership, "none");
      assert.equal(source.instance, null);
      assert.equal(source.outbound, null);
      assert.equal(source.links.size, 0);
      assert.equal(link.done, true);
      fixture.release();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(source.state, "stopped");
      assert.equal(source.progress.sequence, "64");
      assert.equal(fixture.nodes[1].instance, null);
      assert.notEqual(link.readyState, "ready");
      assert.ok(!fixture.events.some((item) => item.type === "boundary" && ["final", "resume"].includes(item.kind)));
    } finally {
      await fixture.close();
      await moving?.catch(() => {});
    }
  });

  test(`${transport} readiness rejection preserves the live source and permits explicit retry`, integration, async () => {
    const fixture = await pendingConnection(transport);
    let moving;
    try {
      await fixture.controller.start("1");
      const original = fixture.nodes[0].instance;
      moving = fixture.controller.migrate("1", "2");
      void moving.catch(() => {});
      await fixture.pending();
      const before = BigInt(fixture.nodes[0].progress.sequence);
      await until(() => BigInt(fixture.nodes[0].progress.sequence) >= before + 3n, 2000);
      fixture.reject();
      const failed = await within(moving, 2000, "A failed connection did not settle its migration command");
      assert.equal(failed.status, "failed");
      assert.match(failed.message, /Connection failed before commit/);
      assert.equal(fixture.nodes[0].instance, original);
      assert.equal(fixture.nodes[0].ownership, "retained");
      await until(() => fixture.nodes[1].state === "idle");
      assert.equal(fixture.nodes[1].instance, null);
      const after = BigInt(fixture.nodes[0].progress.sequence);
      await until(() => BigInt(fixture.nodes[0].progress.sequence) > after);
      moving = fixture.controller.migrate("1", "2");
      void moving.catch(() => {});
      await fixture.pending(1);
      fixture.release(1);
      const result = await moving;
      assert.notEqual(result.id, failed.id);
      await assertExactHandoff(fixture, result);
    } finally {
      await fixture.close();
      await moving?.catch(() => {});
    }
  });

  test(`${transport} keeps computing until its unchanged 12-second readiness deadline, then permits retry`, { timeout: 20_000 }, async () => {
    const fixture = await pendingConnection(transport);
    let moving;
    try {
      await fixture.controller.start("1");
      const started = performance.now();
      moving = fixture.controller.migrate("1", "2");
      void moving.catch(() => {});
      await fixture.pending();
      const before = BigInt(fixture.nodes[0].progress.sequence);
      await until(() => BigInt(fixture.nodes[0].progress.sequence) >= before + 3n, 2000);
      // Sample again near the actual deadline: advancing briefly before a
      // later blocking callback would not prove availability while waiting.
      await until(() => performance.now() - started >= 9000, 10_000);
      assert.equal(fixture.nodes[0].state, "connecting");
      const nearDeadline = BigInt(fixture.nodes[0].progress.sequence);
      await until(() => BigInt(fixture.nodes[0].progress.sequence) >= nearDeadline + 3n, 2000);
      const failed = await within(moving, 16_000, "The production connection deadline did not settle the command");
      assert.ok(performance.now() - started >= 11_000, "the real 12-second deadline was not replaced by an early injected failure");
      assert.equal(failed.status, "failed");
      assert.equal(fixture.nodes[0].ownership, "retained");
      assert.ok(BigInt(fixture.nodes[0].progress.sequence) > before + 3n);
      assert.ok(!fixture.events.some((item) => item.type === "boundary" && item.kind === "final"));
      await until(() => fixture.nodes[1].state === "idle");
      moving = fixture.controller.migrate("1", "2");
      void moving.catch(() => {});
      await fixture.pending(1);
      fixture.release(1);
      await assertExactHandoff(fixture, await moving);
    } finally {
      await fixture.close();
      await moving?.catch(() => {});
    }
  });

  for (const action of ["stop", "close"]) {
    test(`${transport} ${action} during pending readiness settles promptly and ignores late readiness`, integration, async () => {
      const fixture = await pendingConnection(transport);
      let moving;
      try {
        await fixture.controller.start("1");
        moving = fixture.controller.migrate("1", "2");
        void moving.catch(() => {});
        await fixture.pending();
        const source = fixture.nodes[0];
        const link = source.outbound;
        const record = [...source.commandRecords.values()].find((entry) => JSON.parse(entry.fingerprint)[0] === "migrate");
        assert.ok(record, "the real node command ledger owns the pending operation");
        if (action === "stop") {
          await within(fixture.controller.stopAll(), 2000, "Stop All waited for connection readiness");
          assert.equal((await within(moving, 2000, "Stop All left migrate pending")).status, "failed");
        } else {
          await within(source.close(), 2000, "Closing the source waited for connection readiness");
          // A closed node cannot acknowledge over its disposed command channel,
          // but its own command must finish and free the pending guest driver.
          assert.equal((await within(record.promise, 2000, "Source close left its own command pending")).status, "failed");
          await fixture.controller.close();
          await assert.rejects(moving, /Controller closed/);
        }
        const stoppedSequence = source.progress.sequence;
        fixture.release();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(source.state, "stopped");
        assert.equal(source.ownership, "none");
        assert.equal(source.instance, null);
        assert.equal(source.runner, null);
        assert.equal(source.outbound, null);
        assert.equal(source.links.size, 0);
        assert.equal(link.done, true);
        assert.notEqual(link.readyState, "ready", "late readiness revived a disposed transport");
        assert.equal(source.progress.sequence, stoppedSequence);
        assert.equal(fixture.nodes[1].instance, null);
        assert.ok(!fixture.events.some((item) => item.type === "boundary" && ["final", "resume"].includes(item.kind)));
      } finally {
        await fixture.close();
        await moving?.catch(() => {});
      }
    });
  }
}

test("synchronous DataChannel setup failure publishes a terminal operation and disposes its observers", integration, async () => {
  const peers = [];
  class RefusingRTC extends FakeRTC {
    constructor(config) {
      super(config);
      this.listenerTypes = new Set();
      peers.push(this);
    }
    addEventListener(type, listener, options) {
      this.listenerTypes.add(type);
      super.addEventListener(type, listener, options);
    }
    createDataChannel() { throw new Error("Test native createDataChannel refused"); }
    async getStats() { return new Map(); }
  }
  const fixture = await room(2, { RTCPeerConnection: RefusingRTC });
  try {
    await fixture.controller.start("1");
    const original = fixture.nodes[0].instance;
    const result = await within(fixture.controller.migrate("1", "2"), 2000,
      "Synchronous setup failure left the controller operation pending");
    assert.equal(result.status, "failed");
    assert.equal(result.phase, "failed");
    assert.match(result.message, /createDataChannel refused/);
    assert.equal(result.connectionDiagnostics.relayConfigured, false);
    assert.equal(fixture.controller.busy, false);
    assert.equal(fixture.nodes[0].instance, original);
    assert.equal(fixture.nodes[0].state, "running");
    assert.equal(fixture.nodes[0].ownership, "retained");
    assert.equal(fixture.nodes[0].outbound, null);
    assert.equal(fixture.nodes[0].links.size, 0);
    const closed = peers.filter((peer) => peer.connectionState === "closed");
    assert.equal(closed.length, 1);
    for (const type of closed[0].listenerTypes) {
      assert.equal(getEventListeners(closed[0], type).length, 0, `${type} observer leaked on failed setup`);
    }
    const before = BigInt(fixture.nodes[0].progress.sequence);
    await until(() => BigInt(fixture.nodes[0].progress.sequence) > before);
    assert.equal(fixture.nodes[1].instance, null);
  } finally { await fixture.close(); }
  assert.ok(peers.every((peer) => peer.connectionState === "closed"));
  for (const peer of peers) for (const type of peer.listenerTypes) {
    assert.equal(getEventListeners(peer, type).length, 0, `${type} observer leaked after fixture cleanup`);
  }
});

test("a new migration operation does not inherit a previous handoff's completion statistics", integration, async () => {
  const fixture = await room();
  try {
    await fixture.controller.start("1");
    const first = await fixture.controller.migrate("1", "2");
    assert.equal(first.commitConfirmed, true);
    await fixture.controller.migrate("2", "1");
    const next = await fixture.controller.migrate("1", "2");
    const connecting = fixture.events.filter((item) => item.type === "operation"
      && item.operation.id === next.id && item.operation.phase === "connecting");
    assert.ok(connecting.length >= 2, "both controller and source publish their new operation");
    for (const { operation } of connecting) {
      assert.equal(operation.status, "pending");
      for (const key of Object.keys(first)) {
        if (["id", "source", "target", "phase", "status", "message"].includes(key)) continue;
        assert.equal(Object.hasOwn(operation, key), false, `new operation inherited ${key}`);
      }
    }
    await assertExactHandoff(fixture, next);
  } finally { await fixture.close(); }
});

test("duplicate start, concurrent migration and source=target are rejected", integration, async () => {
  const fixture = await room();
  try {
    const first = fixture.controller.start("1");
    await assert.rejects(fixture.controller.start("2"), /progress/);
    await first;
    await assert.rejects(fixture.controller.start("2"), /already started/);
    await assert.rejects(fixture.controller.migrate("1", "1"), /different/);
    const moving = fixture.controller.migrate("1", "2");
    await assert.rejects(fixture.controller.migrate("1", "2"), /progress/);
    assert.equal((await moving).status, "succeeded");
  } finally { await fixture.close(); }
});

test("lost start reply never permits a second workload", integration, async () => {
  const fixture = await room(2, { timeoutMs: 500 });
  try {
    fixture.bus.drop = (message) => message.type === "reply";
    await assert.rejects(fixture.controller.start("1"), /outcome is unknown/);
    assert.equal(fixture.nodes[0].state, "running");
    assert.equal(fixture.nodes[1].state, "idle");
    await assert.rejects(fixture.controller.start("2"), /already started/);
  } finally { await fixture.close(); }
});

test("closing the controller leaves the independent Wasm workload running", integration, async () => {
  const fixture = await room();
  try {
    await fixture.controller.start("1");
    await fixture.controller.close();
    const before = BigInt(fixture.nodes[0].progress.sequence);
    await until(() => BigInt(fixture.nodes[0].progress.sequence) > before);
    assert.equal(fixture.nodes[0].state, "running");
  } finally { await fixture.close(); }
});

test("closed active tab becomes unknown and never auto-starts an idle replacement", integration, async () => {
  const fixture = await room();
  try {
    await fixture.controller.start("1");
    await fixture.nodes[0].close();
    await until(() => fixture.controller.getSnapshot().nodes.find((node) => node.nodeId === "1")?.online === false);
    assert.equal(fixture.controller.getSnapshot().nodes.find((node) => node.nodeId === "1").ownership, "unknown");
    assert.equal(fixture.nodes[1].state, "idle");
    await assert.rejects(fixture.controller.start("2"), /already started/);
  } finally { await fixture.close(); }
});

test("duplicate slots and controller epochs fail closed", integration, async () => {
  const fixture = await room();
  let duplicate;
  let controller;
  try {
    duplicate = new TabRuntime({ room: fixture.controller.room, role: "node", nodeId: "1", wasmBytes: wasm(), transport: "webrtc", channelFactory: fixture.bus.open, RTCPeerConnection: FakeRTC });
    await duplicate.init();
    await until(() => fixture.controller.getSnapshot().nodes.some((node) => node.duplicate));
    await assert.rejects(fixture.controller.start("1"), /duplicated/);
    controller = new TabRuntime({ room: fixture.controller.room, role: "controller", wasmBytes: wasm(), transport: "webrtc", channelFactory: fixture.bus.open, RTCPeerConnection: FakeRTC });
    await controller.init();
    await until(() => fixture.controller.error && controller.error);
    await assert.rejects(controller.start("2"), /blocked/);
    await assert.rejects(fixture.controller.start("2"), /blocked/);
  } finally { await duplicate?.close(); await controller?.close(); await fixture.close(); }
});

for (const transport of ["local", "webrtc"]) {
  test(`${transport}: a closed destination epoch is not a duplicate of its replacement`, integration, async () => {
    const fixture = await room(2, { transport });
    let replacement;
    try {
      await fixture.controller.start("1");
      const original = fixture.nodes[1];
      await original.close();
      await until(() => fixture.controller.getSnapshot().nodes.find((node) => node.instanceId === original.instanceId)?.closed);
      replacement = new TabRuntime({ room: fixture.controller.room, role: "node", nodeId: "2",
        wasmBytes: wasm(), transport, channelFactory: fixture.bus.open, RTCPeerConnection: FakeRTC });
      await replacement.init();
      await until(() => fixture.controller.getSnapshot().nodes.some((node) => node.instanceId === replacement.instanceId && node.online));
      const snapshots = fixture.controller.getSnapshot().nodes;
      assert.equal(snapshots.find((node) => node.instanceId === original.instanceId).duplicate, false,
        "a closed historical peer must not make the UI block a healthy replacement");
      assert.equal(snapshots.find((node) => node.instanceId === replacement.instanceId).duplicate, false);
      const result = await fixture.controller.migrate("1", "2");
      assert.equal(result.status, "succeeded");
      await until(() => fixture.events.some((item) => item.type === "boundary" && item.kind === "resume" && item.operationId === result.id));
      const final = fixture.events.find((item) => item.kind === "final" && item.operationId === result.id);
      const resume = fixture.events.find((item) => item.kind === "resume" && item.operationId === result.id);
      assert.equal(BigInt(resume.sequence), BigInt(final.sequence) + 1n);
      assert.equal(BigInt(resume.terms), BigInt(final.terms) + 32768n);
      assert.equal(fixture.nodes[0].ownership, "retired");
      assert.equal(replacement.ownership, "retained");
      assert.equal(original.instance, null);
      assert.equal(fixture.events.filter((item) => item.kind === "start").length, 1);
      // Silence is not a confirmed close: the existing conservative guard
      // must still reject duplicate epochs when one peer is merely quiet.
      const historical = fixture.controller.peers.get(original.instanceId);
      historical.closed = false;
      historical.lastSeen = Date.now() - 20_000;
      assert.ok(fixture.controller.getSnapshot().nodes.filter((node) => node.nodeId === "2").every((node) => node.duplicate));
      await assert.rejects(fixture.controller.migrate("2", "1"), /duplicated/);
      historical.closed = true;
      await fixture.controller.stopAll();
      assert.equal(replacement.state, "stopped");
    } finally { await replacement?.close(); await fixture.close(); }
  });

  test(`${transport}: duplicate presence cannot overwrite acknowledged terminal Stop`, integration, async () => {
    const fixture = await room(2, { transport });
    const duplicates = [];
    const openDuplicate = async (nodeId) => {
      const node = new TabRuntime({ room: fixture.controller.room, role: "node", nodeId,
        wasmBytes: wasm(), transport, channelFactory: fixture.bus.open, RTCPeerConnection: FakeRTC });
      duplicates.push(node);
      await node.init();
      await until(() => node.state === "duplicate");
      return node;
    };
    try {
      await fixture.controller.start("1");
      const duplicate = await openDuplicate("2");
      await until(() => fixture.nodes[1].state === "duplicate");
      await assert.rejects(fixture.controller.migrate("1", "2"), /duplicated/);
      const before = BigInt(fixture.nodes[0].progress.sequence);
      await until(() => BigInt(fixture.nodes[0].progress.sequence) > before);
      assert.equal(fixture.nodes[0].ownership, "retained", "duplicate detection must not retire the live source");
      assert.deepEqual(await fixture.controller.stopAll(), { stopped: 3 });
      const stoppedNodes = [...fixture.nodes, duplicate];
      const progress = stoppedNodes.map((node) => ({ ...node.progress }));
      // A new duplicate and normal repeated presence arrive after Stop ACKs.
      // These must remain visible as a room error without reviving node state.
      await openDuplicate("1");
      for (let round = 0; round < 3; round++) {
        fixture.controller._presence();
        for (const node of [...fixture.nodes, ...duplicates]) node._presence();
        await sleep(5);
      }
      for (const [index, node] of stoppedNodes.entries()) {
        assert.equal(node.state, "stopped", "duplicate presence overwrote terminal Stop");
        assert.equal(node.ownership, "none");
        assert.equal(node.everStarted, true);
        assert.equal(node.instance, null);
        assert.equal(node.runner, null);
        assert.equal(node.links.size, 0);
        assert.deepEqual(node.progress, progress[index]);
      }
      assert.equal(fixture.events.filter((item) => item.type === "boundary" && item.kind === "start").length, 1);
      await assert.rejects(fixture.controller.start("1"), /already started/);
      for (const node of stoppedNodes) await assert.rejects(node._handleCommand("start"), /cannot accept|more than once/);
      await fixture.controller.stopAll(); // Stop also remains idempotent with duplicates.
      assert.ok([...fixture.nodes, ...duplicates].every((node) => node.state === "stopped"));
    } finally { await Promise.all(duplicates.map((node) => node.close())); await fixture.close(); }
  });
}

test("failed pre-copy retains source ownership and a second migration succeeds", integration, async () => {
  const fixture = await room();
  try {
    await fixture.controller.start("1");
    FakeChannel.intercept = (bytes, channel) => {
      if (bytes[0] !== 8) return true; // First PAGE on the real Weave wire.
      FakeChannel.intercept = null;
      channel.close();
      return false;
    };
    const failed = await fixture.controller.migrate("1", "2");
    assert.equal(failed.status, "failed");
    assert.equal(fixture.nodes[0].state, "running");
    assert.equal(fixture.nodes[0].ownership, "retained");
    await until(() => fixture.nodes[1].state === "idle");
    assert.equal((await fixture.controller.migrate("1", "2")).status, "succeeded");
  } finally { FakeChannel.intercept = null; await fixture.close(); }
});

test("lost commit confirmation retires source permanently while committed target continues", integration, async () => {
  const fixture = await room();
  try {
    await fixture.controller.start("1");
    const original = fixture.nodes[0].instance;
    FakeChannel.intercept = (bytes) => bytes[0] !== 22; // COMMIT_OK, not a fabricated checkpoint.
    const result = await fixture.controller.migrate("1", "2");
    assert.equal(result.status, "uncertain");
    assert.equal(original.lifecycle, "retired");
    assert.equal(fixture.nodes[0].state, "uncertain");
    assert.equal(fixture.nodes[0].ownership, "retired");
    const before = BigInt(fixture.nodes[1].progress.sequence);
    await until(() => BigInt(fixture.nodes[1].progress.sequence) > before);
    assert.equal(fixture.nodes[1].state, "running");
    await assert.rejects(fixture.controller.start("1"), /already started/);
    await assert.rejects(fixture.controller.migrate("1", "2"), /running workload/);
  } finally { FakeChannel.intercept = null; await fixture.close(); }
});

test("lost command reply recovers from the identity-bound terminal operation event", integration, async () => {
  const fixture = await room(2, { timeoutMs: 500 });
  try {
    await fixture.controller.start("1");
    let migrationCommand;
    fixture.bus.drop = (message) => {
      if (message.type === "command" && message.action === "migrate") migrationCommand = message.commandId;
      return message.type === "reply" && message.commandId === migrationCommand;
    };
    const result = await fixture.controller.migrate("1", "2");
    assert.equal(result.status, "succeeded");
    assert.equal(fixture.nodes[0].ownership, "retired");
    assert.equal(fixture.nodes[1].ownership, "retained");
  } finally { await fixture.close(); }
});

test("losing both terminal notifications is unknown, never permission to duplicate", integration, async () => {
  const fixture = await room(2, { timeoutMs: 500 });
  try {
    await fixture.controller.start("1");
    let migrationCommand;
    fixture.bus.drop = (message) => {
      if (message.type === "command" && message.action === "migrate") migrationCommand = message.commandId;
      return (message.type === "reply" && message.commandId === migrationCommand) ||
        (message.type === "operation" && message.operation.status !== "pending");
    };
    await assert.rejects(fixture.controller.migrate("1", "2"), /outcome is unknown/);
    assert.equal(fixture.controller.operation.status, "uncertain");
    assert.equal(fixture.nodes[0].ownership, "retired");
    assert.equal(fixture.nodes[1].ownership, "retained");
    await assert.rejects(fixture.controller.start("1"), /already started/);
  } finally { await fixture.close(); }
});

test("stop does not falsely confirm success for a frozen peer", integration, async () => {
  const fixture = await room(2, { timeoutMs: 500 });
  try {
    await fixture.controller.start("1");
    fixture.bus.drop = (message) => message.sender === fixture.nodes[0].instanceId || message.to === fixture.nodes[0].instanceId;
    fixture.controller.peers.get(fixture.nodes[0].instanceId).lastSeen = Date.now() - 20_000;
    await assert.rejects(fixture.controller.stopAll(), /Could not confirm stop in 1 tab/);
    assert.equal(fixture.nodes[1].state, "stopped");
    assert.equal(fixture.nodes[0].state, "running");
  } finally { await fixture.close(); }
});

test("a lost prepare acknowledgement is a definite pre-migration failure, not uncertain ownership", integration, async () => {
  const fixture = await room(2, { timeoutMs: 500 });
  try {
    await fixture.controller.start("1");
    let prepareCommand;
    fixture.bus.drop = (message) => {
      if (message.type === "command" && message.action === "prepare") prepareCommand = message.commandId;
      return message.type === "reply" && message.commandId === prepareCommand;
    };
    const before = BigInt(fixture.nodes[0].progress.sequence);
    await assert.rejects(fixture.controller.migrate("1", "2"), /Source migration was never requested/);
    assert.equal(fixture.controller.operation.status, "failed");
    assert.equal(fixture.nodes[0].state, "running");
    assert.equal(fixture.nodes[0].ownership, "retained");
    assert.ok(BigInt(fixture.nodes[0].progress.sequence) > before);
    assert.equal(fixture.nodes[1].state, "receiving");
    assert.ok(!fixture.bus.messages.some((message) => message.type === "command" && message.action === "migrate"));
    assert.equal(fixture.events.filter((event) => event.type === "boundary" && event.kind === "start").length, 1);
    // Simulate the target session's bounded connection timeout without making
    // the test wait 12 seconds; the separate Chrome freeze case waits for real.
    fixture.nodes[1]._failLink(fixture.nodes[1].incoming, new Error("Test connection timeout"));
    fixture.bus.drop = () => false;
    await until(() => fixture.controller.getSnapshot().nodes.find((node) => node.nodeId === "2")?.state === "idle");
    assert.equal((await fixture.controller.migrate("1", "2")).status, "succeeded");
  } finally { await fixture.close(); }
});

test("a full command ledger rejects more work but still permits explicit terminal stop", integration, async () => {
  const fixture = await room();
  try {
    await fixture.controller.start("1");
    while (fixture.nodes[0].commandRecords.size < 512) fixture.nodes[0].commandRecords.set(crypto.randomUUID(), {});
    await fixture.controller.stopAll();
    assert.equal(fixture.nodes[0].state, "stopped");
    assert.equal(fixture.nodes[0].commandRecords.size, 512);
  } finally { await fixture.close(); }
});

test("reloading a controller cannot silently take over another process epoch", integration, async () => {
  const fixture = await room();
  let replacement;
  try {
    await fixture.controller.start("1");
    await fixture.controller.close();
    replacement = new TabRuntime({ role: "controller", room: fixture.controller.room, wasmBytes: wasm(), transport: "webrtc", channelFactory: fixture.bus.open, RTCPeerConnection: FakeRTC });
    await replacement.init();
    await until(() => replacement.error);
    assert.match(replacement.error, /another controller session/);
    await assert.rejects(replacement.start("2"), /blocked/);
    await assert.rejects(replacement.migrate("1", "2"), /blocked/);
    const before = BigInt(fixture.nodes[0].progress.sequence);
    await until(() => BigInt(fixture.nodes[0].progress.sequence) > before);
    assert.equal(fixture.nodes[0].state, "running");
  } finally { await replacement?.close(); await fixture.close(); }
});

test("local transport completes six genuine handoffs without any WebRTC implementation", integration, async () => {
  const fixture = await room(6, { transport: "local", RTCPeerConnection: undefined });
  try {
    await fixture.controller.start("1");
    assert.equal(fixture.controller.getSnapshot().transport, "local");
    for (let source = 1; source <= 6; source++) {
      const target = source % 6 + 1;
      const result = await fixture.controller.migrate(String(source), String(target));
      assert.equal(result.status, "succeeded", JSON.stringify(result));
      await until(() => fixture.events.some((item) => item.type === "boundary" && item.kind === "resume" && item.operationId === result.id));
      const final = fixture.events.find((item) => item.type === "boundary" && item.kind === "final" && item.operationId === result.id);
      const resumed = fixture.events.find((item) => item.type === "boundary" && item.kind === "resume" && item.operationId === result.id);
      assert.equal(BigInt(resumed.sequence), BigInt(final.sequence) + 1n);
      assert.equal(BigInt(resumed.terms), BigInt(final.terms) + 32768n);
      assert.equal(fixture.nodes[source - 1].ownership, "retired");
      assert.equal(fixture.nodes.filter((node) => node.ownership === "retained").length, 1);
    }
    assert.equal(FakeRTC.peers.size, 0);
    assert.ok(fixture.bus.messages.some((message) => message.kind === "data" && message.bytes instanceof Uint8Array));
    assert.ok(!fixture.bus.messages.some((message) => message.type === "signal"));
    await fixture.controller.stopAll();
    assert.ok(fixture.nodes.every((node) => node.state === "stopped" && !node.instance && !node.links.size));
  } finally { await fixture.close(); }
});

test("local transport runs over the actual BroadcastChannel API, not a shared checkpoint object", integration, async () => {
  const fixture = await room(2, { transport: "local", RTCPeerConnection: undefined, channelFactory: (name) => new BroadcastChannel(name) });
  try {
    await fixture.controller.start("1");
    const original = fixture.nodes[0].instance;
    assert.equal((await fixture.controller.migrate("1", "2")).status, "succeeded");
    assert.equal(original.lifecycle, "retired");
    await until(() => fixture.nodes[1].state === "running");
    assert.notEqual(original, fixture.nodes[1].instance);
    assert.notEqual(original.mem(0), fixture.nodes[1].instance.mem(0));
    await until(() => fixture.controller.getSnapshot().nodes.some((node) => node.nodeId === "2" && node.state === "running") &&
      fixture.controller.getSnapshot().nodes.some((node) => node.nodeId === "1" && node.state === "retired"));
    assert.equal((await fixture.controller.migrate("2", "1")).status, "succeeded");
    assert.equal(FakeRTC.peers.size, 0);
  } finally { await fixture.close(); }
});

test("local pre-copy disconnect retains the source and permits an explicit successful retry", integration, async () => {
  const fixture = await room(2, { transport: "local", RTCPeerConnection: undefined });
  try {
    await fixture.controller.start("1");
    fixture.bus.drop = (message) => {
      if (message.kind !== "data" || message.bytes?.[0] !== 8) return false;
      fixture.bus.drop = () => false;
      void fixture.nodes[1].incoming.stream.close();
      return true;
    };
    assert.equal((await fixture.controller.migrate("1", "2")).status, "failed");
    assert.equal(fixture.nodes[0].state, "running");
    assert.equal(fixture.nodes[0].ownership, "retained");
    await until(() => fixture.nodes[1].state === "idle");
    assert.equal((await fixture.controller.migrate("1", "2")).status, "succeeded");
  } finally { await fixture.close(); }
});

test("local lost COMMIT_OK never revives the retired source", integration, async () => {
  const fixture = await room(2, { transport: "local", RTCPeerConnection: undefined });
  try {
    await fixture.controller.start("1");
    const original = fixture.nodes[0].instance;
    fixture.bus.drop = (message) => message.kind === "data" && message.bytes?.[0] === 22;
    const result = await fixture.controller.migrate("1", "2");
    assert.equal(result.status, "uncertain");
    assert.equal(original.lifecycle, "retired");
    assert.equal(fixture.nodes[0].ownership, "retired");
    await until(() => fixture.nodes[1].state === "running");
    const before = BigInt(fixture.nodes[1].progress.sequence);
    await until(() => BigInt(fixture.nodes[1].progress.sequence) > before);
    await assert.rejects(fixture.controller.start("1"), /already started/);
  } finally { await fixture.close(); }
});

test("mixing local and WebRTC modes in one room is rejected before guest execution", integration, async () => {
  const fixture = await room(1, { transport: "local", RTCPeerConnection: undefined });
  let wrongMode;
  try {
    wrongMode = new TabRuntime({ role: "node", nodeId: "2", room: fixture.controller.room, transport: "webrtc", wasmBytes: wasm(), channelFactory: fixture.bus.open, RTCPeerConnection: FakeRTC });
    await wrongMode.init();
    await until(() => fixture.controller.error);
    assert.match(fixture.controller.error, /different transport/);
    await assert.rejects(fixture.controller.start("1"), /blocked/);
    assert.ok(fixture.nodes.every((node) => node.state === "idle"));
  } finally { await wrongMode?.close(); await fixture.close(); }
});

test("pinned controller probes keep background idle nodes observable without heartbeat echo loops", integration, async () => {
  const fixture = await room(2, { transport: "local", RTCPeerConnection: undefined });
  try {
    for (const node of fixture.nodes) {
      clearInterval(node.heartbeat); // Model throttled background timer cadence.
      fixture.controller.peers.get(node.instanceId).lastSeen = Date.now() - 20_000;
    }
    assert.ok(fixture.controller.getSnapshot().nodes.every((node) => !node.online));
    await sleep(5);
    const before = fixture.bus.messages.length;
    fixture.controller._presence();
    await until(() => fixture.controller.getSnapshot().nodes.every((node) => node.online));
    await sleep(10);
    assert.equal(fixture.bus.messages.length - before, 3, "one controller probe and one reply per node; no echo loop");
    assert.ok(fixture.nodes.every((node) => node.state === "idle" && !node.instance));
  } finally { await fixture.close(); }
});

test("replayed local migration commands return history and never execute the retired source again", integration, async () => {
  const fixture = await room(2, { transport: "local", RTCPeerConnection: undefined });
  try {
    await fixture.controller.start("1");
    const original = fixture.nodes[0].instance;
    const result = await fixture.controller.migrate("1", "2");
    assert.equal(result.status, "succeeded");
    const command = fixture.bus.messages.find((message) => message.type === "command" && message.action === "migrate");
    const before = BigInt(fixture.nodes[1].progress.sequence);
    fixture.controller._post(command);
    fixture.controller._post(command);
    fixture.controller._post({ ...command, args: { ...command.args, targetId: "6" } });
    await until(() => BigInt(fixture.nodes[1].progress.sequence) > before);
    assert.equal(original.lifecycle, "retired");
    assert.equal(fixture.nodes[0].state, "retired");
    assert.equal(fixture.nodes[1].state, "running");
    assert.equal(fixture.events.filter((event) => event.type === "boundary" && event.kind === "start").length, 1);
    assert.equal(fixture.events.filter((event) => event.type === "boundary" && event.kind === "final").length, 1);
  } finally { await fixture.close(); }
});
