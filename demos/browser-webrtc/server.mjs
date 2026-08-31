#!/usr/bin/env node
// Dependency-free static/signaling server for the browser-to-browser demo.
// Migration bytes never pass through this process; it exchanges only WebRTC
// offer/answer/ICE JSON, using bounded long polling to avoid a WebSocket dep.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const DEFAULT_WASM = path.join(REPO_ROOT, "target/demo-artifacts/browser-webrtc/counter.woven.wasm");
const MAX_BODY_BYTES = 256 * 1024;
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PEER_RE = /^[ab]$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function usage() {
  return `usage: node demos/browser-webrtc/server.mjs [options]

  --http HOST:PORT        HTTP listener (default 127.0.0.1:8790)
  --wasm PATH             woven module served to both peers
  --token TOKEN           bearer token (loopback CLI generates one if omitted)
  --ice-server-json JSON  RTCIceServer object; repeat for STUN/TURN entries
  --help                  show this message

Examples:
  node demos/browser-webrtc/server.mjs --wasm app.woven.wasm
  WEAVE_SIGNAL_TOKEN="from-a-secret-store" \\
  WEAVE_ICE_SERVERS_JSON='[{"urls":"stun:stun.example.net"}]' \\
    node demos/browser-webrtc/server.mjs --http 0.0.0.0:8790`;
}

function parseListen(value) {
  const match = value.match(/^\[([^\]]+)]:(\d+)$/) ?? value.match(/^([^:]+):(\d+)$/);
  if (!match) throw new Error(`invalid listener ${value}; expected HOST:PORT`);
  const port = Number(match[2]);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid listener port: ${match[2]}`);
  }
  return { host: match[1], port };
}

function isLoopback(host) {
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function parseIceServer(raw) {
  let value;
  try { value = JSON.parse(raw); }
  catch (error) { throw new Error(`invalid --ice-server-json: ${error.message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--ice-server-json must be a JSON object");
  }
  const urls = typeof value.urls === "string" ? [value.urls] : value.urls;
  if (!Array.isArray(urls) || urls.length === 0 || urls.some((url) => typeof url !== "string")) {
    throw new Error("each ICE server requires a string or string-array urls field");
  }
  if (urls.some((url) => !/^(stun|stuns|turn|turns):/.test(url))) {
    throw new Error("ICE server URLs must use stun:, stuns:, turn:, or turns:");
  }
  return value;
}

export function parseArgs(argv) {
  const listen = parseListen("127.0.0.1:8790");
  const options = {
    ...listen,
    wasmPath: process.env.WEAVE_DEMO_WASM ?? DEFAULT_WASM,
    token: process.env.WEAVE_SIGNAL_TOKEN ?? "",
    iceServers: [],
    help: false,
  };
  if (process.env.WEAVE_ICE_SERVERS_JSON) {
    let values;
    try { values = JSON.parse(process.env.WEAVE_ICE_SERVERS_JSON); }
    catch (error) { throw new Error(`invalid WEAVE_ICE_SERVERS_JSON: ${error.message}`); }
    if (!Array.isArray(values)) throw new Error("WEAVE_ICE_SERVERS_JSON must be a JSON array");
    options.iceServers.push(...values.map((value) => parseIceServer(JSON.stringify(value))));
  }

  const take = (index, flag) => {
    if (index + 1 >= argv.length) throw new Error(`${flag} requires a value`);
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--http": Object.assign(options, parseListen(take(i, argv[i++]))); break;
      case "--wasm": options.wasmPath = path.resolve(take(i, argv[i++])); break;
      case "--token": options.token = take(i, argv[i++]); break;
      case "--ice-server-json": options.iceServers.push(parseIceServer(take(i, argv[i++]))); break;
      case "--help": options.help = true; break;
      default: throw new Error(`unknown option: ${argv[i]}`);
    }
  }
  return options;
}

function sendJson(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

function authorized(request, token) {
  if (!token) return true;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.authorization ?? "");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function requireSameOriginBrowserRequest(request) {
  if (request.headers["sec-fetch-site"] === "cross-site") {
    throw new HttpError(403, "cross-site browser requests are not allowed");
  }
  const origin = request.headers.origin;
  if (!origin) return;
  if (origin === "null") throw new HttpError(403, "opaque browser origins are not allowed");
  let originHost;
  try { originHost = new URL(origin).host; }
  catch { throw new HttpError(403, "invalid request origin"); }
  if (!request.headers.host || originHost !== request.headers.host) {
    throw new HttpError(403, "request origin does not match this signaling host");
  }
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "signaling message is too large");
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "request body must be valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return value;
}

function validateSignalPath(pathname) {
  const match = pathname.match(/^\/v1\/signal\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  let room;
  let peer;
  try {
    room = decodeURIComponent(match[1]);
    peer = decodeURIComponent(match[2]);
  } catch {
    throw new HttpError(400, "invalid signaling path encoding");
  }
  if (!ROOM_RE.test(room)) throw new HttpError(400, "invalid room name");
  if (!PEER_RE.test(peer)) throw new HttpError(400, "peer must be a or b");
  return { room, peer };
}

function staticRoutes(wasmPath) {
  return new Map([
    ["/", [path.join(HERE, "index.html"), "text/html; charset=utf-8"]],
    ["/index.html", [path.join(HERE, "index.html"), "text/html; charset=utf-8"]],
    ["/app.mjs", [path.join(HERE, "app.mjs"), "text/javascript; charset=utf-8"]],
    ["/styles.css", [path.join(HERE, "styles.css"), "text/css; charset=utf-8"]],
    ["/weave.mjs", [path.join(REPO_ROOT, "js/weave.mjs"), "text/javascript; charset=utf-8"]],
    ["/weave-browser.mjs", [path.join(REPO_ROOT, "js/weave-browser.mjs"), "text/javascript; charset=utf-8"]],
    ["/packages/browser-transports/src/index.mjs", [path.join(REPO_ROOT, "packages/browser-transports/src/index.mjs"), "text/javascript; charset=utf-8"]],
    ["/counter.woven.wasm", [wasmPath, "application/wasm"]],
  ]);
}

/** Start the local demo server. Exported for socket-level and browser tests. */
export async function startServer(options) {
  const config = {
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 0,
    wasmPath: path.resolve(options.wasmPath ?? DEFAULT_WASM),
    token: options.token ?? "",
    iceServers: options.iceServers ?? [],
    pollTimeoutMs: options.pollTimeoutMs ?? 20_000,
    roomTtlMs: options.roomTtlMs ?? 10 * 60_000,
    maxRooms: options.maxRooms ?? 128,
    maxMessagesPerPeer: options.maxMessagesPerPeer ?? 256,
    maxQueuedSignalBytes: options.maxQueuedSignalBytes ?? 1024 * 1024,
    maxWaitersPerPeer: options.maxWaitersPerPeer ?? 2,
    maxRememberedRequestsPerPeer: options.maxRememberedRequestsPerPeer ?? 512,
  };
  for (const name of [
    "pollTimeoutMs",
    "roomTtlMs",
    "maxRooms",
    "maxMessagesPerPeer",
    "maxQueuedSignalBytes",
    "maxWaitersPerPeer",
    "maxRememberedRequestsPerPeer",
  ]) {
    if (!Number.isSafeInteger(config[name]) || config[name] <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  if (!isLoopback(config.host) && !config.token) {
    throw new Error("a non-loopback listener requires --token");
  }
  await fs.promises.access(config.wasmPath, fs.constants.R_OK);
  const routes = staticRoutes(config.wasmPath);
  const rooms = new Map();

  const getRoom = (name) => {
    let room = rooms.get(name);
    if (!room) {
      if (rooms.size >= config.maxRooms) throw new HttpError(503, "signaling room limit reached");
      const inbox = () => ({
        nextId: 1,
        messages: [],
        queuedBytes: 0,
        waiters: new Set(),
        rememberedRequests: new Map(),
      });
      room = { a: inbox(), b: inbox(), lastActivity: Date.now() };
      rooms.set(name, room);
    }
    room.lastActivity = Date.now();
    return room;
  };

  const messagesAfter = (inbox, after) => {
    if (inbox.messages.length > 0 && after < inbox.messages[0].id - 1) {
      throw new HttpError(409, "signaling cursor expired; reload both peers");
    }
    return inbox.messages.filter(({ id }) => id > after);
  };

  const removeWaiter = (inbox, waiter) => {
    clearTimeout(waiter.timer);
    inbox.waiters.delete(waiter);
  };

  const answerPoll = (inbox, waiter, messages) => {
    removeWaiter(inbox, waiter);
    const cursor = messages.length > 0 ? messages[messages.length - 1].id : waiter.after;
    sendJson(waiter.response, 200, { messages, cursor });
  };

  const flushWaiters = (inbox) => {
    for (const waiter of [...inbox.waiters]) {
      let messages;
      try { messages = messagesAfter(inbox, waiter.after); }
      catch (error) {
        removeWaiter(inbox, waiter);
        sendJson(waiter.response, error.status ?? 500, { error: error.message });
        continue;
      }
      if (messages.length > 0) answerPoll(inbox, waiter, messages);
    }
  };

  const handler = async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://weave.invalid");
      requireSameOriginBrowserRequest(request);

      if (request.method === "GET" && url.pathname === "/v1/config") {
        if (!authorized(request, config.token)) throw new HttpError(401, "signaling authorization failed");
        sendJson(response, 200, {
          protocol: "weave.v2",
          signaling: "bounded-http-long-poll",
          iceServers: config.iceServers,
          tokenRequired: Boolean(config.token),
        });
        return;
      }

      const signal = validateSignalPath(url.pathname);
      if (signal) {
        if (!authorized(request, config.token)) throw new HttpError(401, "signaling authorization failed");
        const room = getRoom(signal.room);
        const inbox = room[signal.peer];

        if (request.method === "GET") {
          const rawAfter = url.searchParams.get("after") ?? "0";
          if (!/^\d+$/.test(rawAfter)) throw new HttpError(400, "after must be a non-negative integer");
          const after = Number(rawAfter);
          if (!Number.isSafeInteger(after)) throw new HttpError(400, "after exceeds the integer range");
          const messages = messagesAfter(inbox, after);
          if (messages.length > 0) {
            sendJson(response, 200, { messages, cursor: messages[messages.length - 1].id });
            return;
          }
          if (inbox.waiters.size >= config.maxWaitersPerPeer) {
            throw new HttpError(429, "too many concurrent signaling polls for this peer");
          }
          const waiter = { response, after, timer: null };
          waiter.timer = setTimeout(() => answerPoll(inbox, waiter, []), config.pollTimeoutMs);
          inbox.waiters.add(waiter);
          response.once("close", () => {
            if (!response.writableEnded) removeWaiter(inbox, waiter);
          });
          return;
        }

        if (request.method === "POST") {
          const body = await readJson(request);
          if (!PEER_RE.test(body.from) || body.from === signal.peer) {
            throw new HttpError(400, "from must name the other peer");
          }
          if (!body.message || typeof body.message !== "object" || Array.isArray(body.message)) {
            throw new HttpError(400, "message must be a JSON object");
          }
          if (!REQUEST_ID_RE.test(body.requestId ?? "")) {
            throw new HttpError(400, "requestId must be a 16-64 character URL-safe identifier");
          }
          const requestKey = `${body.from}:${body.requestId}`;
          const duplicateId = inbox.rememberedRequests.get(requestKey);
          if (duplicateId !== undefined) {
            sendJson(response, 202, { accepted: true, id: duplicateId, duplicate: true });
            return;
          }
          const queuedBytes = Buffer.byteLength(JSON.stringify(body.message));
          if (queuedBytes > config.maxQueuedSignalBytes) {
            throw new HttpError(413, "signaling message exceeds the per-peer queue byte limit");
          }
          const entry = { id: inbox.nextId++, from: body.from, message: body.message };
          Object.defineProperty(entry, "queuedBytes", {
            value: queuedBytes,
          });
          inbox.messages.push(entry);
          inbox.queuedBytes += entry.queuedBytes;
          inbox.rememberedRequests.set(requestKey, entry.id);
          while (inbox.rememberedRequests.size > config.maxRememberedRequestsPerPeer) {
            inbox.rememberedRequests.delete(inbox.rememberedRequests.keys().next().value);
          }
          while (
            inbox.messages.length > config.maxMessagesPerPeer ||
            inbox.queuedBytes > config.maxQueuedSignalBytes
          ) {
            inbox.queuedBytes -= inbox.messages.shift().queuedBytes;
          }
          flushWaiters(inbox);
          sendJson(response, 202, { accepted: true, id: entry.id });
          return;
        }

        throw new HttpError(405, "method not allowed");
      }

      if (request.method === "GET" && routes.has(url.pathname)) {
        if (url.pathname === "/counter.woven.wasm" && !authorized(request, config.token)) {
          throw new HttpError(401, "module authorization failed");
        }
        const [filename, contentType] = routes.get(url.pathname);
        const body = await fs.promises.readFile(filename);
        response.writeHead(200, {
          "content-type": contentType,
          "content-length": body.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "cross-origin-resource-policy": "same-origin",
          "content-security-policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          "permissions-policy": "camera=(), microphone=(), geolocation=()",
        });
        response.end(body);
        return;
      }

      throw new HttpError(404, "not found");
    } catch (error) {
      sendJson(response, error.status ?? 500, { error: error.message ?? String(error) });
    }
  };

  const server = http.createServer((request, response) => { void handler(request, response); });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  const janitor = setInterval(() => {
    const cutoff = Date.now() - config.roomTtlMs;
    for (const [name, room] of rooms) {
      if (room.lastActivity >= cutoff || room.a.waiters.size || room.b.waiters.size) continue;
      rooms.delete(name);
    }
  }, Math.min(config.roomTtlMs, 60_000));
  janitor.unref();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();

  return {
    server,
    address,
    config,
    async close() {
      clearInterval(janitor);
      for (const room of rooms.values()) {
        for (const inbox of [room.a, room.b]) {
          for (const waiter of [...inbox.waiters]) {
            removeWaiter(inbox, waiter);
            sendJson(waiter.response, 503, { error: "signaling server stopped" });
          }
        }
      }
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections?.();
      await closed;
    },
  };
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  let generatedToken = false;
  if (!options.token && isLoopback(options.host)) {
    options.token = crypto.randomBytes(24).toString("base64url");
    generatedToken = true;
  }
  const running = await startServer(options);
  const host = running.address.address === "::" || running.address.address === "0.0.0.0"
    ? "127.0.0.1"
    : running.address.address.includes(":") ? `[${running.address.address}]` : running.address.address;
  const base = `http://${host}:${running.address.port}/`;
  process.stdout.write(`weave browser-to-browser signaling: ${base}\n`);
  if (generatedToken) {
    process.stdout.write(`open ${base}#token=${options.token} as peer A; the page generates a private peer B room link\n`);
  } else {
    process.stdout.write(`open ${base} as peer A and append #token=YOUR_TOKEN; the page generates a private peer B room link\n`);
  }
  process.stdout.write("the fragment token stays out of the initial URL request and is then sent in Authorization headers\n");
  process.stdout.write("migration data uses WebRTC directly; this server sees signaling JSON only\n");

  const stop = async () => {
    await running.close();
    process.exit(0);
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`browser-webrtc server failed: ${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
