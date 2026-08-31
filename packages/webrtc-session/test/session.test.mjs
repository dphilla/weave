import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_CANDIDATE_BYTES,
  DEFAULT_MAX_PENDING_CANDIDATES,
  DEFAULT_MAX_SDP_BYTES,
  WebRTCSession,
  WebRTCSessionError,
  getSelectedCandidatePath,
} from "../src/index.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(turns = 6) {
  for (let index = 0; index < turns; index++) await Promise.resolve();
}

function eventWith(type, values = {}) {
  const event = new Event(type);
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(event, name, { configurable: true, enumerable: true, value });
  }
  return event;
}

class TrackedEventTarget extends EventTarget {
  constructor() {
    super();
    this.listeners = new Map();
  }

  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    let listeners = this.listeners.get(type);
    if (!listeners) this.listeners.set(type, listeners = new Set());
    listeners.add(listener);
  }

  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
    const listeners = this.listeners.get(type);
    listeners?.delete(listener);
    if (listeners?.size === 0) this.listeners.delete(type);
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0;
  }

  get totalListenerCount() {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }
}

class FakeDataChannel extends TrackedEventTarget {
  constructor(label, init = {}) {
    super();
    this.label = label;
    this.protocol = init.protocol ?? "";
    this.ordered = init.ordered ?? true;
    this.maxRetransmits = init.maxRetransmits ?? null;
    this.maxPacketLifeTime = init.maxPacketLifeTime ?? null;
    this.negotiated = init.negotiated ?? false;
    this.id = init.id ?? null;
    this.readyState = init.readyState ?? "connecting";
    this.closeCalls = 0;
  }

  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  close() {
    this.closeCalls++;
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

function description(type, sdp = `v=0\r\no=- ${type}`) {
  const value = { type, sdp };
  return {
    ...value,
    toJSON() { return { ...value }; },
  };
}

function candidate(name) {
  const value = {
    candidate: `candidate:${name} 1 udp 2122260223 192.0.2.1 5000 typ host`,
    sdpMid: "0",
    sdpMLineIndex: 0,
    usernameFragment: "fixture",
  };
  return {
    ...value,
    toJSON() { return { ...value }; },
  };
}

class FakePeerConnection extends TrackedEventTarget {
  constructor(configuration = {}, hooks = {}, trace = []) {
    super();
    this.configuration = configuration;
    this.hooks = hooks;
    this.trace = trace;
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.signalingState = "stable";
    this.iceGatheringState = "new";
    this.localDescription = null;
    this.remoteDescription = null;
    this.sctp = { maxMessageSize: 65_536 };
    this.createdChannels = [];
    this.addedCandidates = [];
    this.closeCalls = 0;
    this.stats = new Map();
  }

  createDataChannel(label, init = {}) {
    this.trace.push(`createDataChannel:${label}`);
    const channel = new FakeDataChannel(label, init);
    this.createdChannels.push({ label, init: { ...init }, channel });
    return channel;
  }

  async createOffer() {
    this.trace.push("createOffer");
    if (this.hooks.createOffer) return this.hooks.createOffer(this);
    return description("offer");
  }

  async createAnswer() {
    this.trace.push("createAnswer");
    if (this.hooks.createAnswer) return this.hooks.createAnswer(this);
    return description("answer");
  }

  async setLocalDescription(value) {
    this.trace.push(`setLocalDescription:${value.type}`);
    this.localDescription = description(value.type, value.sdp);
    if (this.hooks.setLocalDescription) await this.hooks.setLocalDescription(value, this);
  }

  async setRemoteDescription(value) {
    this.trace.push(`setRemoteDescription:${value.type}`);
    if (this.hooks.setRemoteDescription) await this.hooks.setRemoteDescription(value, this);
    this.remoteDescription = description(value.type, value.sdp);
  }

  async addIceCandidate(value) {
    const name = value === null ? "null" : value.candidate;
    this.trace.push(`addIceCandidate:${name}`);
    this.addedCandidates.push(value);
    if (this.hooks.addIceCandidate) await this.hooks.addIceCandidate(value, this);
  }

  close() {
    this.closeCalls++;
    this.connectionState = "closed";
    this.iceConnectionState = "closed";
    this.signalingState = "closed";
  }

  getStats() {
    if (this.hooks.getStats) return this.hooks.getStats(this);
    return Promise.resolve(this.stats);
  }

  emitIceCandidate(value) {
    this.dispatchEvent(eventWith("icecandidate", { candidate: value }));
  }

  emitDataChannel(channel) {
    this.dispatchEvent(eventWith("datachannel", { channel }));
  }

  emitIceCandidateError(values = {}) {
    this.dispatchEvent(eventWith("icecandidateerror", values));
  }

  setConnectionState(connectionState, iceConnectionState = this.iceConnectionState) {
    this.connectionState = connectionState;
    this.iceConnectionState = iceConnectionState;
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

function rtcHarness({ hooks = {}, trace = [] } = {}) {
  let peerConnection = null;
  class RTCPeerConnection extends FakePeerConnection {
    constructor(configuration) {
      super(configuration, hooks, trace);
      peerConnection = this;
    }
  }
  return {
    RTCPeerConnection,
    get peerConnection() { return peerConnection; },
    trace,
  };
}

function createSession({
  role = "offerer",
  hooks,
  trace = [],
  sendSignal,
  ...options
} = {}) {
  const rtc = rtcHarness({ hooks, trace });
  const sent = [];
  const sender = sendSignal ?? (async (message, context) => {
    sent.push({ message, context });
  });
  const session = new WebRTCSession({
    role,
    RTCPeerConnection: rtc.RTCPeerConnection,
    rtcConfiguration: { iceServers: [{ urls: "stun:stun.example.test" }] },
    connectTimeoutMs: 0,
    sendSignal: sender,
    ...options,
  });
  return { session, rtc, sent, get pc() { return rtc.peerConnection; } };
}

function assertWebRTCSessionError(error, messagePattern) {
  assert.ok(error instanceof WebRTCSessionError, `expected WebRTCSessionError, got ${error}`);
  assert.equal(typeof error.code, "string");
  assert.ok(error.code.length > 0, "WebRTCSessionError.code must be non-empty");
  if (messagePattern) assert.match(error.message, messagePattern);
  return true;
}

test("exports finite defensive defaults", () => {
  assert.equal(DEFAULT_CONNECT_TIMEOUT_MS, 30_000);
  assert.equal(DEFAULT_MAX_PENDING_CANDIDATES, 256);
  assert.equal(DEFAULT_MAX_SDP_BYTES, 256 * 1024);
  assert.equal(DEFAULT_MAX_CANDIDATE_BYTES, 16 * 1024);
});

test("offerer creates raw channels before its offer and publishes SDP before queued ICE", async () => {
  const descriptionSent = deferred();
  const trace = [];
  const sent = [];
  const { session, pc } = createSession({
    trace,
    hooks: {
      setLocalDescription(_value, connection) {
        connection.emitIceCandidate(candidate("one"));
        connection.emitIceCandidate(candidate("two"));
        connection.emitIceCandidate(null);
      },
    },
    async sendSignal(message, { signal }) {
      assert.ok(signal instanceof AbortSignal);
      sent.push(message);
      trace.push(`send:${message.type}:${message.description?.type ?? message.candidate?.candidate ?? "null"}`);
      if (message.type === "description") await descriptionSent.promise;
    },
  });

  const raw = session.createDataChannel("raw", {
    ordered: false,
    maxRetransmits: 0,
    protocol: "arbitrary.raw.v1",
  });
  assert.equal(session.channel("raw"), raw);
  assert.equal(session.channels.get("raw"), raw);
  assert.equal(raw.ordered, false);
  assert.equal(raw.maxRetransmits, 0);

  const starting = session.start();
  assert.strictEqual(session.start(), starting);
  await flushMicrotasks();
  assert.deepEqual(sent.map(({ type }) => type), ["description"]);
  assert.deepEqual(trace.slice(0, 4), [
    "createDataChannel:raw",
    "createOffer",
    "setLocalDescription:offer",
    "send:description:offer",
  ]);

  descriptionSent.resolve();
  assert.equal(await starting, session);
  await flushMicrotasks();
  assert.deepEqual(sent.map(({ type }) => type), [
    "description",
    "candidate",
    "candidate",
    "candidate",
  ]);
  assert.match(sent[1].candidate.candidate, /candidate:one/);
  assert.match(sent[2].candidate.candidate, /candidate:two/);
  assert.equal(sent[3].candidate, null);
  assert.deepEqual(pc.configuration, {
    iceServers: [{ urls: "stun:stun.example.test" }],
  });
});

test("answerer stages candidate-before-offer and publishes answer before local ICE", async () => {
  const trace = [];
  const { session, pc, sent } = createSession({
    role: "answerer",
    trace,
    hooks: {
      setLocalDescription(_value, connection) {
        connection.emitIceCandidate(candidate("answer-local"));
      },
    },
  });
  await session.start();

  const remoteCandidate = candidate("remote-before-offer").toJSON();
  await session.receiveSignal({ type: "candidate", candidate: remoteCandidate });
  assert.deepEqual(pc.addedCandidates, []);

  await session.receiveSignal({
    type: "description",
    description: description("offer", "v=0\r\no=- remote-offer").toJSON(),
  });

  assert.deepEqual(trace.slice(0, 4), [
    "setRemoteDescription:offer",
    `addIceCandidate:${remoteCandidate.candidate}`,
    "createAnswer",
    "setLocalDescription:answer",
  ]);
  assert.deepEqual(sent.map(({ message }) => message.type), ["description", "candidate"]);
  assert.equal(sent[0].message.description.type, "answer");
  assert.match(sent[1].message.candidate.candidate, /candidate:answer-local/);
});

test("offerer applies its answer before candidate messages staged ahead of it", async () => {
  const trace = [];
  const { session, pc } = createSession({ trace });
  await session.start();
  const remoteCandidate = candidate("before-answer").toJSON();
  await session.receiveSignal({ type: "candidate", candidate: remoteCandidate });
  await session.receiveSignal({
    type: "description",
    description: description("answer", "v=0\r\no=- remote-answer").toJSON(),
  });

  assert.deepEqual(pc.addedCandidates, [remoteCandidate]);
  assert.ok(
    trace.indexOf("setRemoteDescription:answer") <
      trace.indexOf(`addIceCandidate:${remoteCandidate.candidate}`),
  );
});

test("concurrent receiveSignal calls are applied serially", async () => {
  const firstCandidateBlocked = deferred();
  let addCount = 0;
  const { session, pc } = createSession({
    role: "answerer",
    hooks: {
      async addIceCandidate() {
        addCount++;
        if (addCount === 1) await firstCandidateBlocked.promise;
      },
    },
  });
  await session.start();
  await session.receiveSignal({
    type: "description",
    description: description("offer").toJSON(),
  });

  const first = candidate("serialized-one").toJSON();
  const second = candidate("serialized-two").toJSON();
  const applyingFirst = session.receiveSignal({ type: "candidate", candidate: first });
  const applyingSecond = session.receiveSignal({ type: "candidate", candidate: second });
  await flushMicrotasks();
  assert.deepEqual(pc.addedCandidates, [first]);

  firstCandidateBlocked.resolve();
  await Promise.all([applyingFirst, applyingSecond]);
  assert.deepEqual(pc.addedCandidates, [first, second]);
});

test("invalid, wrong-role, and duplicate descriptions are rejected strictly", async (t) => {
  const cases = [
    ["null message", "answerer", null, /signal|message/i],
    ["array message", "answerer", [], /signal|message/i],
    ["unknown type", "answerer", { type: "mystery" }, /type|signal/i],
    ["missing SDP", "answerer", { type: "description", description: { type: "offer" } }, /sdp|description/i],
    ["answer to answerer", "answerer", {
      type: "description",
      description: description("answer").toJSON(),
    }, /offer|answerer/i],
    ["offer to offerer", "offerer", {
      type: "description",
      description: description("offer").toJSON(),
    }, /answer|offerer/i],
  ];

  for (const [name, role, message, pattern] of cases) {
    await t.test(name, async () => {
      const { session } = createSession({ role });
      await session.start();
      await assert.rejects(
        session.receiveSignal(message),
        (error) => assertWebRTCSessionError(error, pattern),
      );
    });
  }

  await t.test("second description", async () => {
    const { session } = createSession({ role: "answerer" });
    await session.start();
    const offer = {
      type: "description",
      description: description("offer").toJSON(),
    };
    await session.receiveSignal(offer);
    await assert.rejects(
      session.receiveSignal(offer),
      (error) => assertWebRTCSessionError(error, /duplicate|already|description/i),
    );
  });
});

test("candidate and SDP byte bounds reject oversized signaling input", async (t) => {
  await t.test("SDP", async () => {
    const { session } = createSession({ role: "answerer", maxSdpBytes: 32 });
    await session.start();
    await assert.rejects(
      session.receiveSignal({
        type: "description",
        description: description("offer", "x".repeat(33)).toJSON(),
      }),
      (error) => assertWebRTCSessionError(error, /sdp|32|size/i),
    );
  });

  await t.test("candidate", async () => {
    const { session } = createSession({ role: "answerer", maxCandidateBytes: 64 });
    await session.start();
    await assert.rejects(
      session.receiveSignal({
        type: "candidate",
        candidate: { candidate: "x".repeat(128), sdpMid: "0", sdpMLineIndex: 0 },
      }),
      (error) => assertWebRTCSessionError(error, /candidate|64|size/i),
    );
  });
});

test("pending local and remote candidate queues are bounded", async (t) => {
  await t.test("remote candidates before the description", async () => {
    const { session, pc } = createSession({
      role: "answerer",
      maxPendingCandidates: 2,
    });
    await session.start();
    await session.receiveSignal({ type: "candidate", candidate: candidate("one").toJSON() });
    await session.receiveSignal({ type: "candidate", candidate: null });
    await assert.rejects(
      session.receiveSignal({ type: "candidate", candidate: candidate("three").toJSON() }),
      (error) => assertWebRTCSessionError(error, /candidate|pending|2|limit/i),
    );
    assert.deepEqual(pc.addedCandidates, []);
  });

  await t.test("local candidates before description publication", async () => {
    const { session, pc } = createSession({
      maxPendingCandidates: 2,
      hooks: {
        setLocalDescription(_value, connection) {
          connection.emitIceCandidate(candidate("one"));
          connection.emitIceCandidate(null);
          connection.emitIceCandidate(candidate("three"));
        },
      },
    });
    await assert.rejects(
      session.start(),
      (error) => assertWebRTCSessionError(error, /candidate|queue|2|limit/i),
    );
    assert.equal((await session.closed).reason, "failed");
    assert.equal(pc.closeCalls, 1);
  });
});

test("session allows arbitrary raw channel reliability but rejects duplicate incoming labels", async () => {
  const observed = [];
  const errors = [];
  const { session, pc } = createSession({
    onDataChannel(channel, context) {
      observed.push({ channel, context });
    },
    onError(error, context) {
      errors.push({ error, context });
    },
  });
  const local = session.createDataChannel("raw", {
    ordered: false,
    maxPacketLifeTime: 25,
    protocol: "application.raw.v7",
  });
  assert.equal(local.ordered, false);
  assert.equal(local.maxPacketLifeTime, 25);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].context.origin, "local");
  assert.equal(observed[0].context.session, session);

  await session.start();
  const remote = new FakeDataChannel("remote-raw", {
    ordered: false,
    maxRetransmits: 0,
    protocol: "anything.v1",
  });
  pc.emitDataChannel(remote);
  assert.equal(session.channel("remote-raw"), remote);
  assert.equal(observed.at(-1).context.origin, "remote");

  const duplicate = new FakeDataChannel("remote-raw");
  pc.emitDataChannel(duplicate);
  assert.equal(duplicate.closeCalls, 1);
  assert.equal(session.channel("remote-raw"), remote);
  assert.equal(observed.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].context.fatal, false);
  assert.equal(errors[0].context.session, session);
  assert.match(errors[0].error.message, /duplicate|remote-raw/i);
});

test("createDataChannel is offerer-only, pre-start, and label-unique", async () => {
  const answerer = createSession({ role: "answerer" }).session;
  assert.throws(
    () => answerer.createDataChannel("nope"),
    (error) => assertWebRTCSessionError(error, /offerer/i),
  );

  const { session } = createSession();
  session.createDataChannel("once");
  assert.throws(
    () => session.createDataChannel("once"),
    (error) => assertWebRTCSessionError(error, /duplicate|once/i),
  );
  await session.start();
  assert.throws(
    () => session.createDataChannel("late"),
    (error) => assertWebRTCSessionError(error, /before|start/i),
  );
});

test("send and remote-description failures are terminal", async (t) => {
  await t.test("offer publication", async () => {
    const cause = new Error("rendezvous unavailable");
    const { session, pc } = createSession({
      async sendSignal() { throw cause; },
    });
    await assert.rejects(session.start(), /rendezvous unavailable/);
    const connectedError = await session.connected.then(
      () => null,
      (error) => error,
    );
    assert.ok(connectedError instanceof Error);
    assert.match(connectedError.message, /rendezvous unavailable/);
    const closed = await session.closed;
    assert.equal(closed.reason, "failed");
    assert.ok(closed.error instanceof Error);
    assert.equal(session.state, "failed");
    assert.equal(session.error, closed.error);
    assert.equal(pc.closeCalls, 1);
  });

  await t.test("trickled candidate publication", async () => {
    const { session, pc } = createSession({
      async sendSignal(message) {
        if (message.type === "candidate") throw new Error("candidate post failed");
      },
    });
    await session.start();
    pc.emitIceCandidate(candidate("late-send-failure"));
    const closed = await session.closed;
    assert.equal(closed.reason, "failed");
    assert.match(closed.error.message, /candidate post failed/);
    assert.equal(session.state, "failed");
    assert.equal(pc.closeCalls, 1);
  });

  await t.test("remote description application", async () => {
    const { session, pc } = createSession({
      role: "answerer",
      hooks: {
        setRemoteDescription() { throw new Error("browser rejected SDP"); },
      },
    });
    await session.start();
    await assert.rejects(
      session.receiveSignal({
        type: "description",
        description: description("offer").toJSON(),
      }),
      /browser rejected SDP/,
    );
    assert.equal((await session.closed).reason, "failed");
    assert.equal(session.state, "failed");
    assert.equal(pc.closeCalls, 1);
  });

  await t.test("explicit fail", async () => {
    const { session, pc } = createSession({ role: "answerer" });
    await session.start();
    assert.equal(session.fail(new Error("application cancelled session")), true);
    assert.equal(session.fail(new Error("second failure")), false);
    await assert.rejects(session.connected, /application cancelled session/);
    const closed = await session.closed;
    assert.equal(closed.reason, "failed");
    assert.equal(closed.error, session.error);
    assert.equal(pc.closeCalls, 1);
    assert.strictEqual(await session.close(), closed);
  });
});

test("PeerConnection failure is terminal while disconnected can recover", async (t) => {
  await t.test("failed", async () => {
    const errors = [];
    const { session, pc } = createSession({
      role: "answerer",
      onError(error, context) { errors.push({ error, context }); },
    });
    await session.start();
    pc.setConnectionState("failed", "failed");
    const closed = await session.closed;
    assert.equal(closed.reason, "failed");
    assert.ok(closed.error instanceof Error);
    assert.equal(session.state, "failed");
    await assert.rejects(session.connected, /failed/i);
    assert.equal(pc.closeCalls, 1);
    assert.equal(errors.at(-1).context.fatal, true);
  });

  await t.test("disconnected then connected", async () => {
    const states = [];
    const { session, pc } = createSession({
      role: "answerer",
      onStateChange(info) { states.push(info); },
    });
    await session.start();
    let closed = false;
    void session.closed.then(() => { closed = true; });
    pc.setConnectionState("disconnected", "disconnected");
    await flushMicrotasks();
    assert.equal(session.state, "disconnected");
    assert.equal(closed, false);

    pc.setConnectionState("connected", "connected");
    assert.equal(await session.connected, session);
    assert.equal(session.state, "connected");
    assert.ok(states.some((info) => info.state === "disconnected"));
    assert.ok(states.some((info) => info.state === "connected"));
    assert.ok(states.every((info) => info.session === session));
    await session.close();
  });
});

test("timeout and external abort fail a pending connection", async (t) => {
  await t.test("connect timeout", async () => {
    // The product timer is intentionally unref'ed so an abandoned session does
    // not keep a Node process alive. Keep this test process alive long enough
    // to observe that timer as a browser would.
    const testGuard = setTimeout(() => {}, 1_000);
    const { session, pc } = createSession({
      role: "answerer",
      connectTimeoutMs: 5,
    });
    try {
      await session.start();
      await assert.rejects(session.connected, /timed out|timeout/i);
      const closed = await session.closed;
      assert.equal(closed.reason, "failed");
      assert.equal(session.state, "failed");
      assert.equal(pc.closeCalls, 1);
    } finally {
      clearTimeout(testGuard);
    }
  });

  await t.test("abort", async () => {
    const controller = new AbortController();
    const { session, pc } = createSession({
      role: "answerer",
      signal: controller.signal,
    });
    await session.start();
    controller.abort(new Error("cancelled by test"));
    await assert.rejects(session.connected, /cancelled by test|abort/i);
    const closed = await session.closed;
    assert.equal(closed.reason, "failed");
    assert.equal(session.state, "failed");
    assert.equal(pc.closeCalls, 1);
  });
});

test("manual close is idempotent, rejects pre-connect connected, and removes listeners", async () => {
  const { session, pc } = createSession();
  const channel = session.createDataChannel("cleanup");
  await session.start();
  assert.ok(pc.totalListenerCount > 0);

  const connected = session.connected.then(
    () => null,
    (error) => error,
  );
  const [first, second, observed] = await Promise.all([
    session.close(),
    session.close(),
    session.closed,
  ]);
  assert.strictEqual(first, second);
  assert.strictEqual(first, observed);
  assert.deepEqual(first, { reason: "closed", error: null });
  assert.equal(session.state, "closed");
  assert.equal(session.error, null);
  assert.ok(await connected instanceof Error);
  assert.equal(pc.closeCalls, 1);
  assert.equal(channel.closeCalls, 1);
  assert.equal(pc.totalListenerCount, 0);

  assert.strictEqual(await session.close(), first);
  assert.equal(pc.closeCalls, 1);
});

test("icecandidateerror remains diagnostic and preserves the browser event", async () => {
  const diagnostics = [];
  const { session, pc } = createSession({
    role: "answerer",
    onIceCandidateError(event, context) {
      diagnostics.push({ event, context });
    },
  });
  await session.start();
  pc.emitIceCandidateError({ errorCode: 701, errorText: "STUN lookup failed" });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].event.errorCode, 701);
  assert.equal(diagnostics[0].event.errorText, "STUN lookup failed");
  assert.equal(diagnostics[0].context.session, session);
  assert.equal(session.state, "connecting");
  await session.close();
});

test("getSelectedCandidatePath normalizes transport and nominated-pair stats", async (t) => {
  await t.test("selected transport using TURN", async () => {
    const connection = new FakePeerConnection();
    connection.stats = new Map([
      ["transport", {
        id: "transport",
        type: "transport",
        selectedCandidatePairId: "pair",
      }],
      ["pair", {
        id: "pair",
        type: "candidate-pair",
        state: "succeeded",
        nominated: true,
        localCandidateId: "local",
        remoteCandidateId: "remote",
      }],
      ["local", {
        id: "local",
        type: "local-candidate",
        candidateType: "relay",
        protocol: "tcp",
        relayProtocol: "tls",
        address: "203.0.113.20",
        port: 50_000,
      }],
      ["remote", {
        id: "remote",
        type: "remote-candidate",
        candidateType: "host",
        protocol: "udp",
        address: "192.0.2.5",
        port: 60_000,
      }],
    ]);
    assert.deepEqual(await getSelectedCandidatePath(connection), {
      relayed: true,
      protocol: "tls",
      localCandidateType: "relay",
      remoteCandidateType: "host",
    });
  });

  await t.test("nominated fallback and no selected pair", async () => {
    const connection = new FakePeerConnection();
    connection.stats = new Map([
      ["pair", {
        id: "pair",
        type: "candidate-pair",
        state: "succeeded",
        nominated: true,
        localCandidateId: "local",
        remoteCandidateId: "remote",
      }],
      ["local", {
        id: "local",
        type: "local-candidate",
        candidateType: "host",
        protocol: "udp",
      }],
      ["remote", {
        id: "remote",
        type: "remote-candidate",
        candidateType: "srflx",
        protocol: "udp",
      }],
    ]);
    assert.deepEqual(await getSelectedCandidatePath(connection), {
      relayed: false,
      protocol: "udp",
      localCandidateType: "host",
      remoteCandidateType: "srflx",
    });

    connection.stats = new Map();
    assert.equal(await getSelectedCandidatePath(connection), null);
  });
});
