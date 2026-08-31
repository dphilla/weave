import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import test from "node:test";

import { parseAddress, parseArgs, startRelay } from "./relay.mjs";

class Reader {
  constructor(socket) {
    this.bytes = Buffer.alloc(0);
    this.waiters = [];
    this.error = null;
    socket.on("data", (chunk) => {
      this.bytes = Buffer.concat([this.bytes, chunk]);
      this.pump();
    });
    socket.on("error", (error) => { this.error = error; this.pump(); });
    socket.on("close", () => {
      this.error ??= new Error("socket closed");
      this.pump();
    });
  }

  pump() {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      const length = waiter.find(this.bytes);
      if (length !== null) {
        this.waiters.shift();
        const result = this.bytes.subarray(0, length);
        this.bytes = this.bytes.subarray(length);
        waiter.resolve(result);
      } else if (this.error) {
        this.waiters.shift();
        waiter.reject(this.error);
      } else return;
    }
  }

  wait(find) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ find, resolve, reject });
      this.pump();
    });
  }

  exact(length) {
    return this.wait((bytes) => bytes.length >= length ? length : null);
  }

  through(marker) {
    return this.wait((bytes) => {
      const index = bytes.indexOf(marker);
      return index >= 0 ? index + marker.length : null;
    });
  }
}

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function connect(address) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address.address, port: address.port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

async function connectWebSocket(address, route) {
  const socket = await connect(address);
  const reader = new Reader(socket);
  const key = crypto.randomBytes(16).toString("base64");
  socket.write([
    `GET ${route} HTTP/1.1`,
    `Host: 127.0.0.1:${address.port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Protocol: weave.v2",
    `Origin: http://127.0.0.1:${address.port}`,
    "\r\n",
  ].join("\r\n"));
  const response = (await reader.through(Buffer.from("\r\n\r\n"))).toString();
  assert.match(response, /^HTTP\/1\.1 101 /);
  assert.match(response, /Sec-WebSocket-Protocol: weave\.v2/i);
  return { socket, reader };
}

function maskedFrame(opcode, payload, fin = true) {
  const bytes = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  let header;
  if (bytes.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | bytes.length]);
  } else {
    header = Buffer.allocUnsafe(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(bytes.length, 2);
  }
  const masked = Buffer.allocUnsafe(bytes.length);
  for (let i = 0; i < bytes.length; i++) masked[i] = bytes[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

async function readFrame(reader) {
  const header = await reader.exact(2);
  const opcode = header[0] & 0x0f;
  assert.equal(header[1] & 0x80, 0, "server frame must not be masked");
  let length = header[1] & 0x7f;
  if (length === 126) length = (await reader.exact(2)).readUInt16BE();
  else if (length === 127) length = Number((await reader.exact(8)).readBigUInt64BE());
  return { opcode, payload: await reader.exact(length) };
}

async function readBinaryBytes(reader, length) {
  const parts = [];
  let received = 0;
  while (received < length) {
    const next = await readFrame(reader);
    assert.equal(next.opcode, 0x2);
    parts.push(next.payload);
    received += next.payload.length;
  }
  assert.equal(received, length);
  return Buffer.concat(parts);
}

test("address and relay arguments are strict", () => {
  assert.deepEqual(parseAddress("[::1]:7777"), { host: "::1", port: 7777 });
  assert.throws(() => parseAddress("localhost"), /bad address/);
  assert.throws(() => parseArgs(["--http", "0.0.0.0:8787"]), /--token is required/);
  const config = parseArgs(["--target", "other=127.0.0.1:9000"]);
  assert.deepEqual(config.targets.get("other"), { host: "127.0.0.1", port: 9000 });
});

test("relay carries bytes for browser source and browser target", { timeout: 10_000 }, async () => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  const echoAddress = await listen(echo);
  const config = parseArgs([
    "--http", "127.0.0.1:0",
    "--ingress", "127.0.0.1:0",
    "--target", `echo=127.0.0.1:${echoAddress.port}`,
  ]);
  const relay = await startRelay(config);
  const httpAddress = relay.addresses.http;
  const ingressAddress = relay.addresses.ingress;

  try {
    const packageResponse = await fetch(
      `http://127.0.0.1:${httpAddress.port}/packages/browser-transports/src/index.mjs`,
    );
    assert.equal(packageResponse.status, 200);
    assert.match(await packageResponse.text(), /export class WebSocketByteStream/);

    // A hostile page cannot use DNS rebinding plus a matching forged Host
    // header to reach the tokenless loopback relay.
    const rebound = await connect(httpAddress);
    const reboundReader = new Reader(rebound);
    rebound.write([
      "GET /v1/connect/echo HTTP/1.1",
      "Host: attacker.example",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}`,
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Protocol: weave.v2",
      "Origin: http://attacker.example",
      "\r\n",
    ].join("\r\n"));
    const rejected = (await reboundReader.through(Buffer.from("\r\n\r\n"))).toString();
    assert.match(rejected, /^HTTP\/1\.1 403 /);
    rebound.destroy();

    // Browser is the source: WebSocket bytes reach an allowlisted TCP target
    // and the echo comes back as an unmasked binary WebSocket frame.
    const outbound = await connectWebSocket(httpAddress, "/v1/connect/echo");
    outbound.socket.write(maskedFrame(0x2, Buffer.from([1, 2]), false));
    outbound.socket.write(maskedFrame(0x0, Buffer.from([3, 4]), true));
    // TCP is free to coalesce the two WebSocket fragments before echoing.
    assert.deepEqual([...await readBinaryBytes(outbound.reader, 4)], [1, 2, 3, 4]);
    outbound.socket.destroy();

    // Browser is the target: a native TCP source is paired to /v1/accept.
    const inbound = await connectWebSocket(httpAddress, "/v1/accept");
    const native = await connect(ingressAddress);
    const nativeReader = new Reader(native);
    native.write(Buffer.from([5, 6, 7]));
    const toBrowser = await readFrame(inbound.reader);
    assert.equal(toBrowser.opcode, 0x2);
    assert.deepEqual([...toBrowser.payload], [5, 6, 7]);

    inbound.socket.write(maskedFrame(0x2, Buffer.from([8, 9, 10])));
    assert.deepEqual([...await nativeReader.exact(3)], [8, 9, 10]);
    inbound.socket.destroy();
    native.destroy();
  } finally {
    await relay.close();
    await closeServer(echo);
  }
});
