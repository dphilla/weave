import assert from "node:assert/strict";
import test from "node:test";
import { TabRuntime, TaskTurnScheduler, makeProgressServices } from "./runtime.mjs";
import { loadPiWasm } from "./test-fixture.mjs";

let wasmBytes;
function wasm() { return wasmBytes ??= loadPiWasm(); }
const integration = { timeout: 15_000 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Test condition timed out");
    await sleep(5);
  }
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
      if (this.remote?.readyState !== "closed") this.remote.close();
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
    const remote = this.remote;
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
