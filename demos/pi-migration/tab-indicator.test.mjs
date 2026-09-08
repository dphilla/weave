import test from "node:test";
import assert from "node:assert/strict";
import { TabIndicator, tabAppearance } from "./tab-indicator.mjs";

const node = (state = "idle", ownership = "none", nodeId = "1") => ({ role: "node", nodeId, state, ownership, error: null });

test("compute tab icons/titles distinguish every real ownership phase", () => {
  const cases = [
    ["idle", "none", "ready", "READY"],
    ["starting", "none", "starting", "STARTING"],
    ["running", "retained", "running", "RUNNING π"],
    ["connecting", "retained", "sending", "SENDING π"],
    ["precopy", "retained", "sending", "SENDING π"],
    ["receiving", "none", "receiving", "RECEIVING π"],
    ["finalizing", "unknown", "handoff", "HANDOFF π"],
    ["retired", "retired", "retired", "MOVED"],
    ["uncertain", "retired", "uncertain", "UNCONFIRMED"],
    ["running", "unknown", "uncertain", "OWNER UNKNOWN"],
    ["stopped", "none", "stopped", "STOPPED"],
    ["failed", "none", "error", "CHECK TAB"],
    ["duplicate", "none", "error", "CHECK TAB"],
  ];
  const icons = new Map();
  for (const [state, ownership, status, title] of cases) {
    const result = tabAppearance(node(state, ownership));
    assert.equal(result.status, status);
    assert.equal(result.title, `${title} · Tab 1 — Weave`);
    assert.ok(result.href.startsWith("data:image/svg+xml,"));
    const svg = decodeURIComponent(result.href.split(",")[1]);
    assert.match(svg, /<svg[^>]+viewBox="0 0 32 32"/);
    assert.doesNotMatch(svg, /<script|<animate|<image|href=|foreignObject/);
    icons.set(status, result.href);
  }
  assert.equal(new Set(icons.values()).size, icons.size, "each status has visually distinct SVG bytes");
  assert.match(decodeURIComponent(icons.get("running")), /#bdff32/);
});

test("tab identity is numbered and cannot inject SVG or title markup", () => {
  const icons = new Set();
  for (let n = 1; n <= 6; n++) {
    const result = tabAppearance(node("idle", "none", String(n)));
    assert.match(result.title, new RegExp(`Tab ${n} — Weave$`));
    assert.match(decodeURIComponent(result.href), new RegExp(`>${n}</text>`));
    icons.add(result.href);
  }
  assert.equal(icons.size, 6);
  for (const id of [null, "0", "7", "<script>", "1\"><image href='https://example.com'", "1\n"]) {
    assert.throws(() => tabAppearance(node("idle", "none", id)), /numbered 1 through 6/);
  }
});

test("retirement/uncertainty cannot accidentally show a stale running badge", () => {
  assert.equal(tabAppearance(node("running", "retired")).status, "retired");
  assert.equal(tabAppearance(node("running", "none")).status, "error");
  assert.equal(tabAppearance(node("uncertain", "retained")).status, "uncertain");
  const stillRunning = tabAppearance({ ...node("running", "retained"), error: "Another controller appeared" });
  assert.equal(stillRunning.status, "running", "a controller warning does not pretend a still-running owner stopped");
  assert.match(stillRunning.title, /^RUNNING π.*WARNING/);
});

test("hidden is not paused, actual freeze is paused, and closed pages cannot claim execution", () => {
  const current = node("running", "retained");
  assert.equal(tabAppearance(current, { hidden: true }).status, "running");
  assert.equal(tabAppearance(current, { frozen: true }).status, "paused");
  assert.match(tabAppearance(current, { frozen: true }).title, /^PAUSED π/);
  assert.equal(tabAppearance(current, { frozen: false }).status, "running");
  assert.equal(tabAppearance(current, { closed: true }).status, "stopped");
  assert.equal(tabAppearance(node("retired", "retired"), { frozen: true }).status, "retired");
});

test("dashboard tab remains a controller and describes confirmed or unknown ownership honestly", () => {
  const owner = { ...node("running", "retained", "3"), online: true };
  const dashboard = { role: "controller", nodes: [owner], everStarted: true };
  assert.match(tabAppearance(dashboard).title, /^CONTROL · π IN TAB 3/);
  assert.match(tabAppearance(dashboard, { auto: true }).title, /^CONTROL · TOUR → TAB 3/);
  assert.match(tabAppearance({ ...dashboard, operation: { status: "pending", source: "3", target: "4" } }).title, /^CONTROL · MOVING 3 → 4/);
  assert.match(tabAppearance({ ...dashboard, operation: { status: "uncertain" } }).title, /^CONTROL · CHECK TABS/);
  assert.match(tabAppearance({ ...dashboard, nodes: [{ ...owner, online: false }] }).title, /^CONTROL · OWNER UNKNOWN/);
  assert.match(tabAppearance(dashboard, { stopped: true }).title, /^CONTROL · STOP REQUESTED/);
  assert.match(tabAppearance(dashboard, { stopped: true, stopConfirmed: true }).title, /^CONTROL · STOPPED/);
  assert.match(tabAppearance(dashboard, { stopped: true, stopFailed: true }).title, /^CONTROL · CHECK TABS/);
  assert.match(tabAppearance(dashboard, { closed: true }).title, /^CONTROL · CLOSED/);
  assert.equal(tabAppearance(dashboard).status, "controller");
  assert.doesNotMatch(tabAppearance(dashboard).title, /RUNNING/);
  assert.notEqual(tabAppearance(dashboard).href, tabAppearance(owner).href);
});

test("favicon/title updates are synchronous and unchanged progress never rewrites the icon", () => {
  let title = "", titleWrites = 0, hrefWrites = 0;
  const link = { dataset: {}, setAttribute(key, value) { assert.equal(key, "href"); this.href = value; hrefWrites++; } };
  const document = {
    querySelector(selector) { assert.equal(selector, "#tab-favicon"); return link; },
    get title() { return title; },
    set title(value) { title = value; titleWrites++; },
  };
  const indicator = new TabIndicator(document);
  indicator.update(node());
  const ready = link.href;
  indicator.update(node("running", "retained"));
  assert.equal(link.dataset.status, "running");
  assert.match(document.title, /^RUNNING π/);
  assert.notEqual(link.href, ready);
  const running = link.href;
  for (let n = 0; n < 100; n++) indicator.update({ ...node("running", "retained"), progress: { terms: String(n) } });
  assert.equal(titleWrites, 2);
  assert.equal(hrefWrites, 2);
  indicator.update(node("running", "retired"));
  assert.equal(link.dataset.status, "retired");
  assert.match(document.title, /^MOVED/);
  assert.notEqual(link.href, running);
  assert.throws(() => new TabIndicator({ querySelector: () => null }), /favicon element is missing/);
});
