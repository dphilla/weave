# Reusable networking packages

Weave's JavaScript byte transports, headless WebRTC session,
WebSocket-to-duplex bridge, and native WebRTC sidecar are reusable networking
components. They do not import the migration engine, inspect Weave frames,
instantiate WebAssembly, or depend on a demo.

The packages are versioned `0.1.0` and can be packed and installed today. They
are not automatically published to a registry; publication remains a separate
release decision.

## Component boundaries

| Package | Owns | Deliberately does not own |
|---|---|---|
| `@weave-net/browser-transports` | Bounded WebSocket and reliable ordered RTCDataChannel byte streams | PeerConnection setup, signaling, ICE/TURN, discovery, or application framing |
| `@weave-net/webrtc-session` | One fixed-role initial offer/answer, trickled ICE ordering, raw DataChannels, connection lifecycle, and selected-path diagnostics | Signaling transport, rooms, authentication, retry, STUN/TURN provisioning, application channel policy, bytes, media, or renegotiation |
| `@weave-net/node-transports` | Bounded Node TCP streams, finite dialing, and optional first-byte classification | Application protocols, listeners, routing, admission, or migration |
| `@weave-net/ws-tcp-gateway` | Byte-transparent, backpressured bridging between a normalized binary WebSocket and a Node duplex | WebSocket handshakes, TCP dialing, routes, target selection, static files, or authentication |
| `sidecars/webrtc` (`weave-rtc`) | One native Pion PeerConnection, fixed-role offer/answer and trickled ICE, 1–8 policy-declared DataChannels, and binary DataChannel ↔ loopback TCP bridges | Rendezvous, signaling transport, identity, authorization, TURN credential minting, pooling, retry, ICE restart, or application framing |

Every package is dependency-free ESM with TypeScript declarations, an Apache
2.0 license, explicit Node compatibility metadata, focused tests, and a
restricted package file list. The sidecar is instead a standalone Go module;
its Pion dependency is confined to `sidecars/webrtc` and is not linked into any
Weave runtime adapter or JavaScript package.

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

## Headless WebRTC session

`@weave-net/webrtc-session` establishes a raw DataChannel session without a
DOM, server route, or signaling dependency:

```js
import { WebRTCSession } from "@weave-net/webrtc-session";

const session = new WebRTCSession({
  role: "offerer",
  rtcConfiguration: { iceServers },
  sendSignal(message, { signal }) {
    return rendezvous.send(message, { signal });
  },
  onDataChannel(channel) {
    application.acceptChannel(channel);
  },
});

// Install the application's receive path before negotiation can produce a
// response.
rendezvous.onMessage((message) => session.receiveSignal(message));

session.createDataChannel("files", {
  ordered: true,
  protocol: "files.v1",
});
await session.start();
await session.connected;
```

An answerer uses the same constructor with `role: "answerer"` and receives
the offerer's channels through `onDataChannel`. The package serializes
concurrent inbound signaling, sends the local description before every
candidate, preserves candidate FIFO including the null end marker, and bounds
candidates received before remote SDP. It accepts the complete caller-owned
`rtcConfiguration` and supplies no default public STUN or TURN service.

The v0.1 session performs exactly one fixed-role negotiation. It does not
implement perfect negotiation/glare, renegotiation, ICE restart, multiparty
topology, media tracks, or negotiated DataChannels. It returns raw channels;
compose a reliable ordered channel with `@weave-net/browser-transports` when
an exact byte stream is required. Signaling adapters remain responsible for
authenticated routing, retry/idempotency, rooms, discovery, and at-most-once
delivery.

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

## Native WebRTC sidecar

`weave-rtc` gives any native program a language-neutral WebRTC boundary
without requiring a Go binding:

```text
supervisor  -- bounded NDJSON on stdin/stdout -->  weave-rtc
native app  <------- raw loopback TCP --------->  weave-rtc  <=> DataChannel
```

One process owns one PeerConnection. Its supervisor selects a fixed
`offerer` or `answerer` role, supplies the complete ICE configuration, and
declares one to eight channel mappings before negotiation. Each mapping names
an expected reliable, ordered, in-band-negotiated DataChannel and either:

- opens a single-admission loopback TCP listener; or
- dials a literal loopback TCP target.

A dial mapping can connect when its DataChannel opens or on the first
non-empty binary message. The latter is useful when a channel is negotiated
early but the local protocol gives a newly accepted connection a short
first-byte deadline. Zero-length messages are byte-stream no-ops. Text
DataChannel messages, unexpected labels/protocols, unordered or partially
reliable channels, and non-loopback mappings are rejected.

The control stream is `webrtc-sidecar.control.v1`: newline-delimited JSON with
a one-MiB record limit, strict UTF-8/JSON, correlated request IDs, and
monotonically sequenced events. It carries `start`, WebRTC signal envelopes,
status, per-channel close, and session close operations. SDP and ICE messages
are opaque to the supervisor's chosen rendezvous transport; migration or other
application bytes never enter the control stream. Standard output is protocol
only and diagnostics go to standard error.

The data bridge accepts binary messages of at most 64 KiB, fragments TCP
input into at most 16 KiB DataChannel messages, erases message boundaries in
the other direction, propagates bounded blocking backpressure, and closes both
ends of a mapping together. Mappings fail and close independently; fatal
PeerConnection, signaling, or control failures tear down the whole session.
Both local modes are intentionally one-shot in v0.1.

This boundary is generic: a Rust, C, Go, JavaScript, Python, or shell-adjacent
supervisor can speak the process protocol, and the bridged bytes could carry a
streaming or application protocol unrelated to Weave. It is not a generic
media server: it exposes reliable DataChannels, not audio/video tracks.

Loopback restriction limits accidental network exposure but does not prove
that the connecting process belongs to the same user. A hostile local process
can race a listener. Deployments that cross a trust boundary need an
authenticated local IPC design (for example, a token prelude or an OS-local
socket with peer credentials) in addition to remote peer identity and
workload authorization.

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
  webrtc-session/
  node-transports/
  ws-tcp-gateway/
sidecars/
  webrtc/               independent Go module and control-protocol tests
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

The reusable layers now extend from browser byte adapters through a headless
browser session and into a native DataChannel↔TCP sidecar. The sidecar is a
deliberately small transport primitive, not the universal overlay agent
described in [`../WEBRTC_OVERLAY.md`](../WEBRTC_OVERLAY.md): it does not own a
directory, NodeIDs, rendezvous, peer/workload authentication, TURN credential
provisioning, connection pooling, ICE restart, or migration-aware retry.

Those responsibilities should be added above this boundary as separately
reviewed components. Host-function/plugin state remains above networking as
well: WebRTC can move its bytes, but cannot define service compatibility,
restore semantics, activation, abort, or ownership fencing.
