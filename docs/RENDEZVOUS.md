# Authenticated rendezvous protocol v1

> **Status:** Normative specification for the implemented v1 authentication
> package. Sections explicitly labeled **Future work** are not part of v1.

Authenticated rendezvous carries short-lived WebRTC signaling between two
cryptographic node identities. It authenticates the peers, binds a narrowly
scoped connection capability to one session, and, when used through the
authenticated-session state machine with shared replay state, detects replay,
reordering, and signaling substitution even when the rendezvous transport is
not trusted. The implemented protocol identifier is `weave-rendezvous.v1`.

It does not carry application bytes and does not interpret `weave.v2`:

```text
browser WebRTCSession or native supervisor
                  |
       authenticated rendezvous v1
                  |
       replaceable message transport
                  |
       authenticated rendezvous v1
                  |
browser WebRTCSession or native supervisor
                  |
           WebRTC data plane
                  |
       application-defined bytes
```

For a native peer, a verified inbound signal is passed unchanged to the
generic `weave-rtc` sidecar's `signal` command. A sidecar `signal` event is
wrapped and signed before it is published. The sidecar remains unaware of
NodeIDs, issuers, capabilities, directories, or rendezvous transports.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**,
and **MAY** are to be interpreted as described by
[BCP 14](https://www.rfc-editor.org/rfc/rfc2119.html) when they appear in
uppercase.

## Implemented v1 and future work

Implemented v1 provides:

- stable, self-certifying `wn1-` NodeIDs derived from Ed25519 public keys;
- direct Ed25519 signing by the NodeID key;
- issuer-signed, source/target/session-bound connection capabilities;
- peer-signed signaling envelopes with per-sender sequence and hash chains;
- deterministic RFC 8785 JSON canonicalization and fixed domain separation;
- strict schema, time, size, identity, and capability validation, including
  bounded canonical-byte verification entry points;
- an authenticated-session state machine that atomically binds each capability
  to its first offer digest through a shared replay store;
- an in-memory replay store implementing both one-time claims and atomic
  compare-and-reserve; and
- a byte-oriented structural transport interface that can be implemented
  without WebRTC or Weave dependencies.

The following are deliberately **not** implemented by v1:

- root-signed online signing-key credentials or key delegation;
- X25519 agreement keys or HPKE-sealed signaling;
- durable or distributed replay storage, and authenticated-session state
  recovery after a process restart;
- a hosted HTTP, WebSocket, database, or federated rendezvous service;
- directory/name resolution, account identity, human approval, or issuer PKI;
- revocation distribution, TURN credential minting, or connection pooling;
- authenticated local attachment to a native sidecar; or
- media-track authorization, renegotiation, or ICE restart.

Those features MUST NOT be inferred from the v1 fields. A future feature that
changes signed semantics requires a new version or a separately specified,
fail-closed extension.

## Trust model

V1 distinguishes four identities:

- A **NodeID** identifies one cryptographic endpoint key.
- An **issuer NodeID** is a NodeID locally trusted to issue connection
  capabilities. Being syntactically valid does not make an issuer trusted.
- `actor` and `onBehalfOf` describe the principal and delegation context used
  for policy and audit. They are not NodeIDs unless an application explicitly
  defines them that way.
- `serviceId`, `profile`, `action`, and `resource` identify the requested
  application authority. Human-readable names are non-authoritative metadata
  outside this protocol.

Each verifier has a local set of trusted issuer NodeIDs. That trust set MUST
come from configuration or another authenticated system, not from the
rendezvous service or the capability being verified.

The rendezvous transport is an untrusted, availability-only mailbox. It may
observe, delay, drop, duplicate, reorder, or replace records. Correct peers
detect forged, altered, replayed, misordered, expired, or misrouted records.
They cannot force the service to deliver a record.

V1 additionally trusts:

- endpoint private keys and the process using them;
- issuer private keys and issuer policy;
- a cryptographically secure random-number generator;
- the verifier's clock within its configured skew allowance; and
- replay state for as long as that state remains available.

## Primitive encodings

### Base64url

`publicKey`, `signature`, record identifiers, and digest suffixes use the URL-
safe alphabet from RFC 4648 section 5 without `=` padding. Decoders MUST reject
padding, whitespace, non-alphabet characters, and encodings that are not the
canonical encoding of the decoded bytes.

### Base32

NodeIDs use lowercase RFC 4648 base32 without `=` padding. Decoders MUST reject
uppercase input, padding, whitespace, and noncanonical encodings.

### Time

All time fields are integer Unix milliseconds. They MUST be JSON safe integers
and MUST NOT be negative. Each low-level capability or signal verifier MUST
obtain one current-time snapshot so a clock change cannot split that verifier's
decision. The stateful authenticated session intentionally obtains a new
snapshot after asynchronous signing, hashing, replay-store, and handler
boundaries; those later samples are commit barriers, not part of the earlier
cryptographic verification snapshot.

### Canonical JSON

Signed values use the JSON Canonicalization Scheme from
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html). Implementations MUST:

- reject invalid UTF-8, duplicate members, unknown members, trailing input,
  and values outside the declared schema;
- reject lone Unicode surrogates and non-finite numbers;
- enforce integer fields before canonicalization;
- apply byte limits to UTF-8 or canonical bytes, as specified below; and
- produce the same RFC 8785 bytes independent of member insertion order.

Ordinary `JSON.stringify` output is not a signing format. Ordinary `JSON.parse`
or `Response.json()` is not a conforming untrusted-wire parser either: parsing
first destroys evidence of duplicate members and noncanonical spellings.

A JavaScript byte transport MUST retain received records as bytes. A capability
is verified with `verifyConnectionCapabilityBytes`, which applies the 16 KiB
outer limit and strict canonical parse before normal verification. A signal is
verified with `verifySignalEnvelopeBytes`, which applies the verified
capability's `maxSignalBytes + 64 KiB` envelope limit; the absolute maximum is
320 KiB. `session.inbound` selects this byte verifier automatically for a
string, `ArrayBuffer`, or array-buffer view, so a transport's `Uint8Array`
should be passed directly to it.

At their respective byte boundaries, applications MUST publish records through
their record-specific serializers: `serializeConnectionCapability(capability)`
for a capability and `serializeSignalEnvelope(envelope, { maxSignalBytes })`
for a signal. The signal serializer's bound SHOULD be the verified capability's
`limits.maxSignalBytes`. Generic `canonicalizeJsonBytes` and ordinary
`JSON.stringify` do not by themselves validate a protocol record's exact schema
or protocol-specific bound.

The object-taking verification functions and object form of `session.inbound`
are for trusted in-memory composition after a strict byte boundary. They do not
recover canonical-wire evidence from an object produced by another JSON parser.
An application receiving a capability as bytes SHOULD verify it with
`verifyConnectionCapabilityBytes` before passing the returned frozen
`capability` object into `createAuthenticatedSession`.

## NodeID

An Ed25519 public key is represented as its 32-byte raw public-key value. Its
NodeID is:

```text
"wn1-" || base32lower_no_pad(SHA-256(raw_public_key))
```

The result matches:

```text
^wn1-[a-z2-7]{52}$
```

Every signed v1 record carries the signer's raw public key as canonical
unpadded base64url. Verification MUST:

1. decode exactly 32 bytes;
2. derive the NodeID using the formula above;
3. compare the derived and asserted NodeIDs exactly; and
4. only then use the key to verify the signature.

This makes the identifier self-certifying while retaining an explicit
algorithm/version prefix. It does not make an issuer trusted.

A NodeID is stable while its private key remains stable. Replacing that key
creates a different NodeID. V1 defines no key-rotation statement that makes
two NodeIDs equivalent.

## Identifiers

`id` and `sessionId` are unpadded canonical base64url values decoding to 16
through 48 bytes. Generators use 24 cryptographically random bytes by default.
Identifiers are opaque and MUST be compared byte-for-byte after canonical
encoding validation. A room name, HTTP request ID, transport cursor, or human
label is not a session identifier.

## Connection capability

A capability is a single-use authorization for one source NodeID to establish
one session with one target NodeID. Every field is REQUIRED. `onBehalfOf` uses
JSON `null`, not an omitted member, when there is no delegating principal.

```json
{
  "v": 1,
  "type": "capability",
  "id": "<16..48 random bytes as base64url>",
  "issuer": "wn1-…",
  "issuerPublicKey": "<32 raw Ed25519 bytes as base64url>",
  "subject": "wn1-…",
  "audience": "wn1-…",
  "sessionId": "<16..48 random bytes as base64url>",
  "action": "weave.migration.receive",
  "resource": "urn:weave:workload:sha256:…",
  "applicationProtocol": "weave.v2",
  "channels": [
    {"label": "weave-to-native", "protocol": "weave.v2"}
  ],
  "privacy": "direct-preferred",
  "signalingVisibility": "rendezvous-visible",
  "limits": {
    "maxSessionDurationMs": 600000,
    "maxSignals": 512,
    "maxSignalBytes": 262144
  },
  "actor": "principal:deployment-controller",
  "onBehalfOf": null,
  "serviceId": "weave:migration",
  "profile": "reliable-byte-stream.v1",
  "issuedAt": 1788192000000,
  "notBefore": 1788192000000,
  "expiresAt": 1788192300000,
  "singleUse": true,
  "signature": "<64 Ed25519 signature bytes as base64url>"
}
```

Field semantics:

| Field | Normative meaning |
|---|---|
| `v`, `type` | Exactly `1` and `capability`. |
| `id` | Globally unpredictable capability identifier. |
| `issuer` | NodeID whose key signed the capability and which must be locally trusted. |
| `issuerPublicKey` | Raw Ed25519 public key that MUST derive `issuer`. |
| `subject` | The only NodeID allowed to initiate the session. It MUST differ from `audience`. |
| `audience` | The exact target NodeID. It MUST differ from `subject`. |
| `sessionId` | The only signaling session in which the capability is valid. |
| `action` | Exact namespaced operation. V1 has no wildcard or prefix matching. |
| `resource` | Exact application resource identifier. Its internal syntax is application-defined. |
| `applicationProtocol` | Exact protocol to be carried after connection establishment. |
| `channels` | Complete authorized DataChannel label/protocol set. Order is significant for signatures but not authorization-set comparison. The package compares this set; the WebRTC supervisor enforces it on actual channels. |
| `privacy` | Exact network-policy selector: `direct-preferred`, `relay-only`, `organization-only`, or `offline-local`. Enforcement requirements follow below. |
| `signalingVisibility` | Exactly `rendezvous-visible` in implemented v1. |
| `limits` | Complete authorized resource limits; unsupported members are invalid. The package enforces signaling bounds, while the integration enforces live-data-plane obligations. |
| `actor` | Stable principal identifier for policy and audit. It is not a display name. |
| `onBehalfOf` | Stable delegating-principal identifier, or `null`. |
| `serviceId` | Exact service identity being contacted. |
| `profile` | Exact connection/application profile. |
| `issuedAt` | Issuance time. |
| `notBefore` | Earliest accepted verification time, subject to configured skew; it MUST be no earlier than `issuedAt`. Session operations use the unskewed value. |
| `expiresAt` | Exclusive end of the verification window, subject to configured skew; it MUST be later than `notBefore`. Session operations use the unskewed value. |
| `singleUse` | Exactly `true` in v1. |
| `signature` | Issuer signature defined below. |

An authorizer MUST compare every expected security field, including subject,
audience, session, action, resource, application protocol, channel set,
privacy, service, and profile. It MUST NOT authorize from a valid signature
alone. It MUST reject a limit it cannot enforce.

Privacy selectors have these v1 requirements:

- `direct-preferred` permits direct and relayed ICE candidates. It acknowledges
  that a selected direct path can disclose peer network addresses; it does not
  guarantee that ICE will select a direct path.
- `relay-only` permits only relay candidates and requires the supervisor to
  configure relay-only gathering/use and reject or close a connection whose
  effective selected path is not relayed.
- `organization-only` is usable only with an exact application `profile` that
  defines the trusted organization, acceptable address ranges or relay
  operators, and how the selected path is checked.
- `offline-local` is usable only with an exact application `profile` that
  defines the local-network boundary and offline signaling exchange; it MUST
  use no Internet rendezvous, STUN, or TURN service.

The last two tokens do not define a universal organization or local-network
boundary by themselves. An integration lacking the corresponding profile and
enforcement machinery MUST reject them. `enforceSessionPolicy` affirms both
initial configuration and the supervisor's obligation to check the eventual
selected path and close it on violation.

The exact `limits` members and their v1 bounds are listed in [Limits](#limits).
Expiry authorizes signaling and connection establishment. It does not itself
prove that a previously established application operation completed safely.

### Capability signing and digest

Let `unsigned` be the capability object with the `signature` member entirely
omitted. The exact signature input is:

```text
UTF8("weave.rendezvous.capability.v1\0") || JCS(unsigned)
```

Here `\0` is one literal zero byte. There is no length prefix, newline, or
additional separator. `signature` is the unpadded base64url encoding of the
64-byte Ed25519 signature over those bytes.

The capability digest is:

```text
"sha256-" || base64url_no_pad(SHA-256(JCS(complete_capability)))
```

`complete_capability` includes `signature`. Consumers MUST recompute the
digest instead of trusting a supplied digest.

## Signaling envelope

Each peer wraps every existing WebRTC signaling object in a signed envelope.
The `message` is the same JSON-compatible description or candidate envelope
accepted by `@weave-net/webrtc-session` and the native sidecar; authenticated
rendezvous does not rewrite it.

```json
{
  "v": 1,
  "type": "signal",
  "sessionId": "<capability sessionId>",
  "capabilityDigest": "sha256-…",
  "from": "wn1-…",
  "fromPublicKey": "<32 raw Ed25519 bytes as base64url>",
  "to": "wn1-…",
  "role": "offerer",
  "seq": 0,
  "prev": null,
  "issuedAt": 1788192001000,
  "expiresAt": 1788192031000,
  "message": {
    "type": "description",
    "description": {"type": "offer", "sdp": "…"}
  },
  "signature": "<64 Ed25519 signature bytes as base64url>"
}
```

Rules:

- `v` and `type` are exactly `1` and `signal`.
- `sessionId` and `capabilityDigest` MUST equal the verified capability.
- `from` and `to` MUST be the capability subject and audience in the expected
  direction.
- `fromPublicKey` MUST derive `from`.
- `role` is `offerer` or `answerer`; the subject is the offerer and audience is
  the answerer in v1.
- `seq` is a nonnegative safe integer. It begins at zero independently for
  each sender and increments by exactly one.
- `prev` is `null` at sequence zero. Otherwise it is the digest of the
  immediately preceding complete signed envelope from that sender.
- Sequence zero MUST contain the sender's one session description: `offer` for
  the offerer and `answer` for the answerer. Later messages MAY contain ICE
  candidates but MUST NOT contain another description. A null candidate is the
  end-of-candidates marker; that sender MUST NOT send another candidate after
  it. A non-null candidate object MUST contain a non-empty `candidate` string;
  an empty string is not an alternate end marker in v1.
- `issuedAt` MUST be no earlier than capability `notBefore` and no later than
  capability `expiresAt`, before configured skew is applied.
- `expiresAt` MUST be no later than capability `expiresAt` and strictly later
  than `issuedAt`. A signal lifetime MUST NOT exceed 60 seconds.
- `message` MUST satisfy the configured signal codec and its byte limits.

The sender signs the complete, exact SDP string. Consequently, the DTLS
fingerprint inside SDP is bound to the sender's NodeID; a rendezvous operator
cannot substitute it without invalidating the signature. The WebRTC DTLS
handshake then proves possession of the corresponding DTLS certificate key.

### Signal signing and digest

Let `unsigned` be the signal envelope with `signature` entirely omitted. The
exact signature input is:

```text
UTF8("weave.rendezvous.signal.v1\0") || JCS(unsigned)
```

`signature` is the canonical unpadded base64url encoding of the 64-byte
Ed25519 result.

The signal digest used by `prev` and idempotency is:

```text
"sha256-" || base64url_no_pad(SHA-256(JCS(complete_signal)))
```

The complete signal includes its signature.

## Replay, order, and session state

Verification order is security-sensitive. `createAuthenticatedSession` first
validates the local identity, verifies the capability and every explicit local
policy field, computes the session deadline, and invokes the required
`enforceSessionPolicy` callback. Construction does not consume the capability.
Unless capability consumption is explicitly disabled, the caller MUST supply
one shared replay store implementing both `claim` and `compareAndReserve`.

For each inbound envelope, a receiver MUST:

1. enforce the outer byte limit and strict schema;
2. validate canonical scalar encodings and time ranges;
3. verify `fromPublicKey` derives `from`;
4. verify the peer signature;
5. verify capability signature, trusted issuer, identity, session, grant,
   channel, privacy, time, and digest bindings;
6. validate duplicate status, `seq`, `prev`, and description/candidate state;
7. atomically compare-and-reserve the first offer binding, or claim the digest
   of a later accepted signal, in replay state; and
8. only then return `message` to WebRTC or invoke its consumer.

For each `(sessionId, from)` pair, replay state records sequence number and
complete signal digest. The following outcomes are distinct:

- the same sequence with the same digest is an idempotent duplicate and returns
  `message: null` with `duplicate: true` from `session.inbound`;
- the same or an older sequence with a different digest fails with
  `ERR_RENDEZVOUS_SIGNAL_SEQUENCE`;
- the next sequence with the wrong `prev` fails with
  `ERR_RENDEZVOUS_SIGNAL_CHAIN`; and
- any future sequence fails immediately with
  `ERR_RENDEZVOUS_SIGNAL_SEQUENCE`.

The implemented receive reorder window is zero: the authenticated session does
not buffer gaps. A transport may retry the exact missing predecessor and then
retry later envelopes in order.

Capability consumption is bound to the first complete offer envelope, including
its signature:

- An offerer constructs, signs, and digests its sequence-zero offer, then binds
  that digest before `session.outbound` returns it.
- An answerer fully verifies and sequences an inbound sequence-zero offer, then
  binds its digest before invoking the message handler or returning it.
- An answerer cannot publish its answer before accepting the bound offer, and
  an offerer cannot accept an answer before publishing its bound offer.

The reservation key is
`capability-offer:v1:${capabilityDigest}:${localNodeId}`. Its value is the
complete first-offer digest, and the decision is retained through capability
expiry plus clock skew. `compareAndReserve` MUST be atomic across all callers
sharing the security domain and MUST return exactly:

- `reserved` when the key was absent and the value was stored;
- `matched` when the same value was already stored; or
- `conflict` when the key exists with another value or cannot validly be
  reserved at the supplied time.

Only `reserved` starts a new authenticated session. Both `matched` and
`conflict` close that new session and produce `ERR_RENDEZVOUS_REPLAYED`. This is
intentional: a matching persistent reservation proves that the offer was seen,
but does not restore the lost sequence, handler, or WebRTC state needed to
resume it.

An exact transport retry is idempotent only inside the original live session
and while the signal and session remain within their accepted time windows.
There, `session.inbound` returns `message: null` and `duplicate: true` without
invoking the message handler again. A new session or restarted process does not
recover an earlier acceptance, even when the shared store returns `matched`. A
different first offer under the same capability/local-node key is a conflict. A
process-local store that was lost on restart cannot prevent reuse after restart.

`verifyConnectionCapability({consume: true})` claims
`capability-inspection:v1:${capabilityDigest}`. This inspection namespace is
separate from, and is not a substitute for, the session's first-offer binding.
After the first offer, an accepted inbound signal is claimed under
`signal:v1:${signalDigest}`. `consumeCapability: false` disables first-offer
reservation and is suitable only when an outer layer provides equivalent
single-use enforcement or for controlled development and tests.

Retries MUST resend the exact same signed envelope. Re-signing a retry with a
new time but the same sequence creates equivocation.

The implemented `InMemoryReplayStore` provides atomic synchronous `claim` and
`compareAndReserve` operations for sessions sharing that exact store instance
in one live process. It never evicts an unexpired decision. Its contents
disappear on restart and are not coordinated across replicas. It is appropriate
for tests, local use, and controlled development. Internet-facing or replicated
deployment requires a durable implementation of the same atomic interface; v1
does not claim restart-safe one-time use without one.

## Language-neutral transport interface

Rendezvous authentication depends on this structural interface, not a
particular network protocol:

```ts
interface RendezvousTransport {
  publish(
    envelope: Uint8Array, // exact canonical UTF-8 SignalEnvelope
    options: {
      // Untrusted delivery hint; the endpoint still verifies signed `to`.
      recipient: NodeID;
      // Normally digestSignalEnvelope(signedEnvelopeObject), computed before
      // signedEnvelopeObject is serialized into the envelope bytes.
      idempotencyKey?: string;
      signal?: AbortSignal;
    },
  ): Promise<{
    accepted: true;
    duplicate: boolean;
    cursor?: string;
  }>;

  receive(options: {
    recipient: NodeID;
    cursor?: string;
    waitMs?: number;
    signal?: AbortSignal;
  }): Promise<{
    envelopes: Uint8Array[]; // exact canonical UTF-8 records
    cursor: string;
  }>;

  close?(): void | Promise<void>;
}
```

The transport MUST preserve exact canonical bytes and treat them as opaque
bounded records until endpoint verification. For publication, the caller passes
the result of `serializeSignalEnvelope`; its `maxSignalBytes` option SHOULD use
the verified capability limit. Received bytes pass directly to
`session.inbound` or `verifySignalEnvelopeBytes`. `recipient` is an untrusted
mailbox-routing hint and MUST NOT be treated as authority; the endpoint still
verifies the signed `to` field.

Equivalent callbacks, iterators, RPCs, queues, or local function calls conform
only if they preserve those byte semantics. Transport cursors, recipient hints,
and idempotency keys are delivery aids only; they MUST NOT replace signed
direction, sequence, hash-chain, capability, or replay validation. A transport
MAY reject obvious routing or size errors and SHOULD enforce admission
authentication, quotas, and expiry for abuse resistance, but endpoint
verification remains authoritative. Application bytes MUST NOT pass through
this interface.

Capability issuance and distribution are outside `RendezvousTransport`, which
is a signaling-only interface. Whatever application-owned channel distributes
a capability SHOULD retain canonical bytes, use
`serializeConnectionCapability` for publication, and use
`verifyConnectionCapabilityBytes` at the receiving trust boundary.

A hosted HTTP transport is future work. The existing demo long-poll server is
not the normative authenticated transport.

## Implemented package API

The JavaScript reference package exposes operations corresponding to these
language-neutral functions:

```ts
canonicalizeJson(value): string
canonicalizeJsonBytes(value): Uint8Array
parseCanonicalJson(bytesOrString, options?): JsonValue

encodeBase64Url(bytes): string
decodeBase64Url(text): Uint8Array
encodeBase32(bytes): string
decodeBase32(text): Uint8Array

nodeIdFromPublicKey(publicKey): Promise<NodeID>
verifyNodeId(nodeId, publicKey): Promise<true>
generateNodeIdentity(options?): Promise<NodeIdentity>
createNodeIdentity({ privateKey, publicKey }, options?): Promise<NodeIdentity>

issueConnectionCapability(fields, issuerIdentity): Promise<ConnectionCapability>
verifyConnectionCapability(capability, policy): Promise<VerifiedConnectionCapability>
verifyConnectionCapabilityBytes(bytes, policy): Promise<VerifiedConnectionCapability>
serializeConnectionCapability(capability): Uint8Array
digestConnectionCapability(capability): Promise<string>

createSignalEnvelope(fields, localIdentity): Promise<SignalEnvelope>
verifySignalEnvelope(envelope, policy): Promise<VerifiedSignalEnvelope>
verifySignalEnvelopeBytes(bytes, policy): Promise<VerifiedSignalEnvelope>
serializeSignalEnvelope(envelope, options?): Uint8Array
digestSignalEnvelope(envelope): Promise<string>

new InMemoryReplayStore(options?)
createAuthenticatedSession(options): Promise<Readonly<AuthenticatedSession>>
```

Capability issuance requires explicit subject, audience, action, resource,
application protocol, channels, privacy, limits, actor, `onBehalfOf`, service,
and profile claims; there is no implicit privacy mode, quota, or principal.
The helper may generate `id` and `sessionId` and may derive the standard
visibility, lifetime, and single-use defaults. A product that approves a request
before issuance SHOULD instead supply every final value explicitly so its
approval and the signed result cannot diverge. The three exported
`DEFAULT_MAX_*` constants are caller-fill recommendations for the required
`limits` object; the helper does not apply them implicitly.

`createAuthenticatedSession` owns local outbound sequence/hash state and
inbound verification/replay state. Its conceptual operations are:

```ts
session.deadline: number
session.outbound(message, options?): Promise<Readonly<SignalEnvelope>>
session.inbound(envelopeOrCanonicalBytes, options?): Promise<Readonly<{
  envelope: Readonly<SignalEnvelope>;
  digest: string;
  message: Readonly<WebRTCSignalMessage> | null;
  duplicate: boolean;
}>>
session.close(reason?): boolean
```

`outbound` and `inbound` serialize concurrent calls independently so each
sender chain advances deterministically. `close` returns `true` for the first
transition to closed and `false` if the session was already closed. The
read-only `deadline` is the earlier of capability expiry and session creation
time plus `limits.maxSessionDurationMs`. Calls to `outbound` or `inbound` at or
after that instant close the authenticated signaling session and fail with
`ERR_RENDEZVOUS_CAPABILITY_EXPIRED`; every outbound envelope is also capped to
expire no later than this deadline.

Close and deadline transitions are also commit barriers for in-flight package
operations: session state is rechecked after asynchronous crypto, replay-store,
and message-handler boundaries, and no sequence/hash cursor advances after the
session becomes terminal. The package cannot cancel an arbitrary external
signer, store, or handler that is already executing, nor undo application
effects a handler performed before it noticed cancellation. Integrations need
their own abort propagation for that external work.

Replay-store calls and message handlers may already have effects when they
return or fail. Once either boundary begins, any later failure before the
sequence/hash cursor commits makes the session terminal with
`outbound-incomplete` or `inbound-incomplete` unless a more specific terminal
reason was already set. This prevents different content from reusing a sequence
whose earlier replay or application effect cannot be rolled back.

The high-level authenticated session is the safe composition boundary. Its
constructor requires explicit expected values for session, action, resource,
application protocol, complete channel set, privacy, signaling visibility,
limits, actor, `onBehalfOf`, service, and profile. It also requires an
`enforceSessionPolicy(context)` callback that returns exactly `true`.
Capability consumption is on by default and therefore requires an explicit
shared replay store with `claim` and `compareAndReserve`. If both
`expectedIssuer` and `trustedIssuers` are supplied, the issuer MUST satisfy
both.

`allowUntrustedIssuer: true` explicitly disables issuer authorization even for
the high-level session. It exists for inspection and controlled tests;
production authorization MUST instead configure `expectedIssuer`,
`trustedIssuers`, or both and MUST NOT enable this escape hatch. The package
compares the signed channel set to the explicit expected set, but it does not
create, inspect, or reject WebRTC DataChannels. The browser session or native
supervisor MUST configure and enforce the authorized label/protocol set.

The replay-store contract is:

```ts
interface ReplayClaimStoreLike {
  claim(
    key: string,
    expiresAt: number,
    now?: number,
  ): boolean | Promise<boolean>;
}

interface ReplayStoreLike extends ReplayClaimStoreLike {
  compareAndReserve(
    key: string,
    value: string,
    expiresAt: number,
    now?: number,
  ): "reserved" | "matched" | "conflict" |
     Promise<"reserved" | "matched" | "conflict">;
}
```

Both operations MUST be atomic across their deployment scope and retain an
accepted decision through `expiresAt`. `claim` returns `true` only when it
created the claim and `false` when that key was already claimed or could not be
validly claimed at the supplied time. `compareAndReserve` returns `reserved`
only when it created the reservation, `matched` only when the existing value is
identical, and `conflict` for a different existing value or an expiry that
cannot be accepted. A thrown exception or any other return value fails closed
with a replay-store error; the package does not fall back to process memory.

`session.inbound` accepts canonical UTF-8 as a string, `ArrayBuffer`, or any
array-buffer view and chooses the bounded byte verifier. Its object input is
reserved for trusted in-memory composition.

The lower-level functions are policy-parametric primitives, not blanket
authorization decisions:

- `verifyConnectionCapability` always verifies schema, NodeID binding,
  signature, issuer trust, and time, but compares only the expected scope fields
  the caller supplies. Either an exact `expectedIssuer` or `trustedIssuers`
  allowlist supplies trust; with neither, verification fails unless
  `allowUntrustedIssuer: true` explicitly selects the inspection escape hatch.
- `verifyConnectionCapabilityBytes` first enforces the capability byte limit
  and canonical wire encoding, then performs the same checks.
- `verifySignalEnvelope` requires a result branded by
  `verifyConnectionCapability` unless `allowUnscoped: true` is explicitly set.
  Without expected sequence/predecessor values and a replay store, it does not
  provide session order, fork, or replay state. `allowUnscoped` performs
  signature/identity/time inspection and grants no authority.
- `verifySignalEnvelopeBytes` first applies the capability-scoped envelope byte
  limit and canonical wire parse, then performs the same signal checks.
- Only `session.inbound` combines the full explicit capability policy with
  stateful sequence, hash-chain, duplicate, candidate lifecycle, and replay
  checks. A consumer MUST NOT forward a low-level result to WebRTC unless it has
  independently supplied and enforced all omitted state.

The signal schema treats SDP as bounded opaque text. It authenticates that text
but does not prove that its media sections match the capability. A DataChannel-
only integration MUST inspect an accepted description and reject every media
section other than the expected `m=application` section before calling
`setRemoteDescription`. The current package supplies no common SDP-policy
parser. A media-capable integration needs separately specified signed track and
direction authority rather than inferring it from the existing channel list.

Private keys remain inside `NodeIdentity`; wire records contain only public
keys. An implementation MUST NOT export a private key merely to satisfy this
interface. Other languages MAY expose equivalent names and native key types.

## Limits

V1 parsers and constructors enforce finite limits before cryptographic or
WebRTC work. Implementations MAY configure lower deployment limits but MUST
interoperate at or below these maxima:

| Item | V1 maximum/default |
|---|---:|
| Raw Ed25519 public key | exactly 32 bytes |
| Ed25519 signature | exactly 64 bytes |
| Capability or session identifier | 16–48 decoded bytes; generator default 24 |
| Complete canonical capability | 16 KiB hard maximum |
| Complete canonical signal envelope | authorized `maxSignalBytes` + 64 KiB; 320 KiB hard maximum |
| Generic canonical JSON helper | 1 MiB default; protocol-specific limits above still apply |
| Protocol canonical JSON nesting | 32 levels and 16,384 values/members |
| Canonical `message` | 256 KiB, additionally subject to the session codec |
| SDP string | 256 KiB UTF-8 |
| Candidate `message` | 16 KiB canonical JSON |
| Channels per capability | 8 |
| Channel label | 256 UTF-8 bytes |
| Channel protocol | 256 UTF-8 bytes |
| `action`, `applicationProtocol`, `serviceId`, `profile` | 128 UTF-8 bytes each |
| `resource`, `actor`, `onBehalfOf` | 512 UTF-8 bytes each |
| Signals per sender/session | 512 exported recommendation (claim remains explicit); 4,096 hard maximum |
| Capability `issuedAt`-to-`expiresAt` lifetime | 5 minutes by default; 10 minutes hard maximum |
| Signal validity | 30 seconds by default; 60 seconds hard maximum |
| Clock-skew allowance | 30 seconds by default; 10 minutes hard maximum |
| In-memory replay entries | 4,096 by default; 1,000,000 hard maximum |
| `limits.maxSessionDurationMs` | 10-minute exported recommendation and hard maximum (claim remains explicit); determines the exposed session deadline |
| `limits.maxSignals` | positive safe integer, no greater than 4,096 |
| `limits.maxSignalBytes` | 256 KiB exported recommendation and hard maximum (claim remains explicit) |

`limits` has exactly `maxSessionDurationMs`, `maxSignals`, and
`maxSignalBytes`. All are positive safe integers. The `maxSignalBytes` value is
the canonical message budget; the fixed additional 64 KiB bounds envelope
metadata, keys, and signatures. A consumer that cannot enforce a bound MUST
reject the capability rather than ignore the field.

The WebRTC session and sidecar retain their existing, sometimes lower,
description and candidate bounds. The strictest applicable bound wins.

## Error taxonomy

Protocol failures use `RendezvousError` with a stable `code`. Messages are for
operators and MUST NOT contain private keys, raw capabilities, SDP, ICE
candidates, TURN credentials, or local addresses.

| Code | Meaning |
|---|---|
| `ERR_RENDEZVOUS_INVALID_ARGUMENT` | An API argument or scalar encoding is invalid. |
| `ERR_RENDEZVOUS_INVALID_JSON` | A value is not strict canonicalizable I-JSON. |
| `ERR_RENDEZVOUS_LIMIT_EXCEEDED` | A byte, count, time, or resource limit was exceeded. |
| `ERR_RENDEZVOUS_CRYPTO_UNAVAILABLE` | The required Web Crypto operation is unavailable. |
| `ERR_RENDEZVOUS_KEY_INVALID` | An Ed25519 key is malformed, unusable, or not the asserted pair. |
| `ERR_RENDEZVOUS_NODE_ID_INVALID` | A NodeID is syntactically invalid. |
| `ERR_RENDEZVOUS_NODE_ID_MISMATCH` | Public key and asserted NodeID do not agree. |
| `ERR_RENDEZVOUS_SIGNATURE_INVALID` | Ed25519 verification failed. |
| `ERR_RENDEZVOUS_CAPABILITY_INVALID` | A capability has the wrong exact schema or invalid claims. |
| `ERR_RENDEZVOUS_CAPABILITY_UNTRUSTED_ISSUER` | The issuer NodeID is not in the verifier's trust set. |
| `ERR_RENDEZVOUS_CAPABILITY_NOT_YET_VALID` | The capability is earlier than its accepted window. |
| `ERR_RENDEZVOUS_CAPABILITY_EXPIRED` | The capability is later than its accepted window. |
| `ERR_RENDEZVOUS_CAPABILITY_MISMATCH` | Subject, audience, session, action, resource, protocol, channels, privacy, service, profile, or limit policy does not match. |
| `ERR_RENDEZVOUS_SIGNAL_INVALID` | A signal has the wrong exact schema or invalid claims. |
| `ERR_RENDEZVOUS_SIGNAL_EXPIRED` | A signal is outside its accepted window. |
| `ERR_RENDEZVOUS_SIGNAL_MISMATCH` | Signal target, role, session, capability digest, or peer does not match. |
| `ERR_RENDEZVOUS_SIGNAL_SEQUENCE` | Sequence is replayed, conflicting, exhausted, or outside the accepted window. |
| `ERR_RENDEZVOUS_SIGNAL_CHAIN` | `prev` does not name the preceding accepted signal. |
| `ERR_RENDEZVOUS_REPLAYED` | A single-use capability or signed record is already present in, or conflicts with, replay state. |
| `ERR_RENDEZVOUS_REPLAY_STORE_FULL` | The bounded in-memory replay store cannot reserve another entry. |
| `ERR_RENDEZVOUS_REPLAY_STORE_FAILED` | An injected replay-store operation threw or returned an invalid result. |
| `ERR_RENDEZVOUS_CLOCK_FAILED` | An injected clock threw or returned an invalid value. |
| `ERR_RENDEZVOUS_SESSION_POLICY_REJECTED` | The required session-policy enforcer threw or did not return exactly `true`. |
| `ERR_RENDEZVOUS_SESSION_CLOSED` | The authenticated session is terminal. |
| `ERR_RENDEZVOUS_HANDLER_FAILED` | A caller-provided session callback failed. |

Callers MAY map these codes to localized prose, CLI exit codes, metrics, or
agent-tool results. Policy decisions MUST use the code and structured context,
not parse an English message.

Injected clock, replay-store, session-policy-enforcer, external-signer, and
session-handler failures are caught at their package boundaries and reported
without their original backend message. Strict wire parsing and Web Crypto
random generation, digest, key, signature, and key-generation operations are
likewise normalized. A generic replay-store failure is retryable; a full store,
rejected session policy, or invalid protocol record is not. Integrations MUST
still keep backend errors and credentials out of their own logs and transport
responses.

## Security and privacy invariants

Conforming v1 consumers preserve all of these invariants:

1. When using `session.inbound`, no remote SDP or ICE value reaches WebRTC
   before peer signature, NodeID, complete capability policy, time, target,
   session-policy assertion, replay, order, chain, and candidate-lifecycle
   checks succeed. The low-level verification functions alone do not promise
   all of that state.
2. A capability applies only to its exact issuer trust, subject, audience,
   session, action, resource, application protocol, channel set, privacy,
   service, profile, limits, and lifetime.
3. A valid peer signature is not workload authorization; a valid capability
   is not proof of peer key possession. Both are required.
4. Signing the exact SDP binds its DTLS fingerprint to the peer NodeID.
5. HTTPS, a bearer token, room membership, a rendezvous cursor, a TURN
   credential, and successful WebRTC establishment are not substitutes for
   NodeID or capability verification.
6. Retrying delivery does not create a new signed record.
7. Unsupported fields, constraints, algorithms, and privacy modes fail closed.
   Session construction also fails unless the local `enforceSessionPolicy`
   callback affirmatively accepts the exact signed policy and its integration
   obligations.
8. Application bytes never enter rendezvous records or logs.
9. `weave-rtc` remains a generic transport primitive; its supervisor performs
   authentication before forwarding signaling or exposing authorized local
   streams.
10. Loopback restriction is not local-process authentication and remains a
    separate deployment responsibility.

V1's `rendezvous-visible` signaling is authenticated but not confidential.
The rendezvous can read SDP, candidates, capabilities, NodeIDs, workload
selectors, sizes, timing, and traffic patterns.

After verifying and policy-comparing the capability, the package calls
`enforceSessionPolicy` with a frozen context containing `privacy`,
`signalingVisibility`, local role and NodeID, peer NodeID, the computed
`deadline`, and the complete verified capability. The callback MUST return
exactly `true`; any other result or exception rejects session construction with
`ERR_RENDEZVOUS_SESSION_POLICY_REJECTED`.

That callback is a trusted integration assertion, not independent inspection or
enforcement by this package. Before it returns `true`, the integration MUST:

- configure or verify actual WebRTC, ICE, and TURN behavior for the signed
  `privacy` and `signalingVisibility` policy;
- map and validate signed `action`, `resource`, `applicationProtocol`,
  `channels`, `serviceId`, and `profile` against the live application and data
  plane; and
- arrange for the established `RTCPeerConnection` and all associated
  DataChannels to close no later than `deadline`.

The package deliberately imports no WebRTC or application-protocol
implementation. It does not itself configure ICE servers, set
`iceTransportPolicy`, filter candidate types, authorize application bytes,
enforce actual DataChannel creation, or schedule closure of an established
connection. Its deadline only bounds authenticated-session signaling
operations. In particular, `session.inbound` can authenticate and return a host
or server-reflexive candidate under a `relay-only` capability. The browser
session or native supervisor MUST keep the accepted integration policy effective
before applying every returned message and throughout the resulting connection.
When correctly enforced, `relay-only` prevents direct candidate use; it still
does not hide control-plane metadata from rendezvous.

Implementations MUST redact raw capabilities, signatures, SDP, candidates,
TURN credentials, private keys, and local addresses from ordinary logs and
errors. Audits SHOULD record NodeIDs, capability and signal digests, session
ID, action, service/profile, policy result, stable error code, and time.

## Threats outside v1

V1 does not prevent:

- rendezvous denial, withholding, delay, partition, or traffic analysis;
- endpoint, NodeID private-key, or trusted-issuer compromise;
- a trusted issuer deliberately granting excessive authority;
- clock or secure-random failure;
- replay across process restart after an in-memory replay store is lost, or
  capability reuse across replay-store instances;
- recovery of authenticated-session/WebRTC state from a persistent
  first-offer reservation after the original live session is lost;
- local same-host processes racing a sidecar TCP listener;
- direct peers or TURN relays observing their ordinary network metadata;
- incorrect application authorization or failure to enforce signed limits;
- workload split-brain, HostService incompatibility, or ownership-fencing
  failure; or
- anonymous, unlinkable, or multi-hop communication.

The hash chain detects omission and reordering once records are observed. It
does not restore missing messages or make the rendezvous available.

## Future work

Future online-key credentials may let a stable NodeID root key sign a
short-lived Ed25519 signaling key. Future confidentiality may add an
independently bound X25519 agreement key and a standard HPKE profile. Neither
key nor an encryption placeholder appears in v1 records; adding them requires
a specified version and downgrade rules.

A future `peer-only` signaling profile should encrypt capability and WebRTC
message contents end to end while signing the routing envelope and
ciphertext. It will still reveal enough mailbox metadata to route a record and
will not provide traffic-analysis resistance.

A production replay store must implement the existing atomic `claim` and
`compareAndReserve` contracts with shared replica visibility, retention through
expiry plus skew, bounded garbage collection, and failure behavior that is
closed rather than silently falling back to memory. Restoring an authenticated
session after `compareAndReserve` returns `matched` is future work because it
also requires durable sequence, hash-chain, handler, and WebRTC negotiation
state. A hosted transport separately needs admission authentication, quotas,
bounded polling or streaming, expiration, idempotent publication, audit, and
abuse controls.

Media authorization, if added, should use separately specified namespaced
profiles and send/receive directions. Audio and video must not be forced
through the reliable ordered byte-stream adapter merely because rendezvous can
carry their WebRTC descriptions.

## Conformance vectors

The shipped cross-language artifact is
[`packages/authenticated-rendezvous/vectors/v1.json`](../packages/authenticated-rendezvous/vectors/v1.json).
Its exact top-level format is:

```json
{
  "format": "weave-authenticated-rendezvous-conformance-v1",
  "warning": "The RFC 8032 private seeds in this file are public test vectors. Never use them outside conformance tests.",
  "standards": {
    "canonicalization": "RFC 8785 JSON Canonicalization Scheme",
    "signature": "RFC 8032 Ed25519",
    "keyEncoding": "RFC 8410 Ed25519",
    "textEncoding": "UTF-8"
  },
  "now": 1800000000000,
  "identities": {
    "issuer": {},
    "offerer": {},
    "answerer": {}
  },
  "capability": {},
  "signals": {
    "offer": {},
    "answer": {}
  }
}
```

Each named identity has exactly this artifact shape:

```json
{
  "seedHex": "<32-byte lowercase hex RFC 8032 seed>",
  "publicKeyHex": "<32-byte lowercase hex public key>",
  "publicKeyBase64Url": "<same public key as canonical base64url>",
  "nodeId": "wn1-…"
}
```

The warning is REQUIRED because these private seeds are public test material and
MUST NOT be used outside conformance tests.

The `capability` artifact has:

```json
{
  "claims": {},
  "signatureDomain": "weave.rendezvous.capability.v1\u0000",
  "signatureDomainUtf8Hex": "<domain UTF-8 bytes as lowercase hex>",
  "canonicalUnsignedJson": "<literal canonical JSON text>",
  "signatureBase64Url": "<64-byte Ed25519 signature>",
  "signed": {},
  "canonicalSignedJson": "<literal canonical JSON text>",
  "digest": "sha256-…"
}
```

Each entry in `signals` has the same signing-artifact fields, with `fields` in
place of `claims`:

```json
{
  "fields": {},
  "signatureDomain": "weave.rendezvous.signal.v1\u0000",
  "signatureDomainUtf8Hex": "<domain UTF-8 bytes as lowercase hex>",
  "canonicalUnsignedJson": "<literal canonical JSON text>",
  "signatureBase64Url": "<64-byte Ed25519 signature>",
  "signed": {},
  "canonicalSignedJson": "<literal canonical JSON text>",
  "digest": "sha256-…"
}
```

`capability.claims` is the exact constructor input and has `id`, `subject`,
`audience`, `sessionId`, `action`, `resource`, `applicationProtocol`,
`channels`, `privacy`, `signalingVisibility`, `limits`, `actor`, `onBehalfOf`,
`serviceId`, `profile`, `issuedAt`, `notBefore`, `expiresAt`, and `singleUse`.
The constructor derives `v`, `type`, `issuer`, `issuerPublicKey`, and
`signature`.

`signals.offer` is signed by `identities.offerer`; `signals.answer` is signed by
`identities.answerer`. Each `fields` object is the exact constructor input and
has `sessionId`, `capabilityDigest`, `to`, `role`, `seq`, `prev`, `issuedAt`,
`expiresAt`, and `message`; it omits the derived `v`, `type`, `from`,
`fromPublicKey`, and `signature`. `signed` is the complete wire object.
`canonicalUnsignedJson` and `canonicalSignedJson` are literal JSON strings, not
base64 encodings. After JSON parsing, `signatureDomain` contains the actual zero
byte; `signatureDomainUtf8Hex` makes the boundary unambiguous.

The shipped artifact is intentionally a positive portability vector. It has no
`negative` member. The accompanying `vectors.test.mjs` MUST reproduce all
identity public keys and NodeIDs, capability and signal constructor outputs,
canonical unsigned and signed texts, exact domain bytes, Ed25519 signatures,
digests, object verification, and canonical-byte verification.

Negative and stateful conformance remains in `protocol.test.mjs` rather than the
portable JSON artifact. That suite covers at least:

- NodeID derivation and one-bit public-key changes;
- member-order and Unicode canonicalization;
- every field mutation under a valid-looking signature;
- public-key/NodeID mismatch and unknown issuer;
- wrong subject, audience, session, role, capability digest, action, resource,
  channels, privacy, service, and profile;
- not-before, expiry, skew boundaries, and excessive lifetime;
- exact duplicate, conflicting duplicate, missing predecessor, wrong `prev`,
  and sequence exhaustion;
- atomic first-offer reservation, matching and conflicting new sessions,
  live-session exact retry, and the explicit `consumeCapability: false` path;
- invalid and noncanonical base32/base64url;
- duplicate/unknown JSON members, noncanonical wire bytes, and all size/count
  limits;
- SDP fingerprint substitution, candidate mutation, and empty-candidate
  rejection;
- the required affirmative session-policy callback contract, including the
  exposed deadline; and
- clock, replay-store, injected-crypto, and external-signer failure without
  falling open or exposing backend details.

Conformance vectors establish wire compatibility. They do not replace
property tests, fuzzing, real browser/native negotiation, malicious transport
tests, or persistence/replica tests for a future production replay store.

## Relationship to other repository protocols

Authenticated rendezvous is not a new Weave migration wire version. The
verified `message` configures WebRTC; an established DataChannel still carries
the existing application bytes, including an unchanged `weave.v2` `HELLO`.

The package boundaries remain:

- `@weave-net/webrtc-session`: offer/answer, ICE, and channel lifecycle;
- `sidecars/webrtc`: generic DataChannel-to-loopback-TCP transport;
- authenticated rendezvous v1: peer/capability authentication and signaling
  replay/order protection;
- a future overlay agent: directory, hosted rendezvous, TURN, pooling, policy,
  and reconnection; and
- HostService/plugin protocols: portable external state, compatibility,
  prepare/commit/abort, and ownership fencing.

See also [`NETWORK_PACKAGES.md`](NETWORK_PACKAGES.md),
[`PROTOCOL.md`](PROTOCOL.md), and [`../WEBRTC_OVERLAY.md`](../WEBRTC_OVERLAY.md).
