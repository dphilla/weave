import { TabRuntime } from "./runtime.mjs";
import { TabIndicator } from "./tab-indicator.mjs";

const $ = (selector) => document.querySelector(selector);
const ids = ["1", "2", "3", "4", "5", "6"];
const availableStates = new Set(["idle", "retired"]);
const activeStates = new Set(["running", "connecting", "precopy", "finalizing", "starting"]);
const count = (value) => { try { return BigInt(value || 0); } catch { return 0n; } };
const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const formatted = (value) => count(value).toLocaleString("en-US");
const compact = (value) => count(value) < 1_000_000_000n ? formatted(value) : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(Number(value));
const stateNames = { idle: "Ready to receive", starting: "Starting Wasm", running: "Calculating π", connecting: "Connecting", receiving: "Receiving state", precopy: "Copying pages", finalizing: "Committing", retired: "Source retired", uncertain: "Outcome uncertain", stopped: "Stopped", failed: "Needs attention", duplicate: "Duplicate tab" };

export async function mount() {
  const payload = JSON.parse($("#weave-workload").textContent);
  const bytes = Uint8Array.from(atob(payload.base64), (char) => char.charCodeAt(0));
  const params = new URLSearchParams(location.hash.slice(1));
  const role = params.get("role") === "node" ? "node" : "controller";
  const nodeId = role === "node" ? params.get("node") : null;
  const transport = params.get("transport") || "local";
  if (!["local", "webrtc"].includes(transport)) throw new Error("Unknown transport. Use local or webrtc.");
  let room = params.get("room");
  const unsupported = [];
  if (!["https:", "http:"].includes(location.protocol)) unsupported.push("serving this file over HTTPS or localhost, not opening it with file://");
  if (!globalThis.isSecureContext) unsupported.push("a secure context (HTTPS or localhost)");
  if (!globalThis.WebAssembly) unsupported.push("WebAssembly");
  if (!globalThis.BroadcastChannel) unsupported.push("BroadcastChannel");
  if (!globalThis.MessageChannel) unsupported.push("MessageChannel task scheduling");
  if (transport === "webrtc" && !globalThis.RTCPeerConnection) unsupported.push("WebRTC DataChannels");
  if (!globalThis.crypto?.randomUUID) unsupported.push("secure random identifiers");
  if (globalThis.top !== globalThis.self) unsupported.push("opening the demo directly, outside an embedded preview or iframe");
  if (unsupported.length) {
    $("#compatibility").hidden = false;
    $("#compatibility").textContent = `This demo needs ${unsupported.join(", ")}. Deploy this single HTML file to a static HTTPS site and open its direct URL in a current desktop browser.`;
    $("#open-tabs").disabled = true;
    return;
  }
  if (!room) {
    if (role === "node") throw new Error("This compute tab is missing its demo room. Open it from the dashboard.");
    room = crypto.randomUUID().replaceAll("-", "");
    history.replaceState(null, "", `${location.pathname}${location.search}#room=${room}&transport=${transport}`);
  }
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(room)) throw new Error("The room link is invalid. Open this page without its URL fragment to create a new room.");
  if (role === "node" && !ids.includes(nodeId)) throw new Error("The compute tab number must be 1 through 6.");

  let runtime = null, initialized = false, busy = false, auto = false, stopped = false;
  let frozen = false, pageClosed = false, stopConfirmed = false, stopFailed = false;
  const tabIndicator = new TabIndicator(document);
  let warning = "", ownerLost = false, framePending = false, autoTimer = null;
  let progress = { terms: "0", estimate: 0, sequence: "0" };
  let currentOwner = null, lastOwner = null;
  const windows = new Map(), openedSlots = new Set(), historyEvents = [], journal = [];
  const chart = [], confirmed = new Map(), seenLogs = new Set();
  let lastChartTerms = 0n, lastDraw = 0;

  const nodeUrl = (id) => `${location.origin}${location.pathname}${location.search}#room=${room}&transport=${transport}&role=node&node=${id}`;
  const peerNodes = (snapshot) => {
    const nodes = [...snapshot.nodes];
    if (role === "node") nodes.push({ nodeId, instanceId: snapshot.instanceId, state: snapshot.state, ownership: snapshot.ownership, progress: snapshot.progress, online: true, duplicate: snapshot.state === "duplicate", lastSeen: Date.now() });
    return nodes;
  };
  const getNodes = () => runtime ? peerNodes(runtime.getSnapshot()) : [];
  const owner = () => {
    const nodes = getNodes().filter((peer) => peer.online && !peer.duplicate && peer.ownership === "retained" && activeStates.has(peer.state));
    return nodes.length === 1 ? nodes[0] : null;
  };
  const operationBusy = () => busy || runtime?.getSnapshot().operation?.status === "pending";
  function updateTabIndicator(snapshot = runtime?.getSnapshot()) {
    if (snapshot) tabIndicator.update(snapshot, { frozen, closed: pageClosed, stopped, stopConfirmed, stopFailed, auto });
  }
  function addLog(message, level = "info", key = null) {
    if (key && seenLogs.has(key)) return;
    if (key) { seenLogs.add(key); if (seenLogs.size > 300) seenLogs.delete(seenLogs.values().next().value); }
    journal.unshift({ timestamp: Date.now(), message, level });
    if (journal.length > 100) journal.pop();
    requestRender();
  }
  function setWarning(message) { warning = message; requestRender(); }
  function stopAuto() { auto = false; clearTimeout(autoTimer); autoTimer = null; requestRender(); }
  function scheduleAuto() {
    clearTimeout(autoTimer);
    if (!auto || stopped || ownerLost) return;
    autoTimer = setTimeout(() => { void move(); }, 6500);
  }
  function observe(event) {
    if (event.type === "boundary" || event.type === "operation") {
      historyEvents.push({ ...event, observedAt: Date.now() });
      if (historyEvents.length > 256) historyEvents.shift();
    }
    if (event.type === "progress" || event.type === "boundary") {
      if (count(event.terms) >= count(progress.terms) && Number.isFinite(event.estimate)) progress = { terms: event.terms, estimate: event.estimate, sequence: event.sequence };
      if (event.type === "boundary" && event.kind === "start") addLog(`Tab ${event.nodeId} started the one Wasm calculation. First progress event: #${event.sequence}.`, "info", "start");
      if (event.type === "boundary" && ["final", "resume"].includes(event.kind)) {
        const final = historyEvents.findLast((item) => item.type === "boundary" && item.kind === "final" && item.operationId === event.operationId);
        const resume = historyEvents.findLast((item) => item.type === "boundary" && item.kind === "resume" && item.operationId === event.operationId);
        if (final && resume) {
          const exact = count(resume.sequence) === count(final.sequence) + 1n && count(resume.terms) === count(final.terms) + 32768n;
          addLog(exact ? `Continuity verified: tab ${final.nodeId} event #${final.sequence} → tab ${resume.nodeId} event #${resume.sequence}.` : "Progress boundary mismatch. Stop the tour and inspect the downloaded log.", exact ? "info" : "error", `boundary-${event.operationId}`);
          if (!exact) { stopAuto(); setWarning("A progress continuity check failed. No further automatic moves will be made. Download the session log for investigation."); }
        }
      }
    }
    if (event.type === "operation" && event.operation) {
      const op = event.operation;
      if (op.status === "succeeded" && !confirmed.has(op.id)) {
        confirmed.set(op.id, { ...op, terms: progress.terms, timestamp: Date.now() });
        addLog(`Tab ${op.source} → tab ${op.target}: handoff confirmed. The old source is retired.`, "info", `committed-${op.id}`);
        const local = role === "node" ? runtime.getSnapshot().progress : progress;
        chart.push({ terms: local.terms, estimate: local.estimate, migration: true, target: op.target });
      } else if (["failed", "uncertain"].includes(op.status)) {
        addLog(op.message || `Migration ${op.status}.`, "error", `${op.status}-${op.id}`);
        stopAuto();
        setWarning(op.status === "uncertain" ? `${op.message || "Handoff outcome is uncertain."} We will not start a replacement workload. Keep the tabs open and inspect their state.` : `${op.message || "Migration failed before handoff."} Check the source tab: a pre-commit failure can leave it running safely.`);
      } else if (op.status === "pending") addLog(`Tab ${op.source} → tab ${op.target}: ${op.message || op.phase}.`, "info", `${op.phase}-${op.id}`);
    }
    if (event.type === "log") addLog(event.message, event.level);
    updateTabIndicator();
    requestRender();
  }

  $("#fleet").innerHTML = ids.map((id) => `<article class="node offline" data-node-id="${id}"><div class="node-top"><span class="node-id">TAB ${id.padStart(2, "0")}</span><i class="node-status-dot" aria-hidden="true"></i></div><div class="node-icon" aria-hidden="true">${"<i></i>".repeat(8)}</div><strong class="node-state">Not connected</strong><span class="node-meta">Waiting for a tab</span><div class="node-actions"><button class="node-action" data-focus-node="${id}" aria-label="Focus compute tab ${id}">View tab ↗</button><button class="node-action" data-migrate-to="${id}" disabled>Move here →</button></div></article>`).join("");
  runtime = new TabRuntime({ role, nodeId, room, wasmBytes: bytes, transport, onEvent: observe });
  Object.defineProperty(window, "__PI_DEMO__", { configurable: false, value: Object.freeze({
    snapshot() {
      const snap = runtime.getSnapshot();
      return structuredClone({ ...snap, role, transport, tabId: nodeId, sessionId: room, localState: snap.state, ownerId: currentOwner, terms: progress.terms, hostSequence: progress.sequence, migrations: confirmed.size, completedMigrations: confirmed.size, busy: operationBusy(), auto, warning: warning || snap.error, history: historyEvents, events: historyEvents.filter((event) => event.type === "boundary"), progress: role === "node" ? snap.progress : progress, peers: peerNodes(snap), stopped, initialized });
    },
  }) });

  if (role === "node") {
    document.body.classList.add("node-view");
    $("#hero-title").innerHTML = `Tab ${nodeId.padStart(2, "0")}. <em>A place to compute.</em>`;
    $("#hero-description").textContent = "This tab can host the running π calculation. When the workload arrives, it resumes the same live Wasm continuation. When it leaves, this copy retires.";
    $("#controller-controls").hidden = true;
    $("#worker-controls").hidden = false;
    $("#setup-note").textContent = "Leave this tab open. Refreshing or closing an owning tab destroys its live computation; Weave does not silently restart it.";
    $("#lab-label").textContent = `COMPUTE TAB ${nodeId.padStart(2, "0")}`;
  }
  $("#module-hash").textContent = payload.sha256;
  $("#transport-mode").value = transport;
  $("#transport-label").textContent = transport === "local" ? "WASM → TAB STREAM → WASM" : "WASM → WEBRTC → WASM";
  $("#data-path").textContent = transport === "local" ? "Bounded browser-tab byte stream over BroadcastChannel (no network server)" : "Ordered, reliable WebRTC DataChannel (local ICE must work)";
  $("#copy-description").textContent = transport === "local" ? "Weave moves actual execution state over a tab byte stream." : "Weave moves actual execution state over WebRTC.";
  $("#transport-mode").addEventListener("change", () => {
    if (getNodes().length || openedSlots.size || runtime.getSnapshot().everStarted) { $("#transport-mode").value = transport; return; }
    params.set("room", room); params.set("transport", $("#transport-mode").value);
    location.replace(`${location.pathname}${location.search}#${params}`); location.reload();
  });
  $("#module-size").textContent = `${payload.bytes.toLocaleString()} bytes · all code embedded in this HTML`;
  $("#license-text").textContent = $("#license-text").textContent.trim();
  $("#show-license").addEventListener("click", () => $("#license-dialog").showModal());
  $("#download-log").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ application: "weave-pi-demo-v1", moduleHash: payload.sha256, ...window.__PI_DEMO__.snapshot(), journal }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = `weave-pi-session-${room.slice(0, 8)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });

  function openNode(id) {
    const existing = windows.get(id);
    if (existing && !existing.closed) return existing;
    const connected = getNodes().find((node) => node.nodeId === id && node.online);
    if (connected) return null; // Never reload a live node just to obtain a handle.
    const child = window.open(nodeUrl(id), `weave-pi-${room}-${id}`);
    if (child) { windows.set(id, child); openedSlots.add(id); }
    return child;
  }
  function openTabs(oneAtATime = false) {
    const missing = ids.filter((id) => !getNodes().some((node) => node.nodeId === id && node.online) && (!windows.get(id) || windows.get(id).closed));
    let blocked = false;
    for (const id of (oneAtATime ? missing.slice(0, 1) : missing)) if (!openNode(id)) blocked = true;
    if (blocked) setWarning("Your browser blocked some tabs. Allow pop-ups for this site, or click “Open next tab” once for each remaining tab. Return to this dashboard when all six are connected.");
    else if (missing.length) setWarning("Compute tabs are opening. Return to this dashboard when you’re ready. If fewer than six connect, use “Open next tab.”");
    requestRender();
    if (!blocked) $(".lab").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("#open-tabs").addEventListener("click", () => openTabs());
  $("#open-next").addEventListener("click", () => openTabs(true));
  document.querySelectorAll("[data-focus-node]").forEach((button) => button.addEventListener("click", () => {
    const handle = windows.get(button.dataset.focusNode);
    if (handle && !handle.closed) { handle.focus(); return; }
    if (role === "node" && button.dataset.focusNode === nodeId) return;
    setWarning("Switch to that tab using your browser’s tab bar. We won’t reload a live compute tab just to focus it.");
  }));
  $("#back-dashboard").addEventListener("click", () => {
    if (window.opener && !window.opener.closed) { window.opener.focus(); return; }
    setWarning("Switch to the dashboard in your browser’s tab bar. If it was closed, the owning tab keeps computing, but its original controller is gone. Stop by closing all compute tabs before starting a new room.");
  });
  $("#start-compute").addEventListener("click", async () => {
    if (busy || stopped || runtime.getSnapshot().everStarted) return;
    if (getNodes().filter((node) => node.online && !node.duplicate).length !== 6) return;
    busy = true; warning = ""; requestRender();
    try { await runtime.start("1"); addLog("One Wasm instance is running. Choose a destination or turn on Auto tour."); }
    catch (error) { setWarning(error.message); addLog(error.message, "error"); }
    finally { busy = false; requestRender(); }
  });
  async function move(targetId = null) {
    if (operationBusy() || stopped || ownerLost) return;
    const source = owner();
    if (!source || source.state !== "running") { stopAuto(); return; }
    const target = targetId || ids[Number(source.nodeId) % 6];
    const destination = getNodes().find((node) => node.nodeId === target && node.online && !node.duplicate && availableStates.has(node.state));
    if (!destination || target === source.nodeId) { stopAuto(); setWarning(`Tab ${target} is not ready. Keep all six tabs open and wait for it to reconnect; do not refresh the owning tab.`); return; }
    busy = true; warning = ""; requestRender();
    try {
      const result = await runtime.migrate(source.nodeId, target);
      if (result.status !== "succeeded") { stopAuto(); setWarning(result.message || "Handoff was not confirmed. Inspect the tab states."); }
    } catch (error) { stopAuto(); setWarning(error.message); addLog(error.message, "error"); }
    finally { busy = false; requestRender(); if (auto) scheduleAuto(); }
  }
  $("#migrate-next").addEventListener("click", () => { void move(); });
  document.querySelectorAll("[data-migrate-to]").forEach((button) => button.addEventListener("click", () => { void move(button.dataset.migrateTo); }));
  $("#auto-tour").addEventListener("click", () => {
    if (auto) { stopAuto(); addLog("Auto tour paused. The current tab keeps calculating."); return; }
    if (!owner() || operationBusy() || stopped || ownerLost) return;
    auto = true; addLog("Auto tour on: one confirmed handoff every few seconds. The calculation is never restarted."); requestRender(); void move();
  });
  $("#stop-compute").addEventListener("click", async () => {
    if (stopped) return;
    stopAuto(); stopped = true; busy = true; requestRender();
    try { await runtime.stopAll(); stopConfirmed = true; setWarning("Demo stopped. To run again, close the six compute tabs and open this page without its #room fragment. Starting again is a new calculation, not a migration."); addLog("Explicit stop requested and acknowledged. This room cannot start another workload."); }
    catch (error) { stopFailed = true; setWarning(`${error.message} Close all compute tabs before creating a new demo room.`); addLog(error.message, "error"); }
    finally { busy = false; updateTabIndicator(); requestRender(); }
  });

  function requestRender() {
    if (framePending) return;
    framePending = true;
    setTimeout(() => { framePending = false; render(); }, 100);
  }
  function drawChart() {
    const canvas = $("#convergence"), rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(94 * dpr);
    const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr);
    const width = rect.width, height = 94;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "#e5e9dc"; ctx.lineWidth = 1;
    for (const y of [12, 42, 72]) { ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(width, y + .5); ctx.stroke(); }
    if (chart.length < 2) {
      ctx.strokeStyle = "#cdd8bf"; ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.moveTo(0, 52); ctx.lineTo(width, 52); ctx.stroke(); return;
    }
    const points = chart.slice(-150), errors = points.map((point) => Math.log10(Math.max(1e-16, Math.abs(Math.PI - point.estimate))));
    const maxError = Math.max(...errors) + .12, minError = Math.min(...errors) - .12;
    const y = (index) => 8 + (maxError - errors[index]) / Math.max(.3, maxError - minError) * 68;
    // Smaller numerical error is lower on the graph; this is a log-scale gap,
    // not generated digits or a fabricated performance measurement.
    const py = (index) => y(index), px = (index) => index / (points.length - 1) * width;
    const gradient = ctx.createLinearGradient(0, 0, 0, height); gradient.addColorStop(0, "#aac48030"); gradient.addColorStop(1, "#aac48000");
    ctx.beginPath(); ctx.moveTo(0, height); points.forEach((_, index) => ctx.lineTo(px(index), py(index))); ctx.lineTo(width, height); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
    ctx.strokeStyle = "#708e51"; ctx.lineWidth = 1.6; ctx.beginPath(); points.forEach((_, index) => index === 0 ? ctx.moveTo(px(index), py(index)) : ctx.lineTo(px(index), py(index))); ctx.stroke();
    points.forEach((point, index) => { if (!point.migration) return; ctx.strokeStyle = "#d69a58"; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(px(index), 5); ctx.lineTo(px(index), 87); ctx.stroke(); ctx.setLineDash([]); });
    ctx.beginPath(); ctx.arc(width - 2, py(points.length - 1), 2.7, 0, 2 * Math.PI); ctx.fillStyle = "#68854d"; ctx.fill();
  }
  function render() {
    if (!runtime) return;
    const snapshot = runtime.getSnapshot(), nodes = peerNodes(snapshot), running = owner();
    const online = ids.filter((id) => nodes.some((node) => node.nodeId === id && node.online && !node.duplicate)).length;
    const op = snapshot.operation;
    for (const node of nodes) if (node.online && count(node.progress?.terms) > count(progress.terms)) progress = { ...node.progress };
    currentOwner = running?.nodeId || null;
    if (currentOwner) { lastOwner = currentOwner; ownerLost = false; }
    else if (lastOwner && snapshot.everStarted && !stopped && !operationBusy()) {
      const last = nodes.find((node) => node.nodeId === lastOwner);
      if (!last || !last.online) {
        ownerLost = true; stopAuto();
        warning = `The last owning tab (${lastOwner}) is closed or unresponsive. Its computation may be lost or suspended. We will not restart it or guess who owns it. Keep remaining tabs open to inspect state; close all compute tabs before starting a fresh room.`;
      }
    }
    const blocked = Boolean(snapshot.error) || ownerLost || nodes.some((node) => node.duplicate);
    const display = role === "node" ? snapshot.progress : progress;
    const localRunning = role === "node" ? activeStates.has(snapshot.state) && snapshot.ownership === "retained" : Boolean(running);
    updateTabIndicator(snapshot);
    $("#connection-indicator").innerHTML = `<i></i>${role === "node" ? `Compute tab ${nodeId}` : `${online} of 6 tabs connected`}`;
    $("#connection-indicator").classList.toggle("ready", initialized);
    $("#live-dot").classList.toggle("running", localRunning);
    $("#owner-label").textContent = role === "node" ? (stateNames[snapshot.state] || snapshot.state) : running ? `Running in tab ${running.nodeId.padStart(2, "0")}` : operationBusy() ? "Handoff in progress" : ownerLost ? "Owner unconfirmed" : stopped ? "Demo stopped" : snapshot.everStarted ? "Observing ownership" : "Waiting to begin";
    $("#owner-label").classList.toggle("active", localRunning);
    if (count(display.terms) > 0n) $("#pi-value").textContent = display.estimate.toFixed(12);
    $("#terms").textContent = compact(display.terms); $("#terms").title = `${formatted(display.terms)} original series terms`;
    $("#handoffs").textContent = String(confirmed.size);
    $("#gap").textContent = count(display.terms) ? Math.abs(Math.PI - display.estimate).toExponential(1) : "—";
    $("#fleet-count").textContent = `${online} / 6 connected`;
    $("#open-tabs").hidden = online === 6 || snapshot.everStarted || openedSlots.size > 0;
    $("#open-next").hidden = online === 6 || snapshot.everStarted || openedSlots.size === 0;
    $("#open-tabs").disabled = !initialized || busy;
    $("#transport-mode").disabled = online > 0 || openedSlots.size > 0 || snapshot.everStarted;
    $("#open-next").disabled = !initialized || busy;
    $("#start-compute").hidden = snapshot.everStarted;
    $("#start-compute").disabled = online !== 6 || !initialized || busy || stopped || blocked;
    $("#migrate-next").hidden = !snapshot.everStarted;
    $("#migrate-next").disabled = !running || running.state !== "running" || operationBusy() || stopped || blocked || op?.status === "uncertain";
    $("#auto-tour").disabled = (!running || operationBusy() || stopped || blocked || op?.status === "uncertain") && !auto;
    $("#auto-tour").setAttribute("aria-pressed", String(auto));
    $("#auto-tour").innerHTML = `<span class="tour-dot"></span>${auto ? "Pause tour" : "Auto tour"}`;
    $("#stop-compute").disabled = !snapshot.everStarted || stopped;
    if (online === 6 && !snapshot.everStarted && !blocked && /tabs are opening|browser blocked/.test(warning)) warning = "";
    const shownWarning = snapshot.error || warning;
    $("#warning").hidden = !shownWarning;
    if (shownWarning) $("#warning").textContent = shownWarning;
    document.querySelectorAll("[data-node-id]").forEach((card) => {
      const id = card.dataset.nodeId, matches = nodes.filter((node) => node.nodeId === id), node = matches.find((peer) => peer.online) || matches[0];
      const nodeOnline = Boolean(node?.online), moving = nodeOnline && ["connecting", "receiving", "precopy", "finalizing"].includes(node.state), computing = nodeOnline && node.state === "running" && node.ownership === "retained";
      card.className = `node${!nodeOnline ? " offline" : ""}${computing ? " active" : ""}${moving ? " moving" : ""}${node?.state === "retired" ? " retired" : ""}`;
      card.querySelector(".node-state").textContent = node?.duplicate ? "Duplicate tab" : !nodeOnline ? node ? "Closed / quiet" : "Not connected" : stateNames[node.state] || node.state;
      card.querySelector(".node-meta").textContent = count(node?.progress?.terms) ? `${compact(node.progress.terms)} terms${node?.state === "retired" ? " · frozen" : ""}` : nodeOnline ? "Wasm ready" : "Waiting for a tab";
      card.querySelector("[data-migrate-to]").hidden = role === "node";
      card.querySelector("[data-migrate-to]").disabled = role !== "controller" || !nodeOnline || !availableStates.has(node.state) || !running || running.state !== "running" || id === running.nodeId || operationBusy() || stopped || blocked || op?.status === "uncertain";
    });
    let phase = "idle", title = "A program needs a place to run.", description = "Open six compute tabs, then start the calculation. This dashboard watches; only one compute tab will own the running workload.";
    if (snapshot.everStarted) { phase = "running"; title = "The calculation is alive."; description = "The sum, compensation, and counter live inside Wasm—not in this dashboard. Move the workload and its next progress event continues the same sequence."; }
    if (op?.status === "pending") { phase = op.phase; title = op.phase === "connecting" ? `Connecting tab ${op.source} to tab ${op.target}.` : op.phase === "finalizing" ? "A tiny pause. A real handoff." : "The running state is moving."; description = `Weave stages the destination and copies the suspended execution state over ${transport === "local" ? "a bounded browser-tab byte stream" : "a reliable WebRTC channel"}. No replacement calculation is started.`; }
    else if (op?.status === "succeeded") { phase = "committed"; title = `Same program. Now in tab ${running?.nodeId || op.target}.`; description = "The destination resumed the live continuation. The old source has irrevocably retired, while every accumulated term and the next instruction travel with the workload."; }
    else if (op?.status === "failed") { title = "The handoff did not finish."; description = "A failure before commit can leave the original tab calculating safely. The log and source state show what happened; the tour is paused."; }
    else if (op?.status === "uncertain" || ownerLost) { title = "We won’t guess about ownership."; description = "An unconfirmed or missing peer is not permission to run another copy. Automatic movement is paused and no replacement calculation will be started."; }
    if (stopped) { phase = "stopped"; title = stopConfirmed ? "The experiment is stopped." : stopFailed ? "Stop was not fully confirmed." : "Asking every tab to stop."; description = stopConfirmed ? "This room will not restart. Close its compute tabs before opening a fresh demo room for a new calculation." : "This room will not restart. Until every tab acknowledges, a quiet owner may still be computing. Check the tab states and close all compute tabs before creating a new room."; }
    if (role === "node" && snapshot.state === "retired") { phase = "committed"; title = "My work moved. I stopped."; description = "These numbers are intentionally frozen. This instance has relinquished execution authority. Another tab is continuing the calculation."; }
    $("#phase-title").textContent = title; $("#phase-description").textContent = description;
    document.querySelectorAll("[data-phase]").forEach((element) => element.classList.toggle("active", element.dataset.phase === (phase === "connecting" || phase === "finalizing" ? "precopy" : phase)));
    const resume = historyEvents.findLast((event) => event.type === "boundary" && event.kind === "resume");
    const final = resume && historyEvents.findLast((event) => event.type === "boundary" && event.kind === "final" && event.operationId === resume.operationId);
    if (resume && final) { $("#proof-title").textContent = `Progress #${final.sequence} → #${resume.sequence}`; $("#proof-detail").textContent = `Tab ${final.nodeId} → tab ${resume.nodeId} · ${formatted(final.terms)} → ${formatted(resume.terms)} terms`; }
    $("#event-log").innerHTML = journal.length ? journal.slice(0, 24).map((entry) => `<li class="${entry.level === "error" ? "log-error" : ""}"><time>${new Date(entry.timestamp).toLocaleTimeString("en-GB", { hour12: false })}</time><span>${escape(entry.message)}</span></li>`).join("") : '<li class="empty-log">Start the experiment to see the journey unfold.</li>';
    if (count(display.terms) > lastChartTerms && Date.now() - lastDraw >= 350) {
      chart.push({ ...display }); if (chart.length > 180) chart.shift(); lastChartTerms = count(display.terms); lastDraw = Date.now();
    }
    $("#chart-caption").textContent = count(display.terms) ? `${formatted(display.sequence)} host progress events` : "Waiting for Wasm progress";
    drawChart();
  }
  addEventListener("resize", () => requestRender());
  document.addEventListener("freeze", () => { frozen = true; updateTabIndicator(); });
  document.addEventListener("resume", () => { frozen = false; updateTabIndicator(); });
  addEventListener("pagehide", () => { pageClosed = true; updateTabIndicator(); stopAuto(); void runtime.close(); }, { once: true });
  addEventListener("pageshow", (event) => { if (event.persisted) { setWarning("This page returned from the browser’s page cache after its runtime closed. Do not restart a workload here. Close the compute tabs and open a fresh demo room."); initialized = false; } });
  await runtime.init(); initialized = true;
  addLog(role === "controller" ? `Single-file lab ready. Real Weave migration over ${transport === "local" ? "the local browser-tab transport; no networking setup required" : "WebRTC; working local ICE connectivity is required"}.` : `Compute tab ${nodeId} joined the room. Waiting for the dashboard.`, "info");
  render();
  // Canvas is redrawn on real observations only. Reduced-motion users retain
  // all live state and controls; decorative bar motion is disabled by CSS.
}
