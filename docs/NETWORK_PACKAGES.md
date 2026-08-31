# Reusable networking packages

Weave's JavaScript byte transports and WebSocket-to-duplex bridge are reusable
workspace packages. They move opaque bytes and do not import the migration
engine, inspect Weave frames, instantiate WebAssembly, or depend on a demo.

The packages are versioned `0.1.0` and can be packed and installed today. They
are not automatically published to a registry; publication remains a separate
release decision.

## Package boundaries

| Package | Owns | Deliberately does not own |
|---|---|---|
| `@weave-net/browser-transports` | Bounded WebSocket and reliable ordered RTCDataChannel byte streams | PeerConnection setup, signaling, ICE/TURN, discovery, or application framing |
| `@weave-net/node-transports` | Bounded Node TCP streams, finite dialing, and optional first-byte classification | Application protocols, listeners, routing, admission, or migration |
| `@weave-net/ws-tcp-gateway` | Byte-transparent, backpressured bridging between a normalized binary WebSocket and a Node duplex | WebSocket handshakes, TCP dialing, routes, target selection, static files, or authentication |

Every package is dependency-free ESM with TypeScript declarations, an Apache
2.0 license, explicit Node compatibility metadata, focused tests, and a
restricted package file list.

## Shared byte-stream contract

The browser and TCP adapters share the minimal structural interface used by
the Weave JavaScript migration engine:

```ts
interface ExactByteStream {
  readExact(size: number): Promise<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
}
```

`readExact` erases TCP, WebSocket-message, and DataChannel-message boundaries.
Applications that need records must add their own framing. Writes are ordered,
input is bounded, and transport-specific backpressure is propagated.

The browser streams additionally accept any `ArrayBuffer` or `ArrayBufferView`
on write and expose `opened` and `closed` lifecycle promises. `TcpTransport` is
already open when constructed (or when `connectTcp` resolves), and `close()`
destroys its socket.

This is a data-stream abstraction. It is not a WebRTC audio/video track API.

## Browser transports

Use a WebSocket without any application-specific protocol:

```js
import { connectWebSocket } from "@weave-net/browser-transports";

const stream = await connectWebSocket("wss://example.test/data");
await stream.write(payload);
const header = await stream.readExact(8);
```

Or adapt an RTCDataChannel that an application has already negotiated:

```js
import { RTCDataChannelByteStream } from "@weave-net/browser-transports";

const channel = peerConnection.createDataChannel("files", {
  ordered: true,
  protocol: "files.v1",
});
const stream = new RTCDataChannelByteStream(channel, {
  requiredProtocol: "files.v1",
  maxMessageSize: peerConnection.sctp?.maxMessageSize,
});
await stream.opened;
```

The generic package requests no WebSocket subprotocol by default and performs
RTC protocol validation only when `requiredProtocol` is a string. Passing
`null` explicitly disables that validation. RTC byte streams reject unordered
and partially reliable channels because they cannot satisfy exact-read
semantics.

The receive limit is applied before bytes reach pending readers, and an exact
read larger than the configured receive budget is rejected immediately.

## Node TCP transport

```js
import { connectTcp } from "@weave-net/node-transports";

const stream = await connectTcp("127.0.0.1", 9000, {
  connectTimeoutMs: 5_000,
  maxBufferedBytes: 8 * 1024 * 1024,
  readTimeoutMs: 30_000,
});
```

`TcpTransport` can also wrap an accepted `node:net.Socket`.
`readFirstSocketByte` is available for protocols that classify a shared
listener without consuming their discriminator. Socket creation and protocol
interpretation remain outside the package.

## Gateway core

Concrete Node WebSocket implementations expose incompatible receive and
backpressure APIs. The gateway therefore accepts a small normalized binary
endpoint rather than depending on one WebSocket library:

```ts
interface BinaryWebSocketEndpoint {
  readonly closed: boolean;
  once(event: "close" | "error" | "drain", listener: Function): unknown;
  off(event: "close" | "error" | "drain", listener: Function): unknown;
  setBinaryHandler(handler: ((bytes: Uint8Array) => boolean | void) | null): void;
  resumeIncoming(): void;
  sendBinary(bytes: Uint8Array): boolean;
  close(code?: number, reason?: string): unknown;
}
```

The demo's `ServerWebSocket` implements this boundary. Another project can
write a small adapter for its chosen WebSocket server and then bridge a
binary-mode Node duplex-like endpoint:

```js
import { bridgeWebSocketToDuplex } from "@weave-net/ws-tcp-gateway";

const bridge = bridgeWebSocketToDuplex(websocketEndpoint, duplex, {
  label: "transfer-42",
  closeTimeoutMs: 2_000,
  onError(error, { side }) {
    logger.error({ error, side });
  },
});
```

Backpressure travels in both directions. Closing either endpoint closes the
other; manual close is symmetric and idempotent. The bridge never parses or
reframes payload bytes. A Node stream passed to it must not have `setEncoding()`
enabled; non-`Uint8Array` chunks terminate the bridge as an endpoint error.

## Weave compatibility layer

Existing imports remain valid:

- `js/weave-browser.mjs` wraps the browser package with the `weave.v2`
  WebSocket/DataChannel defaults, Weave's maximum-frame write allowance, and
  the demo-specific `connectRelay`/`acceptRelay` helpers.
- `js/weave-node-transport.mjs` is a compatibility re-export of the Node
  package.
- `demos/browser-wamr/relay.mjs` retains routing, security policy, WebSocket
  framing, target dialing, and pairing while delegating byte bridging to the
  gateway package.

The browser demo servers expose the browser package source as an explicit
same-origin static route so the compatibility module works both as a normal
filesystem import and when served directly to a browser.

## Repository and CI organization

JavaScript workspace state is centralized:

```text
package.json
package-lock.json
packages/
  browser-transports/
  node-transports/
  ws-tcp-gateway/
.github/ci/
  run-unit.sh
  package-smoke.sh
```

Leaf manifests contain package metadata only. There are no leaf lockfiles or
runtime dependencies. CI commands remain under `.github/ci`.

Run package-focused unit tests from the repository root:

```sh
npm run test:packages
```

Prove that repository-relative imports did not leak into a distribution:

```sh
.github/ci/package-smoke.sh
```

That command packs every workspace, verifies its license and file boundary,
installs the tarballs into a fresh temporary consumer, and imports their public
entry points. `.github/ci/run-unit.sh js` runs both the product tests and this
clean-consumer check.

## Current stopping point

This extraction intentionally does not yet provide a reusable WebRTC dial or
accept API. The next milestone is the separately reviewed headless browser
session: PeerConnection lifecycle, offer/answer, trickle ICE, channel creation,
and an injected signaling interface with no DOM or Weave migration dependency.
