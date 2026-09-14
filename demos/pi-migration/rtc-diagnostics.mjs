// Best-effort observations, not connection policy. Never retain raw candidates,
// SDP, addresses, URLs, error text, or stats identifiers in the public summary.
const COUNT_LIMIT = 65535;
const STATS_ENTRY_LIMIT = 4096;
const states = {
  connectionState: new Set(["new", "connecting", "connected", "disconnected", "failed"]),
  iceConnectionState: new Set(["new", "checking", "connected", "completed", "disconnected", "failed"]),
  iceGatheringState: new Set(["new", "gathering", "complete"]),
  signalingState: new Set(["stable", "have-local-offer", "have-remote-offer", "have-local-pranswer", "have-remote-pranswer"]),
};
const read = (object, key) => { try { return object?.[key]; } catch { return undefined; } };
const state = (name, value) => states[name].has(value) ? value : "unknown";
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, COUNT_LIMIT) : null;
const code = (value) => Number.isSafeInteger(value) && value > 0 && value <= COUNT_LIMIT ? value : null;

export function observeRtcConnection(peer, { sampleIntervalMs = 500, relayConfigured = null,
  timers = globalThis } = {}) {
  const summary = {
    connectionState: "unknown", iceConnectionState: "unknown",
    iceGatheringState: "unknown", signalingState: "unknown",
    localCandidates: 0, endOfCandidates: false, iceErrorCount: 0, lastIceErrorCode: null,
    statsStatus: "unavailable", candidatePairs: null, selectedPair: null, statsTruncated: false,
    relayConfigured: typeof relayConfigured === "boolean" ? relayConfigured : null,
  };
  let stopped = false;
  let interval = null;
  let inFlight = false;
  const removers = [];

  function refreshStates() {
    const observed = {};
    for (const name of Object.keys(states)) observed[name] = read(peer, name);
    // Session teardown may close the native peer before notifying its caller.
    // Preserve the last nonclosed observation, not four uninformative closed
    // states. Stopping freezes these cached observations permanently.
    if (Object.values(observed).includes("closed")) return false;
    for (const name of Object.keys(states)) summary[name] = state(name, observed[name]);
    return true;
  }

  function stop() {
    if (stopped) return;
    refreshStates();
    stopped = true;
    if (interval !== null) {
      try { read(timers, "clearInterval")?.call(timers, interval); } catch { /* diagnostics never own execution */ }
      interval = null;
    }
    for (const remove of removers.splice(0)) {
      try { remove(); } catch { /* compatible peers may not implement every event */ }
    }
  }

  function onState() {
    if (!stopped && !refreshStates()) stop();
  }

  function add(type, listener) {
    const register = read(peer, "addEventListener");
    const unregister = read(peer, "removeEventListener");
    if (stopped || typeof register !== "function" || typeof unregister !== "function") return;
    const remove = () => unregister.call(peer, type, listener);
    try {
      register.call(peer, type, listener);
      if (stopped) remove();
      else removers.push(remove);
    } catch {
      try { remove(); } catch { /* roll back partially installed structural listeners */ }
    }
  }

  function onCandidate(event) {
    if (stopped) return;
    const candidate = read(event, "candidate");
    if (candidate === null) summary.endOfCandidates = true;
    else {
      const bytes = read(candidate, "candidate");
      if (bytes === "") summary.endOfCandidates = true;
      else if (typeof bytes === "string") summary.localCandidates = Math.min(COUNT_LIMIT, summary.localCandidates + 1);
    }
  }

  function onIceError(event) {
    if (stopped) return;
    summary.iceErrorCount = Math.min(COUNT_LIMIT, summary.iceErrorCount + 1);
    summary.lastIceErrorCode = code(read(event, "errorCode"));
  }

  function statsFailed() {
    if (stopped) return;
    inFlight = false;
    summary.statsStatus = "error";
    summary.candidatePairs = null;
    summary.selectedPair = null;
    summary.statsTruncated = false;
  }

  function statsReady(report) {
    if (stopped) return;
    try {
      const values = read(report, "values");
      if (typeof values !== "function") throw new Error("stats unavailable");
      let entries = 0, pairs = 0, selected = false, truncated = false;
      for (const item of values.call(report)) {
        if (entries++ === STATS_ENTRY_LIMIT) { truncated = true; break; }
        const type = read(item, "type");
        if (type === "candidate-pair") {
          pairs++;
          if (read(item, "state") === "succeeded" && read(item, "nominated") === true) selected = true;
        } else if (type === "transport") {
          const selectedId = read(item, "selectedCandidatePairId");
          if (typeof selectedId === "string" && selectedId.length > 0) selected = true;
        }
      }
      if (stopped) return;
      summary.statsStatus = "ready";
      summary.candidatePairs = pairs;
      summary.selectedPair = selected ? true : truncated ? null : false;
      summary.statsTruncated = truncated;
      inFlight = false;
    } catch { statsFailed(); }
  }

  const getStats = read(peer, "getStats");
  function sample() {
    if (stopped) return;
    if (!refreshStates()) { stop(); return; }
    if (inFlight || typeof getStats !== "function") return;
    inFlight = true;
    summary.statsStatus = "pending";
    // Only one asynchronous call may be pending. A never-settling provider
    // consumes no additional calls; stop still synchronously removes the one
    // timer and all listeners. Late results/rejections cannot change the cache.
    try { void Promise.resolve(getStats.call(peer)).then(statsReady, statsFailed); }
    catch { statsFailed(); }
  }

  if (refreshStates()) {
    for (const type of ["connectionstatechange", "iceconnectionstatechange", "icegatheringstatechange", "signalingstatechange"]) add(type, onState);
    add("icecandidate", onCandidate);
    add("icecandidateerror", onIceError);
    if (!stopped && typeof getStats === "function") {
      const delay = Number.isSafeInteger(sampleIntervalMs) && sampleIntervalMs >= 100 && sampleIntervalMs <= 60000 ? sampleIntervalMs : 500;
      const schedule = read(timers, "setInterval");
      const cancel = read(timers, "clearInterval");
      if (typeof schedule === "function" && typeof cancel === "function") {
        try {
          const handle = schedule.call(timers, sample, delay);
          // Structural timers can invoke their callback before returning the
          // handle; a synchronous native close may have already stopped us.
          if (stopped) cancel.call(timers, handle);
          else {
            interval = handle;
            try { read(interval, "unref")?.call(interval); } catch { /* optional Node convenience */ }
          }
        } catch { /* state/event observations remain useful without polling */ }
      }
      sample();
    }
  } else stop();

  return {
    snapshot() { if (!stopped && !refreshStates()) stop(); return { ...summary }; },
    stop,
  };
}

export function formatConnectionFailure(summary) {
  const connection = state("connectionState", read(summary, "connectionState"));
  const ice = state("iceConnectionState", read(summary, "iceConnectionState"));
  const gathering = state("iceGatheringState", read(summary, "iceGatheringState"));
  const local = count(read(summary, "localCandidates"));
  const pairs = count(read(summary, "candidatePairs"));
  const lastCode = code(read(summary, "lastIceErrorCode"));
  const suppliedStatus = read(summary, "statsStatus");
  const statsStatus = ["unavailable", "pending", "ready", "error"].includes(suppliedStatus) ? suppliedStatus : "unavailable";
  const details = [`connection ${connection}`, `ICE ${ice}`, `gathering ${gathering}`];
  if (local !== null) details.push(`${local} local candidate events`);
  details.push(`candidate-pair stats ${statsStatus}`);
  if (pairs !== null) details.push(`${statsStatus === "pending" ? "last completed sample: " : ""}${read(summary, "statsTruncated") === true ? "at least " : ""}${pairs} candidate pairs`);
  if (read(summary, "selectedPair") === true) details.push("selected pair observed");
  else if (read(summary, "selectedPair") === false) details.push("no selected pair observed");
  if (lastCode !== null) details.push(`ICE error code ${lastCode}`);
  if (read(summary, "relayConfigured") === false) details.push("no relay configured");
  return `Last observed WebRTC state: ${details.join("; ")}. This does not identify the cause; check browser/network configuration or use Same-browser mode.`;
}
