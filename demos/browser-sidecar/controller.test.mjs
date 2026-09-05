import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SidecarClient, parseOptions, startDemo } from "./controller.mjs";

const READY = 'process.stdout.write(JSON.stringify({v:1,event:"ready",protocol:"webrtc-sidecar.control.v1"}) + "\\n");';

async function fixture(t, name, source) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "weave-sidecar-lifecycle-test-"));
  const filename = path.join(directory, `${name}.mjs`);
  await fs.promises.writeFile(filename, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return filename;
}

function ownedClient(t, filename, options = {}) {
  const client = new SidecarClient(filename, { timeoutMs: 2_000, ...options });
  t.after(async () => {
    try { await client.close(); } catch { /* tests assert the original failure */ }
  });
  return client;
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function assertNotListening(address) {
  const [host, port] = address.split(":");
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: Number(port) });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`owned listener still accepts connections at ${address}`));
    });
    socket.once("error", (error) => error.code === "ECONNREFUSED" ? resolve() : reject(error));
  });
}

test("controller options keep external binaries injectable and validate bounds", () => {
  const parsed = parseOptions([
    "--sidecar", "/tmp/example-sidecar",
    "--weave", "/tmp/example-weave",
    "--wasm", "/tmp/example.wasm",
    "--http", "127.0.0.1:1234",
    "--timeout-ms", "12345",
    "--ice-server-json", '{"urls":"stun:127.0.0.1:3478"}',
    "--quiet",
  ]);
  assert.equal(parsed.sidecar, "/tmp/example-sidecar");
  assert.equal(parsed.weave, "/tmp/example-weave");
  assert.equal(parsed.wasm, "/tmp/example.wasm");
  assert.deepEqual(parsed.http, { host: "127.0.0.1", port: 1234 });
  assert.equal(parsed.timeoutMs, 12345);
  assert.deepEqual(parsed.iceServers, [{ urls: "stun:127.0.0.1:3478" }]);
  assert.equal(parsed.quiet, true);
  assert.throws(() => parseOptions(["--timeout-ms", "0"]), /positive integer/);
  assert.throws(() => parseOptions(["--http", "not-an-address"]), /invalid address/);
});

test("SidecarClient speaks the frozen NDJSON protocol and preserves event order", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "weave-sidecar-controller-test-"));
  const fixture = path.join(directory, "fake-sidecar.mjs");
  const source = `#!${process.execPath}
import readline from "node:readline";
let seq = 1;
let status = null;
process.stdout.write(JSON.stringify({v:1,event:"ready",protocol:"webrtc-sidecar.control.v1",capabilities:[],limits:{maxChannels:8,maxControlBytes:1048576}}) + "\\r\\n");
const lines = readline.createInterface({input:process.stdin});
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.command === "start") {
    const channels = request.channels.map((channel) => ({
      mapping: channel.mapping,
      label: channel.label,
      protocol: channel.protocol,
      local: channel.local.mode === "listen"
        ? {mode:"listen",address:"127.0.0.1:45678"}
        : {mode:"dial",address:channel.local.host + ":" + channel.local.port,connectOn:channel.local.connectOn || "open"},
    }));
    status = {role:request.role,state:"connected",terminal:false,channels:channels.map((channel) => ({mapping:channel.mapping,label:channel.label,protocol:channel.protocol,state:"waiting",localReady:false,rtcReady:true,local:channel.local}))};
    process.stdout.write(
      JSON.stringify({v:1,id:request.id,ok:true,result:{role:request.role,channels}}) + "\\n" +
      JSON.stringify({v:1,seq:seq++,event:"session.state",state:"starting"}) + "\\n"
    );
  } else if (request.command === "status") {
    process.stdout.write(JSON.stringify({v:1,id:request.id,ok:true,result:status}) + "\\n");
  } else if (request.command === "signal") {
    process.stdout.write(JSON.stringify({v:1,id:request.id,ok:true,result:{}}) + "\\n");
    process.stdout.write(JSON.stringify({v:1,seq:seq++,event:"signal",message:{type:"candidate",candidate:null}}) + "\\n");
  } else if (request.command === "close") {
    process.stdout.write(JSON.stringify({v:1,id:request.id,ok:true,result:{}}) + "\\n");
    process.stdout.write(JSON.stringify({v:1,seq:seq++,event:"closed",reason:"closed"}) + "\\n", () => process.exit(0));
  }
});
`;
  await fs.promises.writeFile(fixture, source, { mode: 0o755 });

  const client = new SidecarClient(fixture, { timeoutMs: 2_000 });
  const events = [];
  let resolveSignal;
  const signalEvent = new Promise((resolve) => { resolveSignal = resolve; });
  client.onEvent = (event) => {
    events.push(event);
    if (event.event === "signal") resolveSignal(event);
  };
  try {
    const ready = await client.ready;
    assert.equal(ready.protocol, "webrtc-sidecar.control.v1");
    const started = await client.start({
      role: "answerer",
      rtcConfiguration: { iceServers: [], iceTransportPolicy: "all" },
      connectTimeoutMs: 0,
      channels: [
        {
          mapping: "out",
          label: "out",
          protocol: "bytes.v1",
          local: {
            mode: "dial",
            host: "127.0.0.1",
            port: 1234,
            connectOn: "first-data",
          },
        },
        {
          mapping: "in",
          label: "in",
          protocol: "bytes.v1",
          local: { mode: "listen", host: "127.0.0.1", port: 0 },
        },
      ],
    });
    assert.equal(started.channels[0].local.connectOn, "first-data");
    assert.equal(started.channels[1].local.address, "127.0.0.1:45678");
    assert.equal(events[0]?.event, "session.state");
    const status = await client.status();
    assert.deepEqual(status.channels[0], {
      mapping: "out",
      label: "out",
      protocol: "bytes.v1",
      state: "waiting",
      localReady: false,
      rtcReady: true,
      local: {
        mode: "dial",
        address: "127.0.0.1:1234",
        connectOn: "first-data",
      },
    });
    await client.signal({
      type: "description",
      description: { type: "offer", sdp: "v=0\\r\\n" },
    });
    assert.deepEqual(await signalEvent, {
      v: 1,
      seq: 2,
      event: "signal",
      message: { type: "candidate", candidate: null },
    });
    const closed = await client.close();
    assert.equal(closed.code, 0);
    assert.equal(events[2].event, "closed");
    assert.equal(client.error, null);
  } finally {
    if (client.child.exitCode === null) client.child.kill("SIGKILL");
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("SidecarClient rejects invalid UTF-8 control output", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "weave-sidecar-controller-test-"));
  const fixture = path.join(directory, "invalid-utf8-sidecar.mjs");
  await fs.promises.writeFile(
    fixture,
    `#!${process.execPath}\nprocess.stdout.write(Buffer.from([0x7b, 0xff, 0x7d, 0x0a]));\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o755 },
  );
  const client = new SidecarClient(fixture, { timeoutMs: 1_000 });
  try {
    await assert.rejects(client.ready, /not valid UTF-8/);
  } finally {
    client.child.kill("SIGKILL");
    await client.closed;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("SidecarClient clears a request whose stdin write fails", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "weave-sidecar-controller-test-"));
  const fixture = path.join(directory, "idle-sidecar.mjs");
  await fs.promises.writeFile(
    fixture,
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({v:1,event:"ready",protocol:"webrtc-sidecar.control.v1"}) + "\\n");\nprocess.stdin.resume();\n`,
    { mode: 0o755 },
  );
  const client = new SidecarClient(fixture, { timeoutMs: 1_000 });
  try {
    await client.ready;
    const originalWrite = client.child.stdin.write;
    client.child.stdin.write = (_bytes, callback) => {
      queueMicrotask(() => callback(new Error("synthetic stdin failure")));
      return false;
    };
    await assert.rejects(client.status(), /synthetic stdin failure/);
    assert.equal(client.pending.size, 0);
    client.child.stdin.write = originalWrite;
  } finally {
    client.child.kill("SIGKILL");
    await client.closed;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("SidecarClient close surfaces a late nonzero process exit", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "weave-sidecar-controller-test-"));
  const fixture = path.join(directory, "late-failure-sidecar.mjs");
  await fs.promises.writeFile(
    fixture,
    `#!${process.execPath}
import readline from "node:readline";
process.stdout.write(JSON.stringify({v:1,event:"ready",protocol:"webrtc-sidecar.control.v1"}) + "\\n");
readline.createInterface({input:process.stdin}).on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({v:1,id:request.id,ok:true,result:{}}) + "\\n", () => process.exit(7));
});
`,
    { mode: 0o755 },
  );
  const client = new SidecarClient(fixture, { timeoutMs: 1_000 });
  try {
    await client.ready;
    await assert.rejects(client.close(), /sidecar exited with 7/);
    assert.equal((await client.closed).code, 7);
  } finally {
    if (client.child.exitCode === null) client.child.kill("SIGKILL");
    await client.closed;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("SidecarClient handles a real broken stdin pipe without an uncaught Socket error", async (t) => {
  const filename = await fixture(t, "closed-stdin", `
import fs from "node:fs";
fs.closeSync(0);
${READY}
setInterval(() => {}, 1000);
`);
  const client = ownedClient(t, filename);
  await client.ready;
  await assert.rejects(client.status(), { code: "EPIPE" });
  assert.equal(client.pending.size, 0);
  await assert.rejects(client.close(), { code: "EPIPE" });
  assert.ok(exited(client.child));
});

test("SidecarClient observes a response timeout even when its write callback never arrives", async (t) => {
  const filename = await fixture(t, "stalled-write", `${READY}\nprocess.stdin.resume();`);
  const client = ownedClient(t, filename);
  await client.ready;
  client.timeoutMs = 30;
  client.child.stdin.write = () => false;
  await assert.rejects(client.status(), /status request timed out/);
  assert.equal(client.pending.size, 0);
  await assert.rejects(client.close(), /close.*timed out/);
  assert.ok(exited(client.child));
});

test("SidecarClient rejects pending responses when the process exits during a request", async (t) => {
  const filename = await fixture(t, "exit-during-request", `${READY}\nprocess.stdin.once("data", () => process.exit(7));`);
  const client = ownedClient(t, filename);
  await client.ready;
  await assert.rejects(client.status(), /sidecar exited with 7/);
  assert.equal(client.pending.size, 0);
  await assert.rejects(client.close(), /sidecar exited with 7/);
});

test("SidecarClient handles a write error after its response was already accepted", async (t) => {
  const filename = await fixture(t, "late-write-error", `${READY}\nprocess.stdin.resume();`);
  const client = ownedClient(t, filename);
  await client.ready;
  client.child.stdin.write = (bytes, callback) => {
    const { id } = JSON.parse(bytes);
    client.message({ v: 1, id, ok: true, result: { accepted: true } });
    setImmediate(() => {
      const error = new Error("late pipe failure");
      callback(error);
      client.child.stdin.emit("error", error);
    });
    return true;
  };
  assert.deepEqual(await client.status(), { accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.pending.size, 0);
  await assert.rejects(client.close(), /late pipe failure/);
  assert.ok(exited(client.child));
});

test("SidecarClient readiness is finite and close can precede ready", async (t) => {
  const filename = await fixture(t, "never-ready", "setInterval(() => {}, 1000);");
  const client = ownedClient(t, filename, { timeoutMs: 100 });
  const readyFailure = assert.rejects(client.ready, /ready timed out/);
  await assert.rejects(client.close(), /ready timed out|close timed out/);
  await readyFailure;
  assert.ok(exited(client.child));
  assert.equal(client.pending.size, 0);
});

test("SidecarClient rejects clean exit before ready and settles failed spawn", async (t) => {
  const filename = await fixture(t, "exit-before-ready", "process.exit(0);");
  const early = ownedClient(t, filename);
  await assert.rejects(early.ready, /exited before ready/);
  await assert.rejects(early.close(), /exited before ready/);
  assert.equal((await early.closed).code, 0);
  const missing = ownedClient(t, `${filename}.does-not-exist`);
  // Deliberately install the readiness waiter only after startup has failed.
  await missing.closed;
  await assert.rejects(missing.ready, { code: "ENOENT" });
  await assert.rejects(missing.close(), { code: "ENOENT" });
  assert.notEqual((await missing.closed).code, 0);
});

test("SidecarClient close is idempotent and waits for a clean exit", async (t) => {
  const filename = await fixture(t, "clean-close", `
import readline from "node:readline";
${READY}
readline.createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({v:1,id:request.id,ok:true,result:{}}) + "\\n", () => process.exit(0));
});
`);
  const client = ownedClient(t, filename);
  await client.ready;
  const first = client.close();
  assert.equal(client.close(), first);
  assert.equal((await first).code, 0);
  assert.equal(client.close(), first);
  assert.ok(exited(client.child));
  assert.equal(client.protocolLines.filter((line) => Object.hasOwn(JSON.parse(line), "id")).length, 1);
});

test("SidecarClient kills and reaps a peer that acknowledges close but ignores termination", { timeout: 10_000 }, async (t) => {
  const filename = await fixture(t, "close-ack-no-exit", `
import readline from "node:readline";
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
${READY}
readline.createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({v:1,id:request.id,ok:true,result:{}}) + "\\n");
});
`);
  const client = ownedClient(t, filename);
  await client.ready;
  client.timeoutMs = 30;
  await assert.rejects(client.close(), /did not exit after close/);
  assert.equal(client.child.signalCode, "SIGKILL");
  assert.equal(client.pending.size, 0);
  assert.equal(client.child.listenerCount("exit"), 0);
});

test("demo cleanup closes HTTP and native listeners despite sidecar failure and synchronous close errors", async (t) => {
  const native = await fixture(t, "native-listener", `
import net from "node:net";
net.createServer().listen(0, "127.0.0.1", function () {
  process.stderr.write("weave: listening on 127.0.0.1:" + this.address().port + "\\n");
});
`);
  const sidecar = await fixture(t, "failing-close", `
import readline from "node:readline";
${READY}
readline.createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  if (request.command === "start") {
    process.stdout.write(JSON.stringify({v:1,id:request.id,ok:true,result:{channels:[{mapping:"native-to-browser",local:{mode:"listen",address:"127.0.0.1:45678"}}]}}) + "\\n");
  } else if (request.command === "close") {
    process.exit(7);
  }
});
`);
  const demo = await startDemo({ weave: native, sidecar, wasm: sidecar, timeoutMs: 2_000, quiet: true });
  t.after(() => demo.close().catch(() => {}));
  const address = new URL(demo.baseUrl);
  const originalClose = demo.server.close;
  demo.server.close = () => {
    // Model a synchronous cleanup failure after releasing its own listener.
    void originalClose();
    throw new Error("synthetic synchronous close failure");
  };
  const first = demo.close();
  assert.equal(demo.close(), first);
  await assert.rejects(first, (error) => error instanceof AggregateError &&
    error.errors.some((failure) => /synthetic synchronous close failure/.test(failure.message)));
  assert.ok(exited(demo.sidecar.child));
  assert.ok(exited(demo.native.child));
  await assertNotListening(demo.nativeAddress);
  await assertNotListening(`${address.hostname}:${address.port}`);
});
