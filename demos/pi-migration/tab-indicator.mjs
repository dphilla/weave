// Browser-tab chrome is a view of local execution authority, never a simulated
// tour timer. Keep this synchronous: background page-render timers may lag.
const palette = {
  ready: ["#dde2e5", "#56636c"], starting: ["#ffd166", "#533900"],
  running: ["#bdff32", "#173400"], sending: ["#ffbd59", "#583200"],
  receiving: ["#ffbd59", "#583200"], handoff: ["#ffbd59", "#583200"],
  retired: ["#d7dddf", "#6e7a80"], paused: ["#c8d8ec", "#294d77"],
  uncertain: ["#ff8070", "#631b14"], error: ["#ff8070", "#631b14"],
  stopped: ["#d7dddf", "#56636c"], controller: ["#304254", "#ffffff"],
};
const ids = /^[1-6]$/;

function icon(status, nodeId) {
  const [background, ink] = palette[status];
  const number = `<text x="16" y="24" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="23" font-weight="700" fill="${ink}">${nodeId}</text>`;
  const shapes = {
    running: `<path d="M12 7.5 25 16 12 24.5Z" fill="${ink}"/>`,
    starting: `<circle cx="16" cy="16" r="8" fill="none" stroke="${ink}" stroke-width="4" stroke-dasharray="30 20"/>`,
    sending: `<path d="M7 16h17m-7-7 7 7-7 7" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`,
    receiving: `<path d="M16 7v17m-7-7 7 7 7-7" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`,
    handoff: `<path d="M7 12h17l-5-5M25 20H8l5 5" fill="none" stroke="${ink}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    paused: `<path d="M10 8h4v16h-4zm8 0h4v16h-4z" fill="${ink}"/>`,
    stopped: `<rect x="9" y="9" width="14" height="14" rx="1" fill="${ink}"/>`,
    uncertain: `<text x="16" y="25" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="26" font-weight="700" fill="${ink}">?</text>`,
    error: `<path d="m10 10 12 12m0-12L10 22" stroke="${ink}" stroke-width="4" stroke-linecap="round"/>`,
    controller: `<path d="M8 8h6v6H8zm10 0h6v6h-6zM8 18h6v6H8zm10 0h6v6h-6z" fill="${ink}"/>`,
    ready: number,
    retired: `${number}<path d="M7 28h18" stroke="${ink}" stroke-width="2"/>`,
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="1" y="1" width="30" height="30" rx="7" fill="${background}" stroke="${ink}" stroke-width="2"/>${shapes[status]}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function tabAppearance(snapshot, { frozen = false, closed = false, stopped = false, stopConfirmed = false, stopFailed = false, auto = false } = {}) {
  if (snapshot.role === "controller") {
    const owners = (snapshot.nodes || []).filter((node) => node.online && !node.duplicate && node.ownership === "retained" && ["running", "starting", "connecting", "precopy"].includes(node.state));
    const op = snapshot.operation;
    let label = "OPEN 6 TABS";
    if (closed) label = "CLOSED";
    else if (stopped) label = stopConfirmed ? "STOPPED" : stopFailed ? "CHECK TABS" : "STOP REQUESTED";
    else if (snapshot.error || op?.status === "uncertain") label = "CHECK TABS";
    else if (op?.status === "pending" && ids.test(op.source) && ids.test(op.target)) label = `MOVING ${op.source} → ${op.target}`;
    else if (owners.length === 1 && ids.test(owners[0].nodeId)) label = `${auto ? "TOUR →" : "π IN"} TAB ${owners[0].nodeId}`;
    else if (snapshot.everStarted) label = "OWNER UNKNOWN";
    return { status: "controller", title: `CONTROL · ${label} — Weave`, href: icon("controller", "") };
  }
  if (snapshot.role !== "node" || typeof snapshot.nodeId !== "string" || !ids.test(snapshot.nodeId)) throw new Error("Tab indicator needs a compute tab numbered 1 through 6");
  const { state, ownership } = snapshot;
  let status = "error", label = "CHECK TAB";
  if (closed || state === "stopped") { status = "stopped"; label = "STOPPED"; }
  else if (state === "uncertain") { status = "uncertain"; label = "UNCONFIRMED"; }
  else if (ownership === "retired") { status = "retired"; label = "MOVED"; }
  else if (frozen && ownership === "retained") { status = "paused"; label = "PAUSED π"; }
  else if (state === "running" && ownership === "retained") { status = "running"; label = "RUNNING π"; }
  else if (state === "finalizing") { status = "handoff"; label = "HANDOFF π"; }
  else if (["connecting", "precopy"].includes(state) && ownership === "retained") { status = "sending"; label = "SENDING π"; }
  else if (state === "receiving") { status = "receiving"; label = "RECEIVING π"; }
  else if (state === "starting") { status = "starting"; label = "STARTING"; }
  else if (ownership === "unknown") { status = "uncertain"; label = "OWNER UNKNOWN"; }
  else if (state === "idle" && ownership === "none" && !snapshot.error) { status = "ready"; label = "READY"; }
  const warning = snapshot.error && status === "running" ? " · WARNING" : "";
  return { status, title: `${label} · Tab ${snapshot.nodeId}${warning} — Weave`, href: icon(status, snapshot.nodeId) };
}

export class TabIndicator {
  constructor(document) {
    this.document = document;
    this.link = document.querySelector("#tab-favicon");
    if (!this.link) throw new Error("The tab favicon element is missing");
    this.previous = null;
  }

  update(snapshot, options) {
    const appearance = tabAppearance(snapshot, options);
    if (this.previous?.title !== appearance.title) this.document.title = appearance.title;
    // Repeated progress events must not reload or animate the icon. Only real
    // status changes update its self-contained data URL; no network is used.
    if (this.previous?.href !== appearance.href) this.link.setAttribute("href", appearance.href);
    if (this.previous?.status !== appearance.status) this.link.dataset.status = appearance.status;
    this.previous = appearance;
    return appearance;
  }
}
