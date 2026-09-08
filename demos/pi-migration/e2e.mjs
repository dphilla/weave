#!/usr/bin/env node
// Dependency-free real-Chrome checks of the deployable, single-file artifact.
// Requires Node 22+ (its built-in WebSocket client speaks Chrome DevTools).
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CHROME = process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "/usr/bin/google-chrome";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => process.stdout.write(`${message}\n`);

function optionsFrom(argv) {
  const options = {
    chrome: process.env.CHROME_BIN ?? DEFAULT_CHROME,
    html: path.join(HERE, "dist/index.html"),
    artifacts: null,
    timeoutMs: 65_000,
    transport: "local",
    soakMs: 0,
    publicPath: "/index.html",
    literalIce: false,
    keepProfile: false,
    headed: false,
    quick: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help") {
      log(`usage: node demos/pi-migration/e2e.mjs [options]

  --html PATH          deployable HTML (default demos/pi-migration/dist/index.html)
  --chrome PATH        Chrome executable (or CHROME_BIN)
  --artifacts PATH     retain screenshots, browser state, and request logs
  --timeout-ms N       maximum wait per test phase (default 65000)
  --transport MODE     local (default) or webrtc; selects the public URL option
  --soak-ms N          keep all compute tabs hidden for N ms after the roundtrip
  --public-path PATH   static URL path, e.g. /showcase/pi-demo.html
  --literal-ice        expose literal ICE host candidates in disposable Chrome
  --headed             run visible Chrome instead of headless Chrome
  --quick              skip automatic-tour, suspended-target, and owner-loss cases
  --keep-profile       retain this test's temporary Chrome profile
  --help               print usage

The server serves only the one HTML file, with no signaling/STUN/TURN server.
The full-flow browser allows popups. A separate default-popup-policy browser
checks the one-at-a-time fallback. Background timer throttling is not disabled.`);
      return null;
    }
    if (["--literal-ice", "--keep-profile", "--headed", "--quick"].includes(flag)) {
      options[{ "--literal-ice": "literalIce", "--keep-profile": "keepProfile", "--headed": "headed", "--quick": "quick" }[flag]] = true;
      continue;
    }
    if (!["--chrome", "--html", "--artifacts", "--timeout-ms", "--transport", "--soak-ms", "--public-path"].includes(flag)) throw new Error(`unknown option ${flag}`);
    if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${flag} requires a value`);
    const value = argv[++i];
    if (flag === "--chrome") options.chrome = value;
    if (flag === "--html") options.html = path.resolve(value);
    if (flag === "--artifacts") options.artifacts = path.resolve(value);
    if (flag === "--timeout-ms") options.timeoutMs = Number(value);
    if (flag === "--transport") options.transport = value;
    if (flag === "--soak-ms") options.soakMs = Number(value);
    if (flag === "--public-path") options.publicPath = value;
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 300_000) {
    throw new Error("--timeout-ms must be an integer from 1000 to 300000");
  }
  if (!["local", "webrtc"].includes(options.transport)) throw new Error("--transport must be local or webrtc");
  if (!Number.isSafeInteger(options.soakMs) || options.soakMs < 0 || options.soakMs > 900_000) throw new Error("--soak-ms must be an integer from 0 to 900000");
  if (!/^\/[a-zA-Z0-9/_-]+\.html$/.test(options.publicPath)) throw new Error("--public-path must be an absolute URL path ending in .html");
  return options;
}

async function waitFor(description, predicate, timeoutMs, details = () => "") {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`timed out: ${description}${lastError ? ` (${lastError.message})` : ""}\n${details()}`);
}

function requestJson(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, timeout: 5_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (part) => { body += part; });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`${url}: HTTP ${response.statusCode} ${body}`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => request.destroy(new Error(`${url}: timeout`)));
    request.on("error", reject);
    request.end();
  });
}

class Cdp {
  constructor(target, resources) {
    this.target = target;
    this.resources = resources;
    this.id = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.requests = [];
    this.lifecycle = [];
    this.socket = new WebSocket(target.webSocketDebuggerUrl);
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP socket failed to open")), { once: true });
    });
    this.socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown") {
        this.exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      } else if (message.method === "Network.requestWillBeSent") {
        this.requests.push(message.params.request.url);
      } else if (message.method === "Runtime.consoleAPICalled" && message.params.args?.[0]?.value === "__weave_e2e_lifecycle__") {
        this.lifecycle.push({ event: message.params.args[1]?.value, timestamp: message.params.timestamp });
      }
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP socket closed"));
      }
      this.pending.clear();
    });
    resources.clients.push(this);
  }

  async command(method, params = {}) {
    await this.opened;
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("CDP socket is not open");
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timeout`));
      }, 15_000);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async evaluate(expression, userGesture = false) {
    const result = await this.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }

  async enable() {
    await Promise.all([this.command("Runtime.enable"), this.command("Page.enable"), this.command("Network.enable")]);
    // Requests completed before CDP attached still appear in Resource Timing.
    this.requests.push(...await this.evaluate("performance.getEntriesByType('resource').map(entry => entry.name)"));
    await this.evaluate(`for (const type of ['freeze','resume']) document.addEventListener(type, () => console.info('__weave_e2e_lifecycle__', type));`);
    await this.evaluate(`(() => {
      const observations = window.__PI_E2E_TAB_INDICATORS__ = [];
      const record = () => {
        const icon = document.querySelector('#tab-favicon');
        if (!icon) return;
        const state = window.__PI_DEMO__?.snapshot?.();
        const next = {timestamp:Date.now(), title:document.title, status:icon.dataset.status,
          href:icon.href, hidden:document.hidden, nodeState:state?.state, ownership:state?.ownership};
        const last = observations.at(-1);
        if (last && last.title === next.title && last.status === next.status && last.href === next.href) return;
        observations.push(next);
        if (observations.length > 512) observations.shift();
      };
      new MutationObserver(record).observe(document.head, {subtree:true,childList:true,characterData:true,
        attributes:true,attributeFilter:['href','data-status']});
      record();
    })()`);
    return this;
  }

  close() { try { this.socket.close(); } catch { /* already closed */ } }
}

async function snapshot(client) {
  return client.evaluate(`(() => {
    const state = window.__PI_DEMO__?.snapshot?.();
    if (!state) return null;
    return {...state, ...(state.runtime || {}),
      documentTitle: document.title,
      tabIndicator: (() => { const icon = document.querySelector('#tab-favicon');
        return icon ? {status:icon.dataset.status,href:icon.href,type:icon.type,sizes:icon.sizes.value} : null; })(),
      bodyText: document.body.innerText.slice(-24000),
      buttons: Object.fromEntries(['open-tabs','open-next','start-compute','migrate-next','auto-tour'].map(id => {
        const element = document.getElementById(id);
        return [id, element ? {disabled:element.disabled,hidden:element.hidden,text:element.textContent} : null];
      }))};
  })()`);
}

async function waitState(client, description, predicate, timeoutMs) {
  let last;
  return waitFor(description, async () => {
    last = await snapshot(client);
    return last && predicate(last) ? last : null;
  }, timeoutMs, () => JSON.stringify(last ? { ...last, peers: undefined, history: last.history?.slice(-8), events: last.events?.slice(-8), bodyText: last.bodyText?.slice(0, 2500) } : last, null, 2));
}

// Every production action is a DOM click. This never invokes runtime methods.
async function click(client, selector, count = 1, foreground = true) {
  if (foreground) await client.command("Page.bringToFront");
  // A real foreground switch paints queued requestAnimationFrame UI updates.
  // CDP can otherwise dispatch the click before that first visible frame.
  await sleep(120);
  await client.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center', behavior:'instant'})`);
  // Let Chrome's compositor settle the scroll before sending screen coordinates.
  await sleep(120);
  const point = await client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('missing button ' + ${JSON.stringify(selector)});
    if (element.disabled) throw new Error('disabled button ' + ${JSON.stringify(selector)});
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error('invisible button ' + ${JSON.stringify(selector)});
    const point = {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
    if (!element.contains(document.elementFromPoint(point.x,point.y))) throw new Error('button obscured: ' + ${JSON.stringify(selector)});
    window.__PI_E2E_LAST_CLICK__ = null;
    element.addEventListener('click', event => {
      window.__PI_E2E_LAST_CLICK__ = {selector:${JSON.stringify(selector)},trusted:event.isTrusted};
    }, {once:true});
    return point;
  })()`);
  await client.command("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await sleep(40);
  await client.command("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  const delivered = await client.evaluate("window.__PI_E2E_LAST_CLICK__");
  assert.deepEqual(delivered, { selector, trusted: true }, `Chrome did not deliver a trusted click to ${selector}`);
  if (count > 1) await client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    for (let i=1;i<${count};i++) element?.click();
  })()`, true);
}

async function screenshot(client, filename, width, height) {
  await client.command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await client.evaluate("window.scrollTo({top:0,left:0,behavior:'instant'})");
  await sleep(250);
  const overflow = await client.evaluate(`({width:innerWidth,scroll:document.documentElement.scrollWidth})`);
  assert.ok(overflow.scroll <= overflow.width + 1, `horizontal page overflow at ${width}px: ${JSON.stringify(overflow)}`);
  const layout = await client.command("Page.getLayoutMetrics");
  const content = layout.cssContentSize ?? layout.contentSize;
  const result = await client.command("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: content.width, height: Math.min(content.height, 12_000), scale: 1 },
  });
  await fs.promises.writeFile(filename, Buffer.from(result.data, "base64"));
}

async function startStaticServer(htmlPath, publicPath) {
  const html = await fs.promises.readFile(htmlPath);
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    requests.push({ method: request.method, path: url.pathname });
    // Deliberately no JS, CSS, WASM, signaling, or other asset routes.
    if (url.pathname === publicPath && ["GET", "HEAD"].includes(request.method)) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : html);
    } else {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Only the standalone HTML artifact is served.\n");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    requests,
    publicPath,
    htmlBytes: html.length,
    htmlSha256: createHash("sha256").update(html).digest("hex"),
    base: `http://127.0.0.1:${server.address().port}${publicPath}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

async function launchChrome(options, server, resources, { allowPopups, label }) {
  const profile = await fs.promises.mkdtemp(path.join(os.tmpdir(), `weave-pi-${label}-`));
  resources.profiles.push(profile);
  const args = [
    ...(options.headed ? [] : ["--headless=new"]),
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    ...(allowPopups ? ["--disable-popup-blocking"] : []),
    ...(options.literalIce ? ["--disable-features=WebRtcHideLocalIpsWithMdns", "--allow-loopback-in-peer-connection"] : []),
    `${server.base}#transport=${options.transport}`,
  ];
  const child = spawn(options.chrome, args, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  const browser = { child, label, profile, output: "", port: null, spawnError: null };
  resources.browsers.push(browser);
  child.on("error", (error) => { browser.spawnError = error; });
  const append = (data) => { browser.output += data; };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  browser.port = await waitFor(`${label} Chrome DevTools port`, async () => {
    if (browser.spawnError) throw browser.spawnError;
    if (child.exitCode !== null) throw new Error(`Chrome exited ${child.exitCode}`);
    const text = await fs.promises.readFile(path.join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
    return Number(text.split("\n")[0]) || null;
  }, options.timeoutMs, () => browser.output.slice(-3000));
  const target = await waitFor(`${label} dashboard`, async () => (await pages(browser)).find((page) => page.url.startsWith(server.base)), options.timeoutMs);
  browser.controller = await new Cdp(target, resources).enable();
  browser.version = await browser.controller.command("Browser.getVersion");
  resources.results.browsers ??= {};
  resources.results.browsers[label] = browser.version;
  const initialized = await waitState(browser.controller, `${label} initialized dashboard`, (state) => state.role === "controller", options.timeoutMs);
  assert.equal(initialized.transport, options.transport, "dashboard did not select the requested public transport option");
  return browser;
}

async function pages(browser) {
  return (await requestJson(`http://127.0.0.1:${browser.port}/json/list`)).filter((page) => page.type === "page");
}

function nodeNumber(page) {
  try {
    const hash = new URLSearchParams(new URL(page.url).hash.slice(1));
    return hash.get("role") === "node" ? hash.get("node") : null;
  } catch { return null; }
}

async function attachNodes(browser, resources, timeoutMs) {
  const targets = await waitFor("six compute tabs", async () => {
    const list = (await pages(browser)).filter((page) => nodeNumber(page));
    return new Set(list.map(nodeNumber)).size === 6 ? list : null;
  }, timeoutMs, () => "The demo must open node=1 through node=6 tabs.");
  const nodes = new Map();
  for (const target of targets) {
    const client = await new Cdp(target, resources).enable();
    const initialized = await waitState(client, `compute tab ${nodeNumber(target)} initialized`, (state) => state.role === "node", timeoutMs);
    assert.equal(initialized.transport, resources.results.transport, "compute tab did not inherit the controller transport selection");
    nodes.set(nodeNumber(target), client);
  }
  browser.nodes = nodes;
  return nodes;
}

function boundaries(state) {
  return (state.history ?? state.events ?? [])
    .map((event) => event.detail ? { ...event, ...event.detail } : event)
    .filter((event) => event.type === "boundary" || ["start", "resume", "final"].includes(event.kind));
}

function activeNodes(state) {
  return (state.nodes ?? []).filter((node) => node.state === "running" || node.ownership === "active");
}

function assertOneOwner(state) {
  const active = activeNodes(state);
  assert.ok(active.length <= 1, `multiple active compute tabs: ${JSON.stringify(active)}`);
  return active;
}

async function assertTabIndicators(browser, resources, stage, ownerId, timeoutMs, expected = {}) {
  let last = null;
  const result = await waitFor(`browser-tab indicators: ${stage}`, async () => {
    const browserPages = await pages(browser);
    const samples = [];
    for (const [id, client] of browser.nodes) {
      const page = browserPages.find((item) => item.id === client.target.id);
      if (!page) continue; // A deliberately closed owner no longer has a tab.
      const value = await client.evaluate(`(() => {
        const icon = document.querySelector('#tab-favicon');
        return {title:document.title,status:icon?.dataset.status,href:icon?.href,
          type:icon?.type,sizes:icon?.sizes.value,hidden:document.hidden};
      })()`);
      samples.push({ nodeId: id, browserTitle: page.title, ...value });
    }
    last = samples;
    const running = samples.filter((sample) => sample.status === "running");
    if (running.length !== (ownerId === null ? 0 : 1)) return null;
    if (ownerId !== null && running[0].nodeId !== String(ownerId)) return null;
    for (const sample of samples) {
      if (!new RegExp(`\\bTab ${sample.nodeId}(?:\\D|$)`).test(sample.title)) return null;
      if ((sample.status === "running") !== sample.title.startsWith("RUNNING π")) return null;
      if (sample.browserTitle !== sample.title) return null;
      const desired = expected[sample.nodeId] ?? expected.all;
      if (desired && sample.status !== desired) return null;
      if (!/^data:image\/svg\+xml(?:;[^,]*)?,/.test(sample.href ?? "")) return null;
      if (sample.type !== "image/svg+xml" || sample.sizes !== "any") return null;
      const split = sample.href.indexOf(",");
      const svg = sample.href.slice(0, split).endsWith(";base64")
        ? Buffer.from(sample.href.slice(split + 1), "base64").toString("utf8")
        : decodeURIComponent(sample.href.slice(split + 1));
      if (!svg.includes("<svg") || !svg.includes("</svg>")) return null;
      const prefix = { ready: "READY", running: "RUNNING π", retired: "MOVED", stopped: "STOPPED", paused: "PAUSED π" }[sample.status];
      if (prefix && !sample.title.startsWith(prefix)) return null;
    }
    const controller = await browser.controller.evaluate(`({title:document.title,status:document.querySelector('#tab-favicon')?.dataset.status})`);
    assert.ok(!controller.title.startsWith("RUNNING π"), "dashboard pretends to own the Wasm computation in its tab title");
    assert.notEqual(controller.status, "running", "dashboard incorrectly displays the running compute favicon");
    return { stage, ownerId, controller, nodes: samples };
  }, Math.min(timeoutMs, 5_000), () => JSON.stringify(last, null, 2));
  resources.results.tabIndicators ??= [];
  resources.results.tabIndicators.push(result);
  log(`ok: actual browser titles/SVG favicons identify ${ownerId === null ? "no running tab" : `only tab ${ownerId} as RUNNING π`} (${stage})`);
  return result;
}

async function assertIndicatorHistory(browser, resources) {
  const histories = [];
  for (const [id, client] of browser.nodes) {
    if (client.socket.readyState !== WebSocket.OPEN) continue;
    const history = await client.evaluate("window.__PI_E2E_TAB_INDICATORS__ ?? []");
    for (const event of history) {
      if (event.status !== "running") continue;
      assert.equal(event.nodeState, "running", `tab ${id} displayed a running icon while its runtime was ${event.nodeState}`);
      assert.equal(event.ownership, "retained", `tab ${id} displayed a running icon without retained execution authority`);
    }
    histories.push({ nodeId: id, events: history });
  }
  const statuses = new Set(histories.flatMap((item) => item.events.map((event) => event.status)));
  assert.ok(statuses.has("receiving"), "no background tab ever displayed its receiving indicator");
  assert.ok(statuses.has("sending") || statuses.has("handoff"), "no source ever displayed its transfer indicator");
  assert.ok(statuses.has("retired"), "no source ever displayed its retired indicator");
  resources.results.tabIndicatorHistory = histories;
  log("ok: background favicon mutation history follows real receive/transfer/retirement states, never false running ownership");
}

async function activeOwner(client, expected, timeoutMs) {
  return waitState(client, `node ${expected} has running computation`, (state) => {
    const active = assertOneOwner(state);
    if (String(state.operation?.target) === String(expected) && ["failed", "uncertain"].includes(state.operation?.status)) {
      assert.fail(`migration to ${expected} was not confirmed: ${JSON.stringify(state.operation)}`);
    }
    return active.length === 1 && String(active[0].nodeId) === String(expected)
      && BigInt(active[0].progress?.sequence ?? 0) > 0n
      && !state.busy;
  }, timeoutMs);
}

function assertHandoff(state, source, target, boundaryCount) {
  const recent = boundaries(state).slice(boundaryCount);
  const final = recent.find((event) => event.kind === "final" && String(event.nodeId) === String(source));
  const resume = recent.find((event) => event.kind === "resume" && String(event.nodeId) === String(target));
  assert.ok(final, `missing final host-call boundary from node ${source}: ${JSON.stringify(recent)}`);
  assert.ok(resume, `missing resumed host-call boundary from node ${target}: ${JSON.stringify(recent)}`);
  assert.equal(BigInt(resume.sequence), BigInt(final.sequence) + 1n, "handoff skipped or duplicated a host-call sequence number");
  assert.equal(BigInt(resume.terms), BigInt(final.terms) + 32768n, "handoff did not continue the exact WASM iteration position");
  log(`ok: real WASM node ${source} → ${target}: host sequence ${final.sequence} → ${resume.sequence}; terms ${final.terms} → ${resume.terms}`);
  return { source, target, final, resume };
}

async function assertNoExceptions(resources) {
  for (const client of resources.clients) {
    assert.deepEqual(client.exceptions, [], `unhandled exception in ${client.target.url}`);
    const external = client.requests.filter((url) => /^https?:/.test(url) && new URL(url).origin !== new URL(resources.server.base).origin);
    assert.deepEqual(external, [], "standalone demo made an external HTTP request");
  }
  const assets = resources.server.requests.filter((request) => ![resources.server.publicPath, "/favicon.ico"].includes(request.path));
  assert.deepEqual(assets, [], "standalone demo requested an additional deployable asset");
}

async function stopBrowser(browser) {
  const child = browser?.child;
  if (!child) return;
  const releasePipes = () => { child.stdout?.destroy(); child.stderr?.destroy(); };
  if (child.exitCode !== null || child.signalCode !== null) { releasePipes(); return; }
  const send = (signal) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* this exact disposable child already exited */ }
  };
  const exited = () => Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(2_000).then(() => false),
  ]);
  send("SIGTERM");
  if (!(await exited())) {
    send("SIGKILL");
    await exited();
  }
  // macOS launch helpers can retain inherited pipe handles after Chrome exits.
  // All browser output has already been collected; do not keep Node alive on
  // a detached helper's copy of this test's stdout/stderr pipe.
  releasePipes();
}

async function saveArtifacts(resources) {
  if (!resources.artifacts) return;
  await fs.promises.mkdir(resources.artifacts, { recursive: true });
  await fs.promises.writeFile(path.join(resources.artifacts, "http-requests.json"), JSON.stringify(resources.server?.requests ?? [], null, 2));
  await fs.promises.writeFile(path.join(resources.artifacts, "results.json"), JSON.stringify(resources.results, null, 2));
  for (const browser of resources.browsers) {
    await fs.promises.writeFile(path.join(resources.artifacts, `${browser.label}-chrome.log`), browser.output);
    if (browser.controller?.socket.readyState === WebSocket.OPEN) {
      await screenshot(browser.controller, path.join(resources.artifacts, `${browser.label}-final.png`), 1200, 1000).catch(() => {});
    }
    const clients = [["dashboard", browser.controller], ...[...(browser.nodes ?? [])].map(([id, client]) => [`node-${id}`, client])];
    for (const [label, client] of clients) {
      if (!client) continue;
      const state = await snapshot(client).catch((error) => ({ closed: true, error: error.message }));
      state.browserLifecycle = client.lifecycle;
      await fs.promises.writeFile(path.join(resources.artifacts, `${browser.label}-${label}.json`), JSON.stringify(state, null, 2));
    }
  }
}

async function cleanup(resources) {
  if (resources.cleanupPromise) return resources.cleanupPromise;
  resources.cleanupPromise = (async () => {
    await saveArtifacts(resources).catch((error) => process.stderr.write(`artifact warning: ${error.message}\n`));
    for (const client of resources.clients) client.close();
    await Promise.allSettled(resources.browsers.map(stopBrowser));
    await resources.server?.close().catch((error) => process.stderr.write(`server cleanup warning: ${error.message}\n`));
    if (!resources.keepProfile) {
      for (const profile of resources.profiles) await fs.promises.rm(profile, { recursive: true, force: true });
    } else log(`Disposable profiles retained: ${resources.profiles.join(", ")}`);
  })();
  return resources.cleanupPromise;
}

async function popupChecks(options, resources) {
  const browser = await launchChrome(options, resources.server, resources, { allowPopups: false, label: "popup-policy" });
  const controller = browser.controller;
  const fileTarget = await requestJson(`http://127.0.0.1:${browser.port}/json/new?${encodeURIComponent(pathToFileURL(options.html).href)}`, "PUT");
  const filePage = await new Cdp(fileTarget, resources).enable();
  const fileGuard = await waitFor("double-clicked file gives safe deployment guidance", async () => filePage.evaluate(`(() => {
    const warning = document.querySelector('#compatibility');
    const button = document.querySelector('#open-tabs');
    return warning && !warning.hidden && button?.disabled ? warning.textContent : null;
  })()`), options.timeoutMs);
  assert.match(fileGuard, /https?|localhost/i, "file URL guard does not explain how to serve the demo");
  await filePage.command("Page.close").catch(() => {});
  resources.results.fileUrlGuard = true;
  log("ok: directly opening the HTML as file:// blocks tab launch and explains HTTP(S)/localhost deployment");
  for (const transport of [options.transport === "local" ? "webrtc" : "local", options.transport]) {
    await controller.evaluate(`(() => {
      const select = document.querySelector('#transport-mode');
      if (!select || select.disabled) throw new Error('transport must be selectable before opening tabs');
      select.value = ${JSON.stringify(transport)};
      select.dispatchEvent(new Event('change', {bubbles:true}));
    })()`, true);
    await waitState(controller, `public transport selector switches to ${transport}`, (state) => state.transport === transport && state.initialized, options.timeoutMs);
  }
  const label = await controller.evaluate("document.querySelector('#transport-label').textContent");
  assert.match(label, options.transport === "local" ? /TAB STREAM/ : /WEBRTC/, "data-path label misrepresents the actual selected transport");
  log("ok: public transport selector reloads safely before any compute tabs are opened and labels the data path accurately");

  // Environment fault injection, not a runtime bypass: a policy denying all
  // popups makes window.open return null. Exercise it before any tabs exist.
  await controller.evaluate("window.__PI_E2E_OPEN__ = window.open; window.open = () => null");
  await click(controller, "#open-tabs");
  const blocked = await snapshot(controller);
  assert.match(blocked.bodyText, /block|one.at.a.time|allow.*pop.?up|open.*manually/i, "popup denial has no understandable fallback instructions");
  await controller.evaluate("window.open = window.__PI_E2E_OPEN__; delete window.__PI_E2E_OPEN__");
  log("ok: simulated all-popup denial exposes human-readable recovery instructions");
  await click(controller, "#open-tabs");
  await sleep(2_500);
  let count = (await pages(browser)).filter(nodeNumber).length;
  const openedWithOneGesture = count;
  assert.ok(count <= 6, `one launch opened ${count} compute tabs`);
  log(`info: default Chrome popup policy opened ${count}/6 tabs from one gesture`);
  for (let attempt = 0; count < 6 && attempt < 8; attempt++) {
    await click(controller, "#open-next");
    await sleep(1_200);
    const next = (await pages(browser)).filter(nodeNumber).length;
    assert.ok(next > count, "one-at-a-time popup fallback did not open a missing compute tab");
    count = next;
  }
  assert.equal(count, 6, "popup fallback did not produce all six compute tabs");
  await attachNodes(browser, resources, options.timeoutMs);
  const state = await waitState(controller, "popup fallback discovers all six compute tabs", (state) => (state.nodes ?? []).filter((node) => node.online).length === 6, options.timeoutMs);
  assert.equal(await controller.evaluate("document.querySelector('#transport-mode').disabled"), true, "transport selector allowed mixed modes after compute tabs opened");
  assert.equal(activeNodes(state).length, 0, "opening tabs unexpectedly started computation");
  resources.results.popupPolicy = { openedWithOneGesture, discoveredNodes: state.nodes.length };
  await assertTabIndicators(browser, resources, "popup room ready", null, options.timeoutMs, { all: "ready" });
  log("ok: default-policy popup launch/fallback discovers six tabs without starting work");

  await click(controller, "#start-compute");
  await activeOwner(controller, "1", options.timeoutMs);
  await assertTabIndicators(browser, resources, "popup room started", "1", options.timeoutMs);
  const boundaryCount = boundaries(await snapshot(controller)).length;
  await click(controller, '[data-migrate-to="2"]');
  await activeOwner(controller, "2", options.timeoutMs);
  await waitState(controller, "popup-room real migration boundary", (value) => boundaries(value).slice(boundaryCount).some((event) => event.kind === "resume"), options.timeoutMs);
  assertHandoff(await snapshot(controller), "1", "2", boundaryCount);
  await assertTabIndicators(browser, resources, "popup room handoff", "2", options.timeoutMs, { "1": "retired" });
  await controller.evaluate(`(() => {
    window.__PI_E2E_STOP_TITLES__ = [];
    new MutationObserver(() => {
      const state = window.__PI_DEMO__.snapshot();
      const previous = window.__PI_E2E_STOP_TITLES__.at(-1);
      if (previous?.title === document.title) return;
      window.__PI_E2E_STOP_TITLES__.push({title:document.title,busy:state.busy,
        states:state.nodes.map(node => node.state)});
    }).observe(document.querySelector('title'), {subtree:true,childList:true,characterData:true});
  })()`);
  await click(controller, "#stop-compute", 3);
  const stopped = await waitState(controller, "Stop demo stops every compute tab", (value) => value.stopped && !value.busy && value.nodes.length === 6 && value.nodes.every((node) => node.state === "stopped"), options.timeoutMs);
  assert.ok(stopped.buttons["start-compute"].disabled || stopped.buttons["start-compute"].hidden, "stopped room offered a new Start");
  const stopStartCount = boundaries(stopped).filter((event) => event.kind === "start").length;
  await controller.evaluate("document.querySelector('#start-compute').click()");
  const stoppedSequences = new Map();
  for (const [id, client] of browser.nodes) stoppedSequences.set(id, (await snapshot(client)).progress.sequence);
  await sleep(1_500);
  assert.equal(boundaries(await snapshot(controller)).filter((event) => event.kind === "start").length, stopStartCount, "even a synthetic click on hidden Start must not restart a stopped room");
  for (const [id, client] of browser.nodes) assert.equal((await snapshot(client)).progress.sequence, stoppedSequences.get(id), `stopped tab ${id} continued host calls`);
  resources.results.stopButton = { allSixStopped: true, noFurtherProgress: true, restartDisabled: true };
  const stopIndicators = await assertTabIndicators(browser, resources, "Stop demo", null, options.timeoutMs, { all: "stopped" });
  assert.match(stopIndicators.controller.title, /^CONTROL · STOPPED/, "dashboard did not show confirmed stop");
  const stopTitles = await controller.evaluate("window.__PI_E2E_STOP_TITLES__");
  assert.ok(stopTitles.some(event => event.title.startsWith("CONTROL · STOP REQUESTED")), "dashboard did not distinguish the stop request from confirmation");
  for (const event of stopTitles.filter(event => event.title.startsWith("CONTROL · STOPPED"))) {
    assert.equal(event.busy, false, "dashboard claimed STOPPED before completing stop acknowledgements");
    assert.ok(event.states.every(state => state === "stopped"), "dashboard claimed STOPPED while a compute tab was not stopped");
  }
  resources.results.stopButton.controllerTitles = stopTitles;
  log("ok: Start → real handoff → Stop demo stops all six tabs, freezes every progress counter and prohibits restart");
  await stopBrowser(browser);
}

async function fullFlow(options, resources) {
  const browser = await launchChrome(options, resources.server, resources, { allowPopups: true, label: "six-tab" });
  const dashboard = browser.controller;
  await click(dashboard, "#open-tabs", 3);
  const nodes = await attachNodes(browser, resources, options.timeoutMs);
  await waitState(dashboard, "all six nodes online", (state) => (state.nodes ?? []).filter((node) => node.online).length === 6, options.timeoutMs);
  const readyIndicators = await assertTabIndicators(browser, resources, "six ready tabs", null, options.timeoutMs, { all: "ready" });
  assert.equal((await pages(browser)).filter(nodeNumber).length, 6, "repeated Open buttons created duplicate tabs");
  log("ok: rapid repeated Open creates exactly six compute tabs");

  await click(dashboard, "#start-compute", 5);
  let state = await activeOwner(dashboard, "1", options.timeoutMs);
  let previousIndicators = await assertTabIndicators(browser, resources, "Start", "1", options.timeoutMs);
  assert.ok(previousIndicators.nodes.every((node) => node.hidden), "Start indicator test accidentally focused a compute tab");
  assert.notEqual(previousIndicators.nodes.find((node) => node.nodeId === "1").href, readyIndicators.nodes.find((node) => node.nodeId === "1").href, "Start did not change the actual favicon image");
  const starts = boundaries(state).filter((event) => event.kind === "start");
  assert.equal(starts.length, 1, "repeated Start created multiple new workloads");
  const nodeOne = await snapshot(nodes.get("1"));
  assert.ok(Number.isFinite(nodeOne.progress.estimate), "actual WASM did not report a finite Pi estimate");
  assert.ok(Math.abs(nodeOne.progress.estimate - Math.PI) < 0.001, `unexpected Pi approximation ${nodeOne.progress.estimate}`);
  log(`ok: repeated Start creates one actual WASM computation; π≈${nodeOne.progress.estimate}`);
  resources.results.handoffs = [];

  if (options.transport === "local") {
    // The HTML has loaded in every tab. Remove the browser network from every
    // inspected page before migrating, not merely rely on a request counter.
    for (const client of [dashboard, ...nodes.values()]) {
      await client.command("Network.emulateNetworkConditions", {
        offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      });
      assert.equal(await client.evaluate("navigator.onLine"), false, "browser did not enter offline mode");
    }
    resources.results.migrationsWhileBrowserOffline = true;
    log("ok: all seven loaded pages are now browser-offline; local migrations must work without network access");
  }

  let source = "1";
  for (const target of ["2", "3", "4", "5", "6", "1"]) {
    state = await snapshot(dashboard);
    const count = boundaries(state).length;
    await click(dashboard, `[data-migrate-to="${target}"]`, 5);
    state = await activeOwner(dashboard, target, options.timeoutMs);
    const nextIndicators = await assertTabIndicators(browser, resources, `handoff ${source} → ${target}`, target, options.timeoutMs, { [source]: "retired" });
    assert.ok(nextIndicators.nodes.every((node) => node.hidden), "handoff indicator test accidentally focused a compute tab");
    for (const id of [source, target]) {
      assert.notEqual(nextIndicators.nodes.find((node) => node.nodeId === id).href, previousIndicators.nodes.find((node) => node.nodeId === id).href, `handoff did not change tab ${id}'s actual favicon image`);
    }
    previousIndicators = nextIndicators;
    // Both the final source and first resumed target events may reach the
    // dashboard slightly after its first status update.
    state = await waitState(dashboard, `handoff boundaries ${source} → ${target}`, (value) => {
      const recent = boundaries(value).slice(count);
      return recent.some((event) => event.kind === "final" && String(event.nodeId) === source)
        && recent.some((event) => event.kind === "resume" && String(event.nodeId) === target);
    }, options.timeoutMs);
    const handoff = assertHandoff(state, source, target, count);
    resources.results.handoffs.push(handoff);
    const before = await snapshot(nodes.get(source));
    assert.equal(before.progress.sequence, handoff.final.sequence, `source ${source} executed another host call after its final snapshot`);
    const sourceSequence = before.progress.sequence;
    await sleep(1_200);
    const after = await snapshot(nodes.get(source));
    assert.equal(after.progress.sequence, sourceSequence, `retired source ${source} kept calling the host after transfer`);
    assert.notEqual(after.state, "running", `source ${source} stayed running after migration`);
    assertOneOwner(await snapshot(dashboard));
    source = target;
  }
  log("ok: six exact handoffs preserve one computation and every retired source stops reporting work");

  const retired = new Map();
  for (const id of ["2", "3", "4", "5", "6"]) retired.set(id, (await snapshot(nodes.get(id))).progress.sequence);
  const retirementDeadline = Date.now() + 13_000;
  while (Date.now() < retirementDeadline) {
    for (const [id, sequence] of retired) {
      const value = await snapshot(nodes.get(id));
      assert.equal(value.state, "retired", `retired tab ${id} changed state after its transport deadline`);
      assert.equal(value.ownership, "retired", `retired tab ${id} regained execution authority`);
      assert.equal(value.progress.sequence, sequence, `retired tab ${id} emitted another host call`);
    }
    assertOneOwner(await snapshot(dashboard));
    await sleep(500);
  }
  log("ok: all five retired tabs stay retired past the 12-second connection deadline");

  if (resources.artifacts) {
    await screenshot(dashboard, path.join(resources.artifacts, "dashboard-desktop.png"), 1440, 1000);
    await screenshot(dashboard, path.join(resources.artifacts, "dashboard-mobile.png"), 390, 844);
    await screenshot(nodes.get("1"), path.join(resources.artifacts, "compute-tab.png"), 1100, 850);
    await dashboard.command("Emulation.clearDeviceMetricsOverride");
    log("ok: desktop/mobile dashboard has no horizontal overflow; screenshots captured");
  }

  const repoLinks = await dashboard.evaluate("[...document.querySelectorAll('a[href^=\"https://github.com/\"]')].map(link => ({href:link.href,rel:link.rel}))");
  assert.ok(repoLinks.length >= 2, "the demo is missing its repository call to action");
  assert.ok(repoLinks.every((link) => link.href === "https://github.com/dphilla/weave" && link.rel.includes("noopener")), "repository CTA has the wrong target or unsafe new-tab behavior");
  await click(dashboard, "#show-license");
  assert.equal(await dashboard.evaluate("document.querySelector('#license-dialog').open"), true, "license notice did not open");
  assert.match(await dashboard.evaluate("document.querySelector('#license-text').textContent"), /Apache License\s+Version 2\.0/, "single-file distribution is missing its license");
  await click(dashboard, "#license-dialog button");
  const downloadDirectory = path.join(resources.artifacts ?? browser.profile, "downloads");
  await fs.promises.mkdir(downloadDirectory, { recursive: true });
  await dashboard.command("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDirectory });
  await click(dashboard, "#download-log");
  const downloaded = await waitFor("user-downloadable JSON session log", async () => {
    const filename = (await fs.promises.readdir(downloadDirectory)).find((name) => name.endsWith(".json"));
    if (!filename) return null;
    return JSON.parse(await fs.promises.readFile(path.join(downloadDirectory, filename), "utf8"));
  }, options.timeoutMs);
  assert.ok(downloaded && typeof downloaded === "object", "downloaded session log is not a JSON object");
  resources.results.sessionLogDownloaded = true;
  log("ok: repository CTA, embedded Apache notice, and real JSON session-log download work");

  if (options.soakMs) {
    await dashboard.command("Page.bringToFront");
    for (const [id, client] of nodes) assert.equal(await client.evaluate("document.hidden"), true, `compute tab ${id} is not actually backgrounded for the soak`);
    const started = Date.now();
    let lastReport = started;
    let lastProgressAt = started;
    let lastTerms = BigInt((await snapshot(dashboard)).terms);
    log(`info: beginning ${options.soakMs}ms background-tab soak; compute tabs will not be evaluated or focused during it`);
    while (Date.now() - started < options.soakMs) {
      await sleep(1_000);
      const value = await snapshot(dashboard);
      assertOneOwner(value);
      assert.equal((value.nodes ?? []).filter((node) => node.online).length, 6, "background browser throttling made a compute tab appear offline");
      const terms = BigInt(value.terms);
      assert.ok(terms >= lastTerms, "background computation progress moved backwards");
      if (terms > lastTerms) { lastTerms = terms; lastProgressAt = Date.now(); }
      assert.ok(Date.now() - lastProgressAt < 20_000, "background computation stopped making observable progress for 20 seconds");
      if (Date.now() - lastReport >= 30_000) {
        lastReport = Date.now();
        log(`info: background soak ${Math.round((Date.now() - started) / 1000)}s, ${terms} terms, all six nodes online`);
      }
    }
    resources.results.backgroundSoakMs = Date.now() - started;
    log("ok: long background-tab soak preserved progress, ownership and all six heartbeats");
    const afterSoakBoundaryCount = boundaries(await snapshot(dashboard)).length;
    await click(dashboard, '[data-migrate-to="2"]');
    await activeOwner(dashboard, "2", options.timeoutMs);
    await waitState(dashboard, "post-soak migration resumes without focusing either compute tab", (value) => boundaries(value).slice(afterSoakBoundaryCount).some((event) => event.kind === "resume"), options.timeoutMs);
    resources.results.handoffs.push({ ...assertHandoff(await snapshot(dashboard), "1", "2", afterSoakBoundaryCount), afterBackgroundSoak: true });
    log("ok: hidden owner migrates after the long soak without being focused or evaluated first");
    await assertTabIndicators(browser, resources, "post-soak handoff", "2", options.timeoutMs, { "1": "retired" });
  }

  if (!options.quick) {
    const completedBefore = boundaries(await snapshot(dashboard)).filter((event) => event.kind === "resume").length;
    await click(dashboard, "#auto-tour");
    state = await waitState(dashboard, "automatic tour performs at least two real migrations", (state) => {
      assertOneOwner(state);
      return boundaries(state).filter((event) => event.kind === "resume").length >= completedBefore + 2;
    }, options.timeoutMs * 2);
    await click(dashboard, "#auto-tour");
    await waitState(dashboard, "automatic tour stops", (state) => !state.auto && !state.busy, options.timeoutMs);
    await assertTabIndicators(browser, resources, "auto tour paused", String(assertOneOwner(await snapshot(dashboard))[0].nodeId), options.timeoutMs);
    resources.results.autoTourHandoffs = boundaries(state).filter((event) => event.kind === "resume").length - completedBefore;
    log("ok: automatic tour performs real migrations and can be stopped through its button");

    // A real browser freeze pauses timer-driven guest execution. Chrome still
    // dispatches BroadcastChannel messages in this state, so a local handoff
    // may commit; WebRTC preparation can instead time out. Verify ownership
    // and recovery for the actual outcome, never demand an invented failure.
    state = await snapshot(dashboard);
    const sourceId = String(assertOneOwner(state)[0].nodeId);
    const frozenTargetId = String(Number(sourceId) % 6 + 1);
    const frozenTarget = nodes.get(frozenTargetId);
    const beforeFreeze = boundaries(state).length;
    const beforeTerms = BigInt((await snapshot(nodes.get(sourceId))).progress.terms);
    await dashboard.command("Page.bringToFront");
    await sleep(120);
    const lifecycleCount = frozenTarget.lifecycle.length;
    await frozenTarget.command("Page.setWebLifecycleState", { state: "frozen" });
    await waitFor("actual destination freeze lifecycle event", () => frozenTarget.lifecycle.slice(lifecycleCount).some((event) => event.event === "freeze"), 5_000);
    let committedWhileFrozen = false;
    let frozenSequence = null;
    try {
      await click(dashboard, `[data-migrate-to="${frozenTargetId}"]`, 3, false);
      await waitState(dashboard, "suspended target reaches a bounded, explicit migration result", (value) => {
        assert.ok(!frozenTarget.lifecycle.slice(lifecycleCount).some((event) => event.event === "resume"), "Chrome resumed the destination automatically; the frozen-target fault injection is no longer valid");
        assertOneOwner(value);
        return !value.busy && ["uncertain", "failed", "succeeded"].includes(value.operation?.status);
      }, options.timeoutMs);
      state = await snapshot(dashboard);
      const source = await snapshot(nodes.get(sourceId));
      committedWhileFrozen = state.operation.status === "succeeded";
      assert.ok(state.buttons["start-compute"].disabled || state.buttons["start-compute"].hidden, "a suspended destination enabled duplicate Start");
      if (committedWhileFrozen) {
        assert.equal(source.ownership, "retired", "confirmed handoff did not retire its source");
        await waitState(dashboard, "committed frozen destination reports its exact resume boundary", (value) => boundaries(value).slice(beforeFreeze).some((event) => event.kind === "resume"), options.timeoutMs);
        state = await snapshot(dashboard);
        resources.results.handoffs.push({ ...assertHandoff(state, sourceId, frozenTargetId, beforeFreeze), committedWhileFrozen: true });
        // The first resumed host-call observation precedes the rest of that
        // initial synchronous Wasm slice. A later heartbeat publishes the
        // complete slice even though its following timer is frozen.
        await sleep(3_000);
        state = await snapshot(dashboard);
        frozenSequence = state.nodes.find((node) => node.nodeId === frozenTargetId).progress.sequence;
        await sleep(3_000);
        state = await snapshot(dashboard);
        assert.equal(state.nodes.find((node) => node.nodeId === frozenTargetId).progress.sequence, frozenSequence, "destination freeze did not actually pause timer-driven Wasm execution");
        resources.results.suspendedTarget = { state: "committed_while_frozen", sourceRetired: true, guestPaused: true };
        await assertTabIndicators(browser, resources, "frozen owner visibly paused", null, options.timeoutMs, { [sourceId]: "retired", [frozenTargetId]: "paused" });
        log("ok: frozen tab receives local handoff via message tasks; source retires, target is sole owner, guest execution remains paused");
      } else {
        assert.equal(boundaries(state).slice(beforeFreeze).filter((event) => event.kind === "resume").length, 0, "failed destination preparation unexpectedly resumed computation");
        assert.equal(source.state, "running", "source did not remain running while target was suspended before negotiation");
        assert.equal(source.ownership, "retained", "suspended target changed source execution authority before negotiation");
        assert.ok(BigInt(source.progress.terms) > beforeTerms, "source did not continue computing during target timeout");
        resources.results.suspendedTarget = { state: state.operation.status, sourceContinues: true };
        await assertTabIndicators(browser, resources, "failed preparation retains source indicator", sourceId, options.timeoutMs);
        log(`ok: browser-suspended destination reports ${state.operation.status}; original source keeps computing, no duplicate Start`);
      }
    } finally {
      await frozenTarget.command("Page.setWebLifecycleState", { state: "active" });
    }
    let retrySourceId = sourceId;
    let retryTargetId = frozenTargetId;
    if (committedWhileFrozen) {
      await waitState(dashboard, "thaw resumes the committed guest without a new Start", (value) => BigInt(value.nodes.find((node) => node.nodeId === frozenTargetId)?.progress.sequence ?? 0) > BigInt(frozenSequence), options.timeoutMs);
      retrySourceId = frozenTargetId;
      retryTargetId = String(Number(frozenTargetId) % 6 + 1);
      resources.results.suspendedTarget.progressResumedOnThaw = true;
      await assertTabIndicators(browser, resources, "thawed owner resumes its running indicator", frozenTargetId, options.timeoutMs);
    } else {
      // A prepare command queued while frozen can arrive after its caller
      // timed out. Wait for that delayed reservation's 12-second cleanup.
      await sleep(13_500);
      await waitState(dashboard, "unfrozen destination cleans up its expired receive reservation", (value) => {
        const target = (value.nodes ?? []).find((node) => node.nodeId === frozenTargetId);
        return target?.online && ["idle", "retired"].includes(target.state);
      }, options.timeoutMs);
      assert.equal((await snapshot(dashboard)).operation.status, "failed", "unanswered destination preparation incorrectly claims source ownership is uncertain when no source migration command was sent");
    }
    state = await snapshot(dashboard);
    const retryBoundaryCount = boundaries(state).length;
    await click(dashboard, `[data-migrate-to="${retryTargetId}"]`);
    state = await activeOwner(dashboard, retryTargetId, options.timeoutMs);
    await waitState(dashboard, "post-suspension retry emits its resumed host-call boundary", (value) => boundaries(value).slice(retryBoundaryCount).some((event) => event.kind === "resume"), options.timeoutMs);
    state = await snapshot(dashboard);
    resources.results.handoffs.push({ ...assertHandoff(state, retrySourceId, retryTargetId, retryBoundaryCount), afterSuspension: true });
    await assertTabIndicators(browser, resources, "post-suspension handoff", retryTargetId, options.timeoutMs, { [retrySourceId]: "retired" });
    log("ok: explicit movement after destination recovers preserves the existing computation");

    state = await snapshot(dashboard);
    const owner = assertOneOwner(state)[0];
    assert.ok(owner, "expected an active owner before tab-loss test");
    const startCount = boundaries(state).filter((event) => event.kind === "start").length;
    const ownerId = String(owner.nodeId);
    await assertIndicatorHistory(browser, resources);
    await nodes.get(ownerId).command("Page.close").catch(() => {});
    state = await waitState(dashboard, "closed owner is reported unavailable", (state) => {
      const node = (state.nodes ?? []).find((item) => String(item.nodeId) === ownerId);
      return node && (!node.online || /lost|unknown|unavailable|offline/i.test(node.state));
    }, options.timeoutMs);
    await sleep(3_000);
    state = await snapshot(dashboard);
    assert.equal(boundaries(state).filter((event) => event.kind === "start").length, startCount, "owner loss silently restarted the workload");
    const otherActive = activeNodes(state).filter((node) => String(node.nodeId) !== ownerId);
    assert.deepEqual(otherActive, [], "owner loss started another executor without a handoff");
    assert.ok(state.buttons["start-compute"].disabled, "owner loss enabled a fresh Start in the existing workload session");
    resources.results.closedOwner = ownerId;
    await assertTabIndicators(browser, resources, "owner tab closed", null, options.timeoutMs);
    log("ok: closing the active tab reports its loss and never silently starts a replacement computation");
  }
  await assertNoExceptions(resources);
  log("ok: no uncaught page exceptions, external HTTP requests, or additional deployable assets");
}

let activeResources;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!activeResources) return;
    cleanup(activeResources).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  if (!options) return;
  await fs.promises.access(options.chrome, fs.constants.X_OK);
  await fs.promises.access(options.html, fs.constants.R_OK);
  const resources = activeResources = {
    clients: [], browsers: [], profiles: [], server: null,
    artifacts: options.artifacts,
    keepProfile: options.keepProfile,
    results: { html: options.html, publicPath: options.publicPath, transport: options.transport, literalIce: options.literalIce, headed: options.headed, backgroundTimerThrottlingDisabled: false, requestedSoakMs: options.soakMs },
  };
  if (resources.artifacts) await fs.promises.mkdir(resources.artifacts, { recursive: true });
  try {
    resources.server = await startStaticServer(options.html, options.publicPath);
    resources.results.htmlSha256 = resources.server.htmlSha256;
    resources.results.htmlBytes = resources.server.htmlBytes;
    log(`Serving only ${options.html} at ${resources.server.base}`);
    await popupChecks(options, resources);
    await fullFlow(options, resources);
    resources.results.passed = true;
    log("PASS: standalone six-tab WASM live-migration demo");
  } catch (error) {
    resources.results.passed = false;
    resources.results.failure = error.stack ?? String(error);
    throw error;
  } finally {
    await cleanup(resources);
    activeResources = null;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
