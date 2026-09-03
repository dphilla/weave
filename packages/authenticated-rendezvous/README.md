# `@weave-net/authenticated-rendezvous`

Dependency-free, browser-safe primitives for authenticating capability-scoped
rendezvous signaling across an untrusted, replaceable message transport.

The package provides self-certifying Ed25519 NodeIDs, exact issuer-signed
connection capabilities, peer-signed/hash-chained signal envelopes, bounded
validation, and an in-memory replay guard. It imports neither WebRTC nor the
Weave migration engine. A non-null `message` accepted by the stateful session
API can therefore be handed to `@weave-net/webrtc-session`, the generic
`weave-rtc` supervisor boundary, or another WebRTC signaling consumer.
Application protocols run over the resulting WebRTC data plane.

It is not a hosted rendezvous service. It contains no HTTP/WebSocket routes,
directory, capability-approval service, TURN credentials, UI, media stack, or
concrete mailbox transport.

## Install

```sh
npm install @weave-net/authenticated-rendezvous
```

Registry publication is not automated yet. From this checkout, create the same
installable artifact with:

```sh
npm pack --workspace @weave-net/authenticated-rendezvous
```

The source is ESM and uses the
[Web Cryptography API](https://www.w3.org/TR/webcrypto-2/), `TextEncoder`, and
`TextDecoder`. A compatible `crypto` provider can be injected; browsers
normally use `globalThis.crypto`. Private keys remain in non-extractable
`CryptoKey` objects by default. Node 18 consumers should import `webcrypto`
from `node:crypto` and pass it as the `crypto` option when the global Web
Crypto API is not enabled.

## Security model

V1 assumes the rendezvous transport can read, delay, drop, duplicate, reorder,
or replace messages. A correct endpoint verifies all of the following before
passing a message to WebRTC:

- the sender public key derives the claimed `wn1-` NodeID;
- the Ed25519 peer signature covers the complete canonical signal, including
  the exact SDP or ICE object;
- a locally trusted issuer signed the capability;
- subject, audience, session, role, action, resource, application protocol,
  channels, service, profile, limits, privacy, and time all match policy;
- sequence, predecessor hash, duplicate, fork, and single-use replay state are
  valid; and
- the application explicitly confirms that the full signed session policy was
  translated into its effective ICE/TURN path, live channels, application
  scope, and connection lifetime.

A capability is not a bearer identity: signaling also requires the matching
participant private key. Conversely, a valid NodeID signature is not workload
authorization without the capability.

Signatures authenticate but do not hide signaling. V1 supports only
`rendezvous-visible`; SDP, ICE candidates, NodeIDs, capability claims, timing,
and sizes may be visible to the mailbox operator. End-to-end sealed signaling,
delegated online keys, durable replay storage, revocation distribution, and
media authorization are explicitly future protocols. The object-taking
`verifyConnectionCapability()` and `verifySignalEnvelope()` functions validate
already-decoded values but do not, by themselves, provide the complete
stateful authorization decision. Use canonical-byte verification at untrusted
wire boundaries and `AuthenticatedSession.inbound()` before applying signaling.

## Transport boundary

Applications inject a structural transport with operations equivalent to:

```ts
interface RendezvousTransport {
  publish(
    canonicalEnvelope: Uint8Array,
    options: {
      recipient: NodeID;
      idempotencyKey?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ accepted: true; duplicate: boolean; cursor?: string }>;

  receive(options: {
    recipient: NodeID;
    cursor?: string;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<{ envelopes: Uint8Array[]; cursor: string }>;
}
```

Cursors and transport idempotency are delivery conveniences, not security
state. Endpoints still verify signatures, capability scope, sequence, chain,
and replay state. Untrusted records enter through the bounded canonical-byte
parser; ordinary `response.json()` loses duplicate-member and noncanonical-wire
evidence. Retries publish the exact same bytes rather than re-signing the same
sequence. `recipient` is an untrusted routing hint that lets the transport stay
opaque; the endpoint still requires it to agree with the signed envelope.
Capability issuance and delivery are a separate authorization-plane concern,
not an operation of this signaling transport interface.

## Compose it with WebRTC

The capability request and the local policy are deliberately separate. Do not
build the expected policy by copying an unverified capability: obtain the
expected session, operation, resource, channels, and privacy mode from trusted
application state, then compare every field while creating the session.
Issuance likewise requires explicit privacy, limits, actor, `onBehalfOf`, and
the other application-policy claims; it does not silently choose those
security decisions. The exported `DEFAULT_MAX_SIGNALS`,
`DEFAULT_MAX_SIGNAL_BYTES`, and `DEFAULT_MAX_SESSION_DURATION_MS` constants are
recommendations a caller may place into the required `limits` object; the
issuer does not insert them implicitly.
The package checks that comparison but cannot inspect live DataChannels or
application bytes. The WebRTC/application layer must configure and reject
actual channels using the same accepted label and protocol, independently
enforce `action`, `resource`, `applicationProtocol`, `serviceId`, `profile`,
and any reliability policy, and close the real PeerConnection/DataChannels by
the session deadline. `maxSessionDurationMs` alone only rejects later calls to
this package; it is not a timer on an established connection.
Calling `session.close()` or crossing `session.deadline` also prevents an
in-flight package operation from committing its sequence/hash state after an
asynchronous boundary. It cannot cancel or undo an external signer, replay
store, or application handler already executing, so integrations must
propagate their own abort signal to that work. Once a replay-store call or
message handler can have an irreversible effect, any later pre-commit failure
also closes the session; this prevents different content from reusing its
uncommitted sequence number.

SDP is authenticated but otherwise opaque to this package. A DataChannel-only
composition must reject descriptions containing media sections other than its
expected `m=application` section before calling `setRemoteDescription`.
Neither the capability's channel list nor `enforceSessionPolicy` parses SDP for
the application.

The privacy token also needs concrete integration semantics. `relay-only`
requires relay-only ICE plus an effective selected-path check;
`organization-only` and `offline-local` must be rejected unless the accepted
application profile defines the relevant network boundary and enforcement
rules.

```js
import {
  createAuthenticatedSession,
  digestSignalEnvelope,
  encodeBase64Url,
  generateNodeIdentity,
  InMemoryReplayStore,
  issueConnectionCapability,
  serializeSignalEnvelope,
} from "@weave-net/authenticated-rendezvous";

const [issuer, offererIdentity, answererIdentity] = await Promise.all([
  generateNodeIdentity(),
  generateNodeIdentity(),
  generateNodeIdentity(),
]);

const now = Date.now();
const policy = {
  sessionId: encodeBase64Url(crypto.getRandomValues(new Uint8Array(24))),
  action: "example.stream.open",
  resource: "urn:example:stream:42",
  applicationProtocol: "example.stream.v1",
  channels: [{ label: "stream", protocol: "example.stream.v1" }],
  privacy: "direct-preferred",
  signalingVisibility: "rendezvous-visible",
  limits: {
    maxSignals: 256,
    maxSignalBytes: 256 * 1024,
    maxSessionDurationMs: 5 * 60_000,
  },
  actor: "principal:operator-7",
  onBehalfOf: null,
  serviceId: "example:stream-service",
  profile: "reliable-byte-stream.v1",
};

const capability = await issueConnectionCapability({
  ...policy,
  subject: offererIdentity.nodeId,
  audience: answererIdentity.nodeId,
  issuedAt: now,
  notBefore: now,
  expiresAt: now + 5 * 60_000,
}, issuer);

// Keep one store for all authenticated sessions owned by this endpoint.
const replayStore = new InMemoryReplayStore();
const offerer = await createAuthenticatedSession({
  ...policy,
  capability,
  identity: offererIdentity,
  peerNodeId: answererIdentity.nodeId,
  role: "offerer",
  trustedIssuers: [issuer.nodeId],
  replayStore,
  // This example supports only its exact permissive path mode. A relay-only,
  // organization-only, or offline-local product must configure and validate
  // the corresponding PeerConnection, ICE servers, and candidate filtering.
  // This is a trusted cross-layer assertion: the supervisor must also map the
  // signed application/channel fields to the live data plane and arrange to
  // close that data plane at `deadline`.
  enforceSessionPolicy: ({ privacy, capability, deadline }) => {
    scheduleConnectionClose(deadline);
    return privacy === "direct-preferred" &&
      capability.profile === "reliable-byte-stream.v1";
  },
});

// Give the signed envelope to any application-supplied RendezvousTransport.
const envelope = await offerer.outbound({
  type: "description",
  description: { type: "offer", sdp: localOfferSdp },
});
const wire = serializeSignalEnvelope(envelope, {
  maxSignalBytes: policy.limits.maxSignalBytes,
});
await transport.publish(wire, {
  recipient: answererIdentity.nodeId,
  idempotencyKey: await digestSignalEnvelope(envelope),
});
```

The answerer creates its own authenticated session with the same trusted
policy, `role: "answerer"`, and reversed local/peer identities. For every
received canonical byte record it calls `answerer.inbound(bytes)`. A new
accepted record returns `{ message, duplicate: false }`; an exact transport
retry returns
`{ message: null, duplicate: true }`, so the signaling object is never applied
to WebRTC twice. The first fully verified/generated offer atomically binds the
single-use capability in `compareAndReserve()` replay state. A conflicting
offer fails closed; a new session does not resume from a matched reservation
without separately persisted chain state.

In a real composition, first apply the trusted profile's SDP/candidate policy,
then pass a verified non-null `message` to `WebRTCSession.receiveSignal()` or
the native sidecar's `signal` command, and wrap each outbound raw signal with
`session.outbound()`. Publish retries reuse the same canonical bytes. The
current browser and sidecar helpers do not supply this authenticated-profile
policy adapter for you.

## Protocol and product guidance

The exact wire schema, signing inputs, limits, errors, and conformance-vector
format are normative in the repository's
[rendezvous specification](https://github.com/dphilla/weave/blob/main/docs/RENDEZVOUS.md).
Human, CLI, server, and agent consumption—including the distinction between
modality-neutral rendezvous and actual audio/video support—is covered in the
[consumption guide](https://github.com/dphilla/weave/blob/main/docs/RENDEZVOUS_CONSUMPTION.md).

Canonical JSON follows [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html),
base encodings follow [RFC 4648](https://www.rfc-editor.org/rfc/rfc4648.html),
and signatures use Ed25519 as specified by
[RFC 8032](https://www.rfc-editor.org/rfc/rfc8032.html).
The installable golden vector is exported as
`@weave-net/authenticated-rendezvous/vectors/v1.json`.

## Development

Run package tests and the clean-consumer package check from the repository
root:

```sh
npm run test:packages
.github/ci/package-smoke.sh
```

CI orchestration and the only JavaScript lockfile remain centralized at the
repository root. This package has no runtime dependencies and is licensed
under Apache-2.0.
