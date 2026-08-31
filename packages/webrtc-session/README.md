# `@weave-net/webrtc-session`

A dependency-free, headless WebRTC DataChannel session. It owns one initial
offer/answer exchange, trickled ICE ordering, connection lifecycle, and raw
DataChannel discovery while leaving signaling transport and application policy
to its caller.

The package contains no DOM, UI, media, Weave protocol, migration, byte-stream,
STUN/TURN provisioning, room, authentication, or server assumptions. Its
interfaces are structural, so tests and compatible non-browser WebRTC
implementations can inject their own `RTCPeerConnection` constructor.

## Install

```sh
npm install @weave-net/webrtc-session
```

Registry publication is not automated yet. From this checkout, create the same
installable artifact with `npm pack --workspace @weave-net/webrtc-session`, then
install the resulting `.tgz`.

## Offerer

The application owns signaling delivery. `sendSignal` publishes an opaque
session message through any chosen transport; received messages must be passed
to `receiveSignal()` in either role.

```js
import { WebRTCSession } from "@weave-net/webrtc-session";

const session = new WebRTCSession({
  role: "offerer",
  rtcConfiguration: {
    iceServers: [{ urls: "stun:stun.example.net" }],
  },
  async sendSignal(message, { signal }) {
    await signaling.send(message, { signal });
  },
  onDataChannel(channel, { origin }) {
    console.log(origin, channel.label);
  },
});

const channel = session.createDataChannel("files", {
  ordered: true,
  protocol: "example.files.v1",
});

signaling.onMessage = (message) => session.receiveSignal(message);
await session.start();
await session.connected;
channel.send(fileChunk);
```

Offerer-created channels must be registered before `start()`. Duplicate labels
and `negotiated: true` channels are rejected. Other DataChannel choices are
passed through unchanged: this package does not require reliable or ordered
delivery, so an application can use unordered or partially reliable channels.

## Answerer

An answerer creates no channels through the session. It receives the offerer's
in-band-negotiated channels through `onDataChannel` and automatically sends the
answer after applying the offer and any earlier queued candidates.

```js
const answerer = new WebRTCSession({
  role: "answerer",
  rtcConfiguration,
  sendSignal: (message, { signal }) => signaling.send(message, { signal }),
  onDataChannel(channel, { origin, session }) {
    if (origin !== "remote") throw new Error("unexpected local channel");
    attachApplicationProtocol(channel);
    console.assert(session.channel(channel.label) === channel);
  },
});

signaling.onMessage = (message) => answerer.receiveSignal(message);
await answerer.start();
await answerer.connected;
```

`onDataChannel` receives the raw channel as soon as it is announced. Opening,
message handling, application subprotocol validation, and conversion to a byte
stream remain separate concerns.

## Signaling contract

The package emits and accepts exactly two JSON-compatible envelope shapes:

```ts
type WebRTCSessionSignal =
  | { type: "description"; description: { type: "offer" | "answer"; sdp: string } }
  | { type: "candidate"; candidate: RTCIceCandidateInit | null };
```

The signaling service can use HTTP, WebSocket, a database, a copied string, or
another mechanism. It must route messages to the intended peer. The session
serializes outbound `sendSignal` calls, sends its description first, then
publishes candidates in gathering order, including the `null`
end-of-candidates marker. Concurrent `receiveSignal()` calls are also applied
sequentially.

`sendSignal` receives the session's lifetime `AbortSignal`. Implementations
should use it to cancel active requests and retry delays. Delivery-level retry,
deduplication, authentication, room membership, and replay protection belong to
the signaling implementation. Applying an SDP description is not generally
replay-safe, so this package rejects a second remote description instead of
attempting renegotiation.

## Bounds and lifecycle

| Export / option | Default | Meaning |
| --- | ---: | --- |
| `DEFAULT_CONNECT_TIMEOUT_MS` | 30 s | Overall deadline to reach `connected`; `0` disables |
| `DEFAULT_MAX_PENDING_CANDIDATES` | 256 | Maximum queued local or pre-description remote candidates |
| `DEFAULT_MAX_SDP_BYTES` | 256 KiB | Maximum UTF-8 bytes in an SDP string |
| `DEFAULT_MAX_CANDIDATE_BYTES` | 16 KiB | Maximum serialized bytes in one ICE candidate |

The session states are:

```text
new → starting → connecting → connected ⇄ disconnected
                    │              │
                    └──────→ failed/closed
```

`disconnected` is recoverable; the browser may return to `connected`. A failed
PeerConnection, signaling send/apply error, invalid or oversized signal,
timeout, explicit `fail()`, or external abort is terminal.

`connected` resolves with the session when the PeerConnection reaches
`connected`, and rejects if the session terminates first. It says nothing about
whether a particular DataChannel is open. `closed` always resolves with
`{ reason: "closed" | "failed", error }`. `close()` is idempotent and returns
that same promise. It aborts pending signaling, removes listeners, clears the
deadline, and closes the PeerConnection.

Callbacks are observational. Exceptions from state, channel, ICE-diagnostic,
or error callbacks do not interrupt session cleanup. `onError` receives
`{ fatal, phase, session }`; an `icecandidateerror` is reported as nonfatal
because other candidates may still establish a path.

## Selected path diagnostics

```js
import { getSelectedCandidatePath } from "@weave-net/webrtc-session";

const path = await getSelectedCandidatePath(session);
// {
//   relayed: false,
//   protocol: "udp",
//   localCandidateType: "host",
//   remoteCandidateType: "srflx"
// }
```

The helper reports only candidate types and transport protocol. It deliberately
does not return candidate addresses, ports, or other address-bearing RTCStats
fields. It returns `null` when no selected or nominated successful candidate
pair can be found.

## Scope and security

Version 0.1 performs one fixed-role, initial negotiation. It intentionally does
not implement glare handling, perfect negotiation, renegotiation, ICE restart,
negotiated DataChannels, media tracks, or a signaling receive loop.

WebRTC encrypts the peer connection, but signaling still carries the DTLS
fingerprint. TLS and signaling access control do not by themselves protect
against a signaling service that substitutes descriptions. Applications that
need peer identity must bind and verify identity outside this package. TURN
credentials and ICE server policy also remain deployment responsibilities.

## Development

From the repository root:

```sh
npm run test:packages
.github/ci/package-smoke.sh
```

The package has no runtime dependencies. Test orchestration and the workspace
lockfile remain centralized at the repository root. It is licensed under
Apache-2.0.
