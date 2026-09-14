import test from "node:test";
import assert from "node:assert/strict";
import { observeRtcConnection, formatConnectionFailure } from "./rtc-diagnostics.mjs";

class Timers {
  constructor() { this.pending = new Map(); this.delays = []; this.next = 0; }
  setInterval(callback, delay) { const id = ++this.next; this.pending.set(id, callback); this.delays.push(delay); return id; }
  clearInterval(id) { this.pending.delete(id); }
  tick() { for (const callback of [...this.pending.values()]) callback(); }
}

class Peer extends EventTarget {
  constructor() {
    super();
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.iceGatheringState = "new";
    this.signalingState = "stable";
    this.listeners = new Map();
    this.calls = 0;
    this.result = () => Promise.resolve(new Map());
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    super.addEventListener(type, listener);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener);
  }
  listenerCount() { return [...this.listeners.values()].reduce((n, listeners) => n + listeners.size, 0); }
  getStats() { this.calls++; return this.result(); }
  emit(type, values = {}) { const event = new Event(type); Object.assign(event, values); this.dispatchEvent(event); }
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function watch(t, peer = new Peer(), options = {}) {
  const timers = new Timers();
  const observer = observeRtcConnection(peer, { timers, ...options });
  t.after(() => observer.stop());
  return { peer, timers, observer };
}

test("RTC observer samples bounded state and candidate counts without retaining identifying fields", async (t) => {
  const { peer, timers, observer } = watch(t, undefined, { relayConfigured: false });
  const secret = "private-token 192.0.2.41 2001:db8::7 host-secret.local https://secret.invalid/ice";
  peer.connectionState = "connecting";
  peer.iceConnectionState = "checking";
  peer.iceGatheringState = "complete";
  peer.signalingState = "have-local-offer";
  peer.emit("iceconnectionstatechange");
  peer.emit("icecandidate", { candidate: { candidate: secret, usernameFragment: secret, sdpMid: secret } });
  peer.emit("icecandidate", { candidate: { candidate: "" } });
  peer.emit("icecandidate", { candidate: null });
  peer.emit("icecandidateerror", { errorCode: 701, errorText: secret, url: secret, address: secret, port: 54321 });
  peer.result = () => Promise.resolve(new Map([
    [secret, { type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: secret, remoteCandidateId: secret }],
    ["local", { type: "local-candidate", address: secret, candidateType: "host", usernameFragment: secret }],
    ["transport", { type: "transport", selectedCandidatePairId: secret, dtlsCipher: secret }],
  ]));
  await flush();
  timers.tick();
  await flush();
  const snapshot = observer.snapshot();
  assert.deepEqual(snapshot, {
    connectionState: "connecting", iceConnectionState: "checking", iceGatheringState: "complete", signalingState: "have-local-offer",
    localCandidates: 1, endOfCandidates: true, iceErrorCount: 1, lastIceErrorCode: 701,
    statsStatus: "ready", candidatePairs: 1, selectedPair: true, statsTruncated: false, relayConfigured: false,
  });
  assert.deepEqual(timers.delays, [500]);
  const text = JSON.stringify(snapshot) + formatConnectionFailure(snapshot);
  for (const value of secret.split(" ")) assert.ok(!text.includes(value));
  assert.doesNotMatch(text, /usernameFragment|sdpMid|localCandidateId|remoteCandidateId|dtlsCipher|mDNS/i);
  assert.match(text, /no relay configured/);
  assert.match(text, /does not identify the cause/);
});

test("RTC snapshot is independently owned, synchronous, and freezes before native teardown", async (t) => {
  const { peer, observer, timers } = watch(t);
  await flush();
  peer.connectionState = "connecting";
  peer.iceConnectionState = "checking";
  peer.emit("iceconnectionstatechange");
  const before = observer.snapshot();
  before.connectionState = "caller mutation";
  const saved = observer.snapshot();
  observer.stop();
  peer.connectionState = peer.iceConnectionState = peer.signalingState = "closed";
  peer.emit("connectionstatechange");
  peer.emit("icecandidate", { candidate: { candidate: "secret" } });
  assert.deepEqual(observer.snapshot(), saved);
  assert.equal(peer.listenerCount(), 0);
  assert.equal(timers.pending.size, 0);
  assert.equal(peer.connectionState, "closed", "observer never owns or changes the peer's lifecycle");
});

test("native close before the fatal callback preserves last nonclosed diagnostics and releases resources", async (t) => {
  const { peer, observer, timers } = watch(t);
  await flush();
  peer.connectionState = "connecting";
  peer.iceConnectionState = "checking";
  peer.iceGatheringState = "complete";
  peer.emit("icegatheringstatechange");
  const before = observer.snapshot();
  peer.connectionState = peer.iceConnectionState = peer.signalingState = "closed";
  peer.emit("connectionstatechange");
  assert.deepEqual(observer.snapshot(), before);
  assert.equal(timers.pending.size, 0);
  assert.equal(peer.listenerCount(), 0);
  peer.connectionState = "connected";
  assert.deepEqual(observer.snapshot(), before, "late state reads do not replace the frozen cache");
});

test("stop preserves caller listeners and is idempotent while stats are pending", async (t) => {
  const peer = new Peer();
  peer.result = () => new Promise(() => {});
  let callerEvents = 0;
  const caller = () => callerEvents++;
  peer.addEventListener("icecandidate", caller);
  const { observer, timers } = watch(t, peer);
  assert.equal(peer.listenerCount(), 7);
  observer.stop();
  observer.stop();
  peer.emit("icecandidate", { candidate: null });
  assert.equal(callerEvents, 1);
  assert.equal(peer.listenerCount(), 1);
  assert.equal(timers.pending.size, 0);
  peer.removeEventListener("icecandidate", caller);
});

test("a never-settling getStats has only one call in flight and cannot leak the polling timer", (t) => {
  const peer = new Peer();
  peer.result = () => new Promise(() => {});
  const { timers, observer } = watch(t, peer);
  for (let n = 0; n < 1000; n++) timers.tick();
  assert.equal(peer.calls, 1);
  assert.equal(observer.snapshot().statsStatus, "pending");
  assert.equal(timers.pending.size, 1);
  observer.stop();
  for (let n = 0; n < 1000; n++) timers.tick();
  assert.equal(peer.calls, 1);
  assert.equal(timers.pending.size, 0);
  assert.equal(peer.listenerCount(), 0);
});

test("late stats success and rejection after stop leave the cached summary untouched", async (t) => {
  for (const outcome of ["resolve", "reject"]) {
    const pending = deferred();
    const peer = new Peer();
    peer.result = () => pending.promise;
    const { observer, timers } = watch(t, peer);
    observer.stop();
    const before = observer.snapshot();
    pending[outcome](outcome === "resolve" ? new Map([["secret", { type: "candidate-pair" }]]) : new Error("secret URL"));
    await flush();
    assert.deepEqual(observer.snapshot(), before);
    assert.equal(timers.pending.size, 0);
    assert.equal(peer.listenerCount(), 0);
  }
});

test("throwing, rejected, and malformed stats are diagnostic-only and polling may recover", async (t) => {
  const { peer, timers, observer } = watch(t);
  await flush();
  for (const result of [
    () => { throw new Error("sensitive URL"); },
    () => Promise.reject(new Error("private IP")),
    () => null,
    () => ({ values() { throw new Error("private credentials"); } }),
  ]) {
    peer.result = result;
    assert.doesNotThrow(() => timers.tick());
    await flush();
    assert.equal(observer.snapshot().statsStatus, "error");
    assert.equal(observer.snapshot().candidatePairs, null);
    assert.doesNotMatch(JSON.stringify(observer.snapshot()), /sensitive|private|credentials/);
  }
  peer.result = () => new Map([["one", { type: "candidate-pair", state: "in-progress", nominated: false }]]);
  timers.tick();
  await flush();
  assert.equal(observer.snapshot().statsStatus, "ready");
  assert.equal(observer.snapshot().candidatePairs, 1);
  assert.equal(observer.snapshot().selectedPair, false);
});

test("unsupported structural peers and throwing native getters cannot interrupt computation", async (t) => {
  for (const peer of [null, {}, { connectionState: "secret address", get getStats() { throw new Error("secret"); } }]) {
    const { observer, timers } = watch(t, peer);
    assert.equal(observer.snapshot().connectionState, "unknown");
    assert.equal(observer.snapshot().statsStatus, "unavailable");
    assert.equal(timers.pending.size, 0);
    assert.doesNotThrow(() => observer.stop());
  }
  const peer = new Peer();
  Object.defineProperty(peer, "iceConnectionState", { get() { throw new Error("private hostname"); } });
  const { observer } = watch(t, peer);
  assert.doesNotThrow(() => peer.emit("iceconnectionstatechange"));
  await flush();
  assert.equal(observer.snapshot().iceConnectionState, "unknown");
  observer.stop();
  assert.equal(peer.listenerCount(), 0);
});

test("counter and numeric ICE error bounds reject strings, NaN, infinity, fractions and negative values", (t) => {
  const { peer, observer } = watch(t);
  for (let n = 0; n < 65540; n++) {
    peer.emit("icecandidate", { candidate: { candidate: "private" } });
    peer.emit("icecandidateerror", { errorCode: 701 });
  }
  assert.equal(observer.snapshot().localCandidates, 65535);
  assert.equal(observer.snapshot().iceErrorCount, 65535);
  for (const errorCode of ["701", NaN, Infinity, -1, 0, 1.5, 65536, {}]) {
    peer.emit("icecandidateerror", { errorCode, errorText: "secret" });
    assert.equal(observer.snapshot().lastIceErrorCode, null);
  }
  peer.emit("icecandidateerror", { errorCode: 65535 });
  assert.equal(observer.snapshot().lastIceErrorCode, 65535);
});

test("stats traversal is bounded and truncated absence is not reported as no selected pair", async (t) => {
  const peer = new Peer();
  let entries = 0, iteratorClosed = false;
  peer.result = () => ({ *values() {
    try { for (;;) { entries++; yield { type: "candidate-pair", state: "in-progress" }; } }
    finally { iteratorClosed = true; }
  } });
  const { observer } = watch(t, peer);
  await flush();
  assert.equal(entries, 4097);
  assert.ok(iteratorClosed);
  assert.equal(observer.snapshot().candidatePairs, 4096);
  assert.equal(observer.snapshot().statsTruncated, true);
  assert.equal(observer.snapshot().selectedPair, null);
  assert.match(formatConnectionFailure(observer.snapshot()), /at least 4096 candidate pairs/);
  assert.doesNotMatch(formatConnectionFailure(observer.snapshot()), /no selected pair/);
});

test("partial listener registration failures are cleaned without closing the peer", (t) => {
  const peer = new Peer();
  const register = peer.addEventListener;
  peer.addEventListener = function(type, listener) { register.call(this, type, listener); throw new Error("unsupported event"); };
  const { observer, timers } = watch(t, peer);
  assert.equal(peer.listenerCount(), 0);
  assert.equal(peer.connectionState, "new");
  observer.stop();
  assert.equal(timers.pending.size, 0);
});

test("already-closed peers never start polling and timer failure still permits event observations", (t) => {
  const closed = new Peer();
  closed.connectionState = "closed";
  const first = watch(t, closed);
  assert.equal(first.timers.pending.size, 0);
  assert.equal(closed.calls, 0);
  assert.equal(closed.listenerCount(), 0);
  const peer = new Peer();
  const observer = observeRtcConnection(peer, { timers: {
    setInterval() { throw new Error("unavailable timer"); }, clearInterval() {},
  } });
  t.after(() => observer.stop());
  peer.emit("icecandidateerror", { errorCode: 701 });
  assert.equal(observer.snapshot().lastIceErrorCode, 701);
  observer.stop();
  assert.equal(peer.listenerCount(), 0);
});

test("synchronous timer/provider close cannot leave a timer registered after stop", async (t) => {
  const peer = new Peer();
  const timers = new Timers();
  const schedule = timers.setInterval;
  timers.setInterval = function(callback, delay) {
    const id = schedule.call(this, callback, delay);
    callback();
    return id;
  };
  peer.result = () => {
    peer.connectionState = "closed";
    peer.emit("connectionstatechange");
    return Promise.resolve(new Map());
  };
  const observer = observeRtcConnection(peer, { timers });
  t.after(() => observer.stop());
  await flush();
  assert.equal(timers.pending.size, 0);
  assert.equal(peer.listenerCount(), 0);
  assert.equal(peer.calls, 1);
});

test("formatter distinguishes pending or unavailable stats from the last completed sample", async (t) => {
  const { peer, observer, timers } = watch(t);
  assert.match(formatConnectionFailure(observer.snapshot()), /stats pending/);
  assert.doesNotMatch(formatConnectionFailure(observer.snapshot()), /candidate pairs|no selected pair/);
  await flush();
  assert.match(formatConnectionFailure(observer.snapshot()), /stats ready/);
  peer.result = () => new Promise(() => {});
  timers.tick();
  const text = formatConnectionFailure(observer.snapshot());
  assert.match(text, /stats pending/);
  assert.match(text, /last completed sample: 0 candidate pairs/);
  assert.match(formatConnectionFailure({ statsStatus: "unavailable" }), /stats unavailable/);
  assert.match(formatConnectionFailure({ statsStatus: "error" }), /stats error/);
});

test("formatter allowlists even caller-supplied summaries and never guesses a networking cause", () => {
  const secret = "2001:db8::9 mdns-secret.local https://private.invalid/?credential=secret";
  const text = formatConnectionFailure({
    connectionState: secret, iceConnectionState: secret, iceGatheringState: secret,
    localCandidates: secret, candidatePairs: secret, lastIceErrorCode: secret,
    selectedPair: secret, relayConfigured: secret, errorText: secret, sdp: secret,
  });
  assert.doesNotMatch(text, /2001:|mdns|https:|credential|secret|relay configured|selected pair/);
  assert.match(text, /connection unknown; ICE unknown; gathering unknown/);
  assert.match(text, /does not identify the cause/);
  assert.doesNotThrow(() => formatConnectionFailure(null));
});
