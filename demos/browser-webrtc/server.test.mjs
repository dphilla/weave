import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArgs, startServer } from "./server.mjs";

async function fixture() {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "weave-webrtc-server-test-"));
  const wasmPath = path.join(directory, "fixture.wasm");
  await fs.promises.writeFile(wasmPath, Uint8Array.of(0, 97, 115, 109));
  return { directory, wasmPath };
}

async function withServer(options, run) {
  const files = await fixture();
  let running = null;
  try {
    running = await startServer({
      host: "127.0.0.1",
      port: 0,
      wasmPath: files.wasmPath,
      pollTimeoutMs: 100,
      ...options,
    });
    const base = `http://127.0.0.1:${running.address.port}`;
    await run({ base, running, ...files });
  } finally {
    await running?.close();
    await fs.promises.rm(files.directory, { recursive: true, force: true });
  }
}

function auth(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

let requestSequence = 0;
async function postSignal(
  base,
  room,
  peer,
  from,
  message,
  token = "",
  requestId = `test_request_${String(++requestSequence).padStart(8, "0")}`,
) {
  return fetch(`${base}/v1/signal/${room}/${peer}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth(token) },
    body: JSON.stringify({ from, requestId, message }),
  });
}

test("server exposes only bounded static/config routes", async () => {
  await withServer({ iceServers: [{ urls: "stun:stun.example.test" }] }, async ({ base }) => {
    const configResponse = await fetch(`${base}/v1/config`);
    assert.equal(configResponse.status, 200);
    assert.deepEqual(await configResponse.json(), {
      protocol: "weave.v2",
      signaling: "bounded-http-long-poll",
      iceServers: [{ urls: "stun:stun.example.test" }],
      tokenRequired: false,
    });

    const wasmResponse = await fetch(`${base}/counter.woven.wasm`);
    assert.equal(wasmResponse.headers.get("content-type"), "application/wasm");
    assert.deepEqual([...new Uint8Array(await wasmResponse.arrayBuffer())], [0, 97, 115, 109]);
    const transportResponse = await fetch(
      `${base}/packages/browser-transports/src/index.mjs`,
    );
    assert.equal(transportResponse.status, 200);
    assert.match(await transportResponse.text(), /export class RTCDataChannelByteStream/);
    const sessionResponse = await fetch(
      `${base}/packages/webrtc-session/src/index.mjs`,
    );
    assert.equal(sessionResponse.status, 200);
    assert.match(await sessionResponse.text(), /export class WebRTCSession/);
    assert.equal((await fetch(`${base}/../../README.md`)).status, 404);
  });
});

test("long-poll signaling queues ordered messages independently for each peer", async () => {
  await withServer({}, async ({ base }) => {
    const pending = fetch(`${base}/v1/signal/room_1/b?after=0`);
    // Ensure the GET is genuinely parked before the offer is published; this
    // exercises waiter wakeup, not only the already-queued fast path.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const sent = await postSignal(base, "room_1", "b", "a", { type: "offer", sdp: "opaque" });
    assert.equal(sent.status, 202);

    const received = await pending;
    assert.equal(received.status, 200);
    assert.deepEqual(await received.json(), {
      messages: [{ id: 1, from: "a", message: { type: "offer", sdp: "opaque" } }],
      cursor: 1,
    });

    await postSignal(base, "room_1", "a", "b", { type: "answer", sdp: "opaque-2" });
    const reverse = await fetch(`${base}/v1/signal/room_1/a?after=0`);
    assert.deepEqual(await reverse.json(), {
      messages: [{ id: 1, from: "b", message: { type: "answer", sdp: "opaque-2" } }],
      cursor: 1,
    });

    const empty = await fetch(`${base}/v1/signal/room_1/a?after=1`);
    assert.deepEqual(await empty.json(), { messages: [], cursor: 1 });
  });
});

test("signaling retries are idempotent and queue bytes are bounded", async () => {
  await withServer({ maxQueuedSignalBytes: 32 }, async ({ base }) => {
    const first = await postSignal(base, "room_dedupe", "b", "a", { type: "candidate", n: 1 }, "", "retry_request_0001");
    const duplicate = await postSignal(base, "room_dedupe", "b", "a", { type: "candidate", n: 1 }, "", "retry_request_0001");
    assert.equal(first.status, 202);
    assert.deepEqual(await duplicate.json(), { accepted: true, id: 1, duplicate: true });

    const received = await fetch(`${base}/v1/signal/room_dedupe/b?after=0`);
    assert.equal((await received.json()).messages.length, 1);

    const oversized = await postSignal(base, "room_dedupe", "b", "a", { value: "x".repeat(64) });
    assert.equal(oversized.status, 413);
    assert.match((await oversized.json()).error, /queue byte limit/);
  });
});

test("signaling authentication and queue-expiry failures are explicit", async () => {
  await withServer({ token: "test-secret", maxMessagesPerPeer: 2 }, async ({ base }) => {
    assert.equal((await fetch(`${base}/v1/config`)).status, 401);
    assert.equal((await fetch(`${base}/counter.woven.wasm`)).status, 401);
    assert.equal((await fetch(`${base}/v1/config`, { headers: auth("test-secret") })).status, 200);
    assert.equal((await fetch(`${base}/counter.woven.wasm`, { headers: auth("test-secret") })).status, 200);
    assert.equal((await fetch(`${base}/v1/signal/secure/a?after=0`)).status, 401);
    assert.equal((await postSignal(base, "secure", "a", "b", { n: 1 }, "bad")).status, 401);
    for (const n of [1, 2, 3]) {
      assert.equal((await postSignal(base, "secure", "a", "b", { n }, "test-secret")).status, 202);
    }
    const expired = await fetch(`${base}/v1/signal/secure/a?after=0`, {
      headers: auth("test-secret"),
    });
    assert.equal(expired.status, 409);
    assert.match((await expired.json()).error, /cursor expired/);
  });
});

test("argument parsing validates ICE input and public binds require a token", async () => {
  assert.deepEqual(
    parseArgs(["--http", "127.0.0.1:0", "--ice-server-json", '{"urls":"turns:turn.example","username":"u","credential":"p"}']).iceServers,
    [{ urls: "turns:turn.example", username: "u", credential: "p" }],
  );
  assert.throws(
    () => parseArgs(["--ice-server-json", '{"urls":"https://not-ice.example"}']),
    /must use stun/,
  );

  const files = await fixture();
  try {
    await assert.rejects(
      startServer({ host: "0.0.0.0", port: 0, wasmPath: files.wasmPath }),
      /requires --token/,
    );
  } finally {
    await fs.promises.rm(files.directory, { recursive: true, force: true });
  }
});

test("browser-facing routes reject cross-site requests", async () => {
  await withServer({}, async ({ base }) => {
    assert.equal((await fetch(`${base}/v1/config`, {
      headers: { "sec-fetch-site": "cross-site" },
    })).status, 403);
    assert.equal((await fetch(`${base}/v1/config`, {
      headers: { origin: "https://attacker.example" },
    })).status, 403);
  });
});
