#!/usr/bin/env node
// Dependency-free WebSocket <-> TCP relay for the browser/WAMR demo.
//
// Outbound: browser opens /v1/connect/:target, where target is a configured
// alias, and the relay dials that TCP Weave node.
// Inbound: browser opens /v1/accept and is paired FIFO with the next peer that
// connects to the dedicated TCP ingress listener.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WEAVE_WEBSOCKET_PROTOCOL = "weave.v2";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024 + 5;
const DEMO_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DEMO_DIR, "../..");

function usage() {
  return `usage: node demos/browser-wamr/relay.mjs [options]

  --http HOST:PORT          demo HTTP/WebSocket listener (default 127.0.0.1:8787)
  --ingress HOST:PORT       TCP address WAMR dials for browser targets (default 127.0.0.1:7778)
  --target NAME=HOST:PORT   allowlisted browser-source target (repeatable; default wamr=127.0.0.1:7777)
  --allow-origin ORIGIN     permitted browser Origin (repeatable; default same host)
  --token SECRET            require ?token=SECRET for WebSocket routes
  --pair-timeout-ms N       pending inbound pair lifetime (default 120000)
  --connect-timeout-ms N    outbound TCP dial timeout (default 10000)
  --help                    show this message`;
}

export function parseAddress(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("empty address");
  let host;
  let portText;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0 || value[end + 1] !== ":") throw new Error(`bad address: ${value}`);
    host = value.slice(1, end);
    portText = value.slice(end + 2);
  } else {
    const colon = value.lastIndexOf(":");
    if (colon <= 0) throw new Error(`bad address: ${value}`);
    host = value.slice(0, colon);
    portText = value.slice(colon + 1);
  }
  const port = Number(portText);
  if (!host || !Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`bad address: ${value}`);
  }
  return { host, port };
}

function displayAddress(address) {
  const host = address.host.includes(":") ? `[${address.host}]` : address.host;
  return `${host}:${address.port}`;
}

function isLoopback(host) {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" || normalized.startsWith("127.");
}

export function parseArgs(argv) {
  const config = {
    http: parseAddress("127.0.0.1:8787"),
    ingress: parseAddress("127.0.0.1:7778"),
    targets: new Map([["wamr", parseAddress("127.0.0.1:7777")]]),
    origins: [],
    token: null,
    pairTimeoutMs: 120_000,
    connectTimeoutMs: 10_000,
    maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
  };

  const next = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} requires a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--http": config.http = parseAddress(next(i, argv[i++])); break;
      case "--ingress": config.ingress = parseAddress(next(i, argv[i++])); break;
      case "--target": {
        const value = next(i, argv[i++]);
        const equal = value.indexOf("=");
        if (equal <= 0) throw new Error(`bad target (expected NAME=HOST:PORT): ${value}`);
        const name = value.slice(0, equal);
        if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error(`bad target name: ${name}`);
        config.targets.set(name, parseAddress(value.slice(equal + 1)));
        break;
      }
      case "--allow-origin": config.origins.push(next(i, argv[i++])); break;
      case "--token": config.token = next(i, argv[i++]); break;
      case "--pair-timeout-ms": config.pairTimeoutMs = Number(next(i, argv[i++])); break;
      case "--connect-timeout-ms": config.connectTimeoutMs = Number(next(i, argv[i++])); break;
      case "--help": config.help = true; break;
      default: throw new Error(`unknown option: ${argv[i]}`);
    }
  }
  for (const name of ["pairTimeoutMs", "connectTimeoutMs"]) {
    if (!Number.isFinite(config[name]) || config[name] <= 0) {
      throw new Error(`${name} must be a positive number`);
    }
  }
  if (!config.token && !isLoopback(config.http.host)) {
    throw new Error("--token is required when --http is not bound to loopback");
  }
  return config;
}

function secureEqual(actual, expected) {
  const a = Buffer.from(actual ?? "");
  const b = Buffer.from(expected ?? "");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function originAllowed(req, configured, listener) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (configured.includes("*")) return true;
  if (configured.length > 0) return configured.includes(origin);
  try {
    const parsed = new URL(origin);
    const expected = new URL(`http://${displayAddress(listener)}`);
    return parsed.protocol === expected.protocol && parsed.host === expected.host;
  } catch {
    return false;
  }
}

function headerHasToken(value, wanted) {
  return String(value ?? "")
    .split(",")
    .some((part) => part.trim().toLowerCase() === wanted);
}

function rejectUpgrade(socket, status, message) {
  if (socket.destroyed) return;
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status}\r\n` +
    "Connection: close\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "\r\n" + body,
  );
}

function validateUpgrade(req) {
  if (req.method !== "GET") return "WebSocket upgrade requires GET";
  if (!headerHasToken(req.headers.upgrade, "websocket")) return "missing Upgrade: websocket";
  if (!headerHasToken(req.headers.connection, "upgrade")) return "missing Connection: Upgrade";
  if (req.headers["sec-websocket-version"] !== "13") return "WebSocket version 13 required";
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") return "missing Sec-WebSocket-Key";
  let decoded;
  try { decoded = Buffer.from(key, "base64"); } catch { return "bad Sec-WebSocket-Key"; }
  if (decoded.length !== 16) return "bad Sec-WebSocket-Key";
  if (!headerHasToken(req.headers["sec-websocket-protocol"], WEAVE_WEBSOCKET_PROTOCOL)) {
    return `subprotocol ${WEAVE_WEBSOCKET_PROTOCOL} required`;
  }
  return null;
}

function websocketAccept(key) {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (bytes.length < 126) {
    header = Buffer.from([0x80 | opcode, bytes.length]);
  } else if (bytes.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(bytes.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(bytes.length), 2);
  }
  return Buffer.concat([header, bytes]);
}

/** Minimal strict RFC 6455 server connection, intentionally binary-only. */
export class ServerWebSocket extends EventEmitter {
  constructor(socket, head = Buffer.alloc(0), options = {}) {
    super();
    // EventEmitter treats an unobserved `error` as fatal. Pending browser
    // targets do not have a bridge listener yet, so retain a no-op observer.
    this.on("error", () => {});
    this.socket = socket;
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.buffer = Buffer.alloc(0);
    this.fragmented = false;
    this.fragmentBytes = 0;
    this.paused = false;
    this.closed = false;
    this.onBinary = null;

    socket.on("data", (chunk) => this._ingest(chunk));
    socket.on("end", () => this._finish(1006, "WebSocket transport ended"));
    socket.on("close", () => this._finish(1006, "WebSocket transport closed"));
    socket.on("error", (error) => {
      this.emit("error", error);
      this._finish(1011, error.message);
    });
    if (head.length > 0) queueMicrotask(() => this._ingest(head));
  }

  _ingest(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxMessageBytes + 14) {
      this.close(1009, "WebSocket message too large");
      return;
    }
    this._parse();
  }

  _parse() {
    while (!this.closed && !this.paused) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const isControl = opcode >= 0x8;
      if ((first & 0x70) !== 0) return this.close(1002, "RSV bits are unsupported");
      if ((second & 0x80) === 0) return this.close(1002, "client frames must be masked");

      let length = second & 0x7f;
      let headerLength = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        headerLength = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const wide = this.buffer.readBigUInt64BE(2);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return this.close(1009, "frame too large");
        length = Number(wide);
        headerLength = 10;
      }
      if (isControl && (!fin || length > 125)) {
        return this.close(1002, "invalid control frame");
      }
      if (!isControl && length > this.maxMessageBytes) {
        return this.close(1009, "WebSocket message too large");
      }
      const total = headerLength + 4 + length;
      if (this.buffer.length < total) return;
      const mask = this.buffer.subarray(headerLength, headerLength + 4);
      const payload = Buffer.from(this.buffer.subarray(headerLength + 4, total));
      this.buffer = this.buffer.subarray(total);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      if (!this._frame(opcode, fin, payload)) return;
    }
  }

  _frame(opcode, fin, payload) {
    switch (opcode) {
      case 0x0:
        if (!this.fragmented) return this.close(1002, "unexpected continuation frame");
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > this.maxMessageBytes) {
          return this.close(1009, "WebSocket message too large");
        }
        if (fin) {
          this.fragmented = false;
          this.fragmentBytes = 0;
        }
        return this._binary(payload);
      case 0x1:
        return this.close(1003, "binary messages required");
      case 0x2:
        if (this.fragmented) return this.close(1002, "interleaved data frame");
        if (!fin) {
          this.fragmented = true;
          this.fragmentBytes = payload.length;
        }
        return this._binary(payload);
      case 0x8:
        if (payload.length === 1) return this.close(1002, "invalid close frame");
        if (!this.closed) {
          this.socket.end(encodeFrame(0x8, payload));
          this._finish(1000, "peer closed");
        }
        return false;
      case 0x9:
        this.socket.write(encodeFrame(0xA, payload));
        return true;
      case 0xA:
        return true;
      default:
        return this.close(1002, "unknown WebSocket opcode");
    }
  }

  _binary(payload) {
    if (!this.onBinary) {
      this.close(1008, "relay endpoint is not ready");
      return false;
    }
    const keepReading = this.onBinary(payload) !== false;
    if (!keepReading) {
      this.paused = true;
      this.socket.pause();
    }
    return keepReading;
  }

  resume() {
    if (this.closed || !this.paused) return;
    this.paused = false;
    this.socket.resume();
    this._parse();
  }

  sendBinary(payload) {
    if (this.closed) return false;
    return this.socket.write(encodeFrame(0x2, payload));
  }

  close(code = 1000, reason = "") {
    if (this.closed) return false;
    const reasonBytes = Buffer.from(reason).subarray(0, 123);
    const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.socket.end(encodeFrame(0x8, payload));
    this._finish(code, reasonBytes.toString());
    return false;
  }

  _finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", { code, reason });
  }
}

function acceptWebSocket(req, socket, head, options) {
  const response = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${websocketAccept(req.headers["sec-websocket-key"])}`,
    `Sec-WebSocket-Protocol: ${WEAVE_WEBSOCKET_PROTOCOL}`,
    "\r\n",
  ].join("\r\n");
  socket.write(response);
  socket.setNoDelay(true);
  return new ServerWebSocket(socket, head, options);
}

function connectTcp(address, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ ...address, noDelay: true });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP connect timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const onError = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

export function bridge(websocket, tcp, label = "peer") {
  let stopped = false;
  let tcpBackpressured = false;
  let websocketBackpressured = false;

  websocket.onBinary = (payload) => {
    if (stopped) return false;
    const writable = tcp.write(payload);
    if (!writable && !tcpBackpressured) {
      tcpBackpressured = true;
      tcp.once("drain", () => {
        tcpBackpressured = false;
        websocket.resume();
      });
    }
    return writable;
  };

  const stop = (fromWebSocket, error) => {
    if (stopped) return;
    stopped = true;
    if (error) process.stderr.write(`relay: ${label}: ${error.message}\n`);
    if (fromWebSocket) {
      tcp.end();
      const timer = setTimeout(() => tcp.destroy(), 2_000);
      timer.unref?.();
    } else if (!websocket.closed) {
      websocket.close(error ? 1011 : 1000, error ? "TCP peer failed" : "TCP peer closed");
    }
  };

  tcp.on("data", (chunk) => {
    if (stopped) return;
    const writable = websocket.sendBinary(chunk);
    if (!writable && !websocketBackpressured) {
      websocketBackpressured = true;
      tcp.pause();
      websocket.socket.once("drain", () => {
        websocketBackpressured = false;
        if (!stopped) tcp.resume();
      });
    }
  });
  tcp.once("end", () => stop(false));
  tcp.once("error", (error) => stop(false, error));
  websocket.once("close", () => stop(true));
  websocket.once("error", (error) => stop(true, error));
  tcp.resume();
  return { close: () => stop(true) };
}

class PairQueue {
  constructor(timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.websockets = [];
    this.tcps = [];
    this.nextId = 1;
  }

  addWebSocket(websocket) {
    const item = { websocket, timer: null };
    websocket.onBinary = () => {
      websocket.close(1008, "do not send before a TCP source is paired");
      return false;
    };
    item.timer = setTimeout(() => {
      websocket.close(1008, "timed out waiting for TCP source");
      this._remove(this.websockets, item);
    }, this.timeoutMs);
    item.timer.unref?.();
    websocket.once("close", () => this._remove(this.websockets, item));
    this.websockets.push(item);
    this._pair();
  }

  addTcp(tcp) {
    tcp.pause();
    // A source can disappear while queued, before bridge() installs its
    // diagnostic listener. Keep that ordinary disconnect from becoming an
    // unhandled EventEmitter `error`.
    tcp.on("error", () => {});
    const item = { tcp, timer: null };
    item.timer = setTimeout(() => {
      tcp.destroy();
      this._remove(this.tcps, item);
    }, this.timeoutMs);
    item.timer.unref?.();
    tcp.once("close", () => this._remove(this.tcps, item));
    this.tcps.push(item);
    this._pair();
  }

  _remove(queue, item) {
    const index = queue.indexOf(item);
    if (index >= 0) queue.splice(index, 1);
    if (item.timer) clearTimeout(item.timer);
  }

  _pair() {
    while (this.websockets.length > 0 && this.tcps.length > 0) {
      const browser = this.websockets.shift();
      const source = this.tcps.shift();
      clearTimeout(browser.timer);
      clearTimeout(source.timer);
      if (browser.websocket.closed || source.tcp.destroyed) continue;
      const id = this.nextId++;
      process.stderr.write(`relay: paired browser target #${id} with TCP source\n`);
      bridge(browser.websocket, source.tcp, `inbound #${id}`);
    }
  }

  close() {
    for (const { websocket, timer } of this.websockets.splice(0)) {
      clearTimeout(timer);
      websocket.close(1001, "relay shutting down");
    }
    for (const { tcp, timer } of this.tcps.splice(0)) {
      clearTimeout(timer);
      tcp.destroy();
    }
  }
}

const STATIC_ROUTES = new Map([
  ["/", [path.join(DEMO_DIR, "index.html"), "text/html; charset=utf-8"]],
  ["/app.mjs", [path.join(DEMO_DIR, "app.mjs"), "text/javascript; charset=utf-8"]],
  ["/styles.css", [path.join(DEMO_DIR, "styles.css"), "text/css; charset=utf-8"]],
  ["/weave.mjs", [path.join(REPO_ROOT, "js/weave.mjs"), "text/javascript; charset=utf-8"]],
  ["/weave-browser.mjs", [path.join(REPO_ROOT, "js/weave-browser.mjs"), "text/javascript; charset=utf-8"]],
  ["/counter.woven.wasm", [path.join(DEMO_DIR, "counter.woven.wasm"), "application/wasm"]],
]);

function securityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
}

function serveHttp(req, response, config, queue) {
  securityHeaders(response);
  const url = new URL(req.url, "http://relay.invalid");
  if (url.pathname === "/v1/config") {
    const body = JSON.stringify({
      targets: [...config.targets.keys()],
      ingress: displayAddress(config.ingress),
      waitingBrowsers: queue.websockets.length,
      websocketProtocol: WEAVE_WEBSOCKET_PROTOCOL,
    });
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(body);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }
  const route = STATIC_ROUTES.get(url.pathname);
  if (!route) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("not found\n");
    return;
  }
  const [filename, contentType] = route;
  fs.stat(filename, (error, stat) => {
    if (error || !stat.isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(url.pathname === "/counter.woven.wasm"
        ? "generate counter.woven.wasm first; see README.md\n"
        : "not found\n");
      return;
    }
    response.writeHead(200, { "Content-Type": contentType, "Content-Length": stat.size });
    if (req.method === "HEAD") response.end();
    else fs.createReadStream(filename).pipe(response);
  });
}

function listen(server, address) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address.port, address.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function trackConnections(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return sockets;
}

/** Start the relay. Useful to tests as well as the CLI. */
export async function startRelay(config) {
  const queue = new PairQueue(config.pairTimeoutMs);
  const httpServer = http.createServer((req, response) => serveHttp(req, response, config, queue));
  const ingressServer = net.createServer({ pauseOnConnect: true }, (tcp) => {
    tcp.setNoDelay(true);
    queue.addTcp(tcp);
  });
  // http.Server.closeAllConnections() intentionally excludes upgraded
  // sockets. Track both listeners explicitly so relay.close() is deterministic
  // even while a WebSocket/TCP bridge is active.
  const httpConnections = trackConnections(httpServer);
  const ingressConnections = trackConnections(ingressServer);

  httpServer.on("upgrade", (req, socket, head) => {
    void (async () => {
      const invalid = validateUpgrade(req);
      if (invalid) return rejectUpgrade(socket, "400 Bad Request", invalid);
      const url = new URL(req.url, "http://relay.invalid");
      const boundHttp = httpServer.address();
      const listener = {
        host: config.http.host,
        port: typeof boundHttp === "object" && boundHttp ? boundHttp.port : config.http.port,
      };
      if (!originAllowed(req, config.origins, listener)) {
        return rejectUpgrade(socket, "403 Forbidden", "origin not allowed");
      }
      if (config.token && !secureEqual(url.searchParams.get("token"), config.token)) {
        return rejectUpgrade(socket, "401 Unauthorized", "bad relay token");
      }

      if (url.pathname === "/v1/accept") {
        const websocket = acceptWebSocket(req, socket, head, config);
        queue.addWebSocket(websocket);
        return;
      }
      const prefix = "/v1/connect/";
      if (!url.pathname.startsWith(prefix)) {
        return rejectUpgrade(socket, "404 Not Found", "unknown relay route");
      }
      let name;
      try { name = decodeURIComponent(url.pathname.slice(prefix.length)); }
      catch { return rejectUpgrade(socket, "400 Bad Request", "bad target name"); }
      const target = config.targets.get(name);
      if (!target) return rejectUpgrade(socket, "403 Forbidden", "target is not allowlisted");

      let tcp;
      try {
        tcp = await connectTcp(target, config.connectTimeoutMs);
      } catch (error) {
        return rejectUpgrade(socket, "502 Bad Gateway", `TCP target unavailable: ${error.message}`);
      }
      if (socket.destroyed) {
        tcp.destroy();
        return;
      }
      const websocket = acceptWebSocket(req, socket, head, config);
      process.stderr.write(`relay: browser connected to ${name} (${displayAddress(target)})\n`);
      bridge(websocket, tcp, `outbound ${name}`);
    })().catch((error) => {
      process.stderr.write(`relay: upgrade failed: ${error.stack ?? error}\n`);
      socket.destroy();
    });
  });

  try {
    await Promise.all([listen(httpServer, config.http), listen(ingressServer, config.ingress)]);
  } catch (error) {
    await Promise.all([closeServer(httpServer), closeServer(ingressServer)]);
    throw error;
  }

  const actualHttp = httpServer.address();
  const actualIngress = ingressServer.address();
  return {
    httpServer,
    ingressServer,
    queue,
    addresses: { http: actualHttp, ingress: actualIngress },
    async close() {
      queue.close();
      for (const socket of httpConnections) socket.destroy();
      for (const socket of ingressConnections) socket.destroy();
      await Promise.all([closeServer(httpServer), closeServer(ingressServer)]);
    },
  };
}

async function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`relay: ${error.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (config.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const relay = await startRelay(config);
  const httpAddress = relay.addresses.http;
  const ingressAddress = relay.addresses.ingress;
  const shownHttpHost = httpAddress.address.includes(":") ? `[${httpAddress.address}]` : httpAddress.address;
  process.stderr.write(`relay: demo at http://${shownHttpHost}:${httpAddress.port}/\n`);
  process.stderr.write(`relay: browser-target TCP ingress at ${displayAddress({ host: ingressAddress.address, port: ingressAddress.port })}\n`);
  process.stderr.write(`relay: outbound targets: ${[...config.targets.entries()].map(([name, addr]) => `${name}=${displayAddress(addr)}`).join(", ")}\n`);
  if (!config.token) process.stderr.write("relay: local demo mode (no token); use --token before exposing the HTTP listener\n");

  const shutdown = async () => {
    process.stderr.write("relay: shutting down\n");
    await relay.close();
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`relay: ${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
