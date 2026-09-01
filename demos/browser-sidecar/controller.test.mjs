import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SidecarClient, parseOptions } from "./controller.mjs";

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
