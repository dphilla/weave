# Consuming authenticated rendezvous

> **Status:** Product and interface guidance for the authenticated rendezvous
> package. This document is not a promise of a hosted rendezvous service,
> directory, graphical interface, autonomous-agent tool, or media platform.

## Executive conclusion

Authenticated rendezvous should be **machine-verifiable and
human-explainable**. One strict identity, capability, and session model should
serve browsers, native servers, command-line tools, autonomous agents, and
future user interfaces. Those consumers should be projections over the same
protocol rather than separate trust systems.

The initial interface is **modality-neutral**, not yet a truly multimodal
communications system. It authenticates and authorizes the signaling records
that an application transports while establishing an opaque WebRTC session,
but it does not deliver those records or establish WebRTC itself. The reusable
browser session and native sidecar currently expose only DataChannels. Audio,
video, screen capture, media devices, codec policy, and media accessibility
require additional packages and security decisions. “DataChannel-only” is an
integration policy, not something authenticated rendezvous can infer from an
opaque SDP string: current consumers must reject unauthorized media sections
before applying a remote description.

The first release should therefore optimize for authenticated, inspectable,
replay-safe signaling for DataChannel session establishment. It should leave
clean extension points for agents and media without pretending to implement
either complete product surface.

## Scope and release boundary

Implemented v1 provides a reusable JavaScript reference package and a
language-neutral wire/interface contract for:

- stable, self-certifying `wn1-` NodeIDs derived from Ed25519 public keys and
  direct signatures by those NodeID keys;
- the exact issuer-signed, source/target/session-bound, single-use connection
  capability defined in [`RENDEZVOUS.md`](RENDEZVOUS.md);
- peer-signed signaling envelopes with per-sender sequence numbers and hash
  chains;
- deterministic RFC 8785 canonicalization, bounded canonical-byte entry
  points, plus strict schema, time, identity, capability, and replay
  validation;
- an authenticated-session state machine and `InMemoryReplayStore`; and
- a byte-oriented structural `RendezvousTransport` interface that an
  application can implement without importing WebRTC or Weave.

There is no separate signed-introduction object in v1. The verified capability
and capability-scoped, peer-signed signal chains are the authenticated
transcript. An authenticated session owns its live hash-chain state, while
`InMemoryReplayStore` retains bounded replay and first-offer reservations for
one process. Neither is a rendezvous transport, mailbox, session database, or
restart-safe production replay service. V1 supplies no concrete in-memory,
HTTP, WebSocket, database, or federated transport adapter.

It does not by itself provide:

- a production-hosted rendezvous or TURN service;
- a federated name directory or account system;
- a certificate authority, organization policy service, or recovery service;
- a finished CLI, browser application, approval interface, or agent tool;
- durable presence, push notifications, billing, or abuse operations;
- audio/video tracks, an SFU, recording, transcription, or moderation;
- delegated online credentials, ephemeral confirmation keys, or revocation
  distribution;
- workload migration policy or `HostService` compatibility.

An application can reuse the v1 identity, capability, and signaling primitives
inside several of those products, and can replace projections or transports
without changing their signed semantics. Media authorization, delegation,
confidential signaling, or any other new signed meaning needs a new version or
a separately specified, fail-closed extension.

## Identity is not a display name

Four concepts must remain distinct:

| Concept | Meaning | Must not be treated as |
|---|---|---|
| NodeID | Cryptographic identity of an endpoint key | A person, account, IP address, or service name |
| Principal | Person, organization, service account, or autonomous agent taking an action | The machine on which it happens |
| Service or workload | The resource and protocol being contacted or moved | The whole node |
| Session | One bounded, authorized connection attempt | A permanent peer relationship |

One node can host several services and act for several principals. The v1
capability records `actor`, nullable `onBehalfOf`, `serviceId`, and `profile`
as exact policy fields. Audit records should identify those values, in
addition to both NodeIDs. A future schema may support delegated online node
keys beneath an organization or service root; v1 uses direct Ed25519 NodeID
and issuer signatures and defines no key delegation or equivalence statement.

Humans normally select a verified name such as a device or service label.
Machines should retain and compare the exact NodeID. A directory may bind a
name to a NodeID, but the binding needs an explicit issuer and trust state;
authorization must never depend on an unverified display string.

## Common consumption architecture

```text
       identity + capability + authenticated signal state
                              |
             +----------------+----------------+
             |                |                |
        browser SDK       CLI/server SDK   agent tool adapter
             |                |                |
        human UI          operator UI      policy + approval UI
```

The canonical encodings, exact capability fields, signature rules,
per-sender hash-chain/replay state, and stable error codes are the source of
truth. A browser interface can render them as a consent screen; a CLI can
render them as text or JSON; an agent tool can expose a smaller schema. None
of those projections may silently widen a capability or replace cryptographic
identifiers with labels.

The transport-facing representation is canonical UTF-8 bytes. Consumers must
use `verifyConnectionCapabilityBytes()` and
`AuthenticatedSession.inbound(bytes)` at untrusted boundaries; ordinary
`JSON.parse()` or `response.json()` erases duplicate-member and noncanonical
wire evidence. The object-taking verifiers remain useful for trusted in-memory
values and conformance work, but only the stateful session performs the full
policy, first-offer, order, chain, and replay decision needed before WebRTC.

The capability issuer is logically separate from rendezvous. V1 provides a
signing helper, but it does not decide which issuer or policy may approve an
operation. The embedding application supplies issuer trust and a transport;
both endpoint verifiers authorize from the exact signed capability. A
rendezvous service must not be assumed to have issuance authority merely
because it delivers a record. The v1 `RendezvousTransport` carries signal
records only; capability request, issuance, and delivery remain an explicit
application authorization-plane responsibility. Its required publish
`recipient` is only an opaque routing hint, and the endpoint still checks the
signed `to` value.

## Consumer matrix

The following are prospective integrations over v1. The package does not ship
these clients, daemons, transport adapters, approval flows, or product
policies.

| Consumer | Recommended surface | Key and capability handling | Important behavior |
|---|---|---|---|
| Autonomous agent | Typed tool wrapper over the canonical client API | A local signer or broker retains keys and raw capabilities; the model receives opaque handles | Idempotency, bounded scopes, policy evaluation, stable errors, asynchronous approval |
| Human web application | Browser ESM client plus application UI | Origin/device key through Web Crypto, with an account or organization identity above it | Consent, safe invite handling, verified labels, revocation, suspension recovery |
| Human CLI | CLI speaking to a local overlay daemon or library | Daemon, keychain, or external signer owns the private key | Human output by default; exact JSON/NDJSON, exit codes, dry-run, inspect, revoke |
| Browser application | Application-provided HTTPS or another resumable transport carrying opaque WebRTC signaling | Direct browser-specific Ed25519 NodeID in v1; future versions may define delegated online keys | Origin policy, cancellation, reconnect cursor, short presence leases, background suspension |
| Native server | Native SDK plus an application-provided `RendezvousTransport` | Direct local or external KMS/HSM Ed25519 signer in v1; delegated replica credentials remain future | Multi-tenancy, policy automation, quotas, high availability, structured telemetry |
| Local or offline peer | Application-provided local/offline `RendezvousTransport` | Local Ed25519 NodeID keys | No Internet dependency and the same schemas and transcript checks |
| Human approving an agent | Approval UI backed by a future canonical grant request | Human or organization signing authority | V1 has no pre-issuance approval artifact; the final issuer signature is its only protocol-level approval |

### Autonomous agents

An autonomous agent should not manipulate raw signing keys, long-lived TURN
secrets, or raw signed capabilities. In an LLM-style system, these values
should also stay out of prompts, tool transcripts, and model-visible logs. A
trusted local component can return a short-lived handle such as `grant_...` or
`session_...` and dereference it when performing the operation.

A future agent-tool projection could provide operations resembling:

- `inspect_peer`;
- `evaluate_connection`;
- `request_capability`;
- `watch_authorization`;
- `open_session`;
- `inspect_session`;
- `close_session`;
- `revoke_capability`.

These names, approval states, and revocation operation are product guidance,
not part of v1. An eventual mutating product API should accept an idempotency
key. V1's transport interface already allows the signed-envelope digest to be
used as a delivery idempotency key, but it does not implement a transport.
Evaluation should return structured facts rather than a persuasive
natural-language summary: target and issuer identities, service, requested
operations, resource, duration, path/privacy policy, quotas, and whether human
approval is needed.

An agent may eventually act under pre-authorized organization policy. When
human approval is required, a product-level request should enter a bounded
pending state that the agent can watch without polling blindly. Approval must
be obtained out of band from the model and bind immutable structured claims.
V1 does not define the pre-issuance request or approval-evidence artifact, so
the issuer's signature over the final capability is its only protocol-level
approval. The agent should receive a stable `pending-approval`, `denied`,
`expired`, or `granted` outcome rather than infer state from prose.

### Humans in browsers

A human usually begins with a name, device card, service link, or invitation
rather than a NodeID. The interface should show who vouched for that name and
offer the exact NodeID or a fingerprint as inspectable evidence.

Browser storage is less durable than a native keychain and is scoped by
origin. A v1 application needs an explicit policy for whether a direct NodeID
represents one browser installation or a signed-in account device. A future
version could specify delegated sessions. Losing browser storage must not
silently recreate a device under the old trusted name.

Browser peers can be suspended or discarded in the background. A future
presence or hosted-transport product should therefore use short leases, and a
rendezvous client must tolerate a browser disappearing without a final close.
V1 does not implement presence. Service workers should not be assumed to keep
an arbitrary WebRTC session alive.

### Command-line tools

A CLI should be a projection over the same package or local daemon API. It
should support:

- concise, comprehensible terminal output;
- lossless JSON or NDJSON for scripts;
- stable exit statuses and error codes;
- inspect/evaluate before mutation;
- explicit approval and revocation;
- stdin or secret-store input rather than putting secrets in arguments;
- cancellation and bounded waits.

For a long-running native overlay, the daemon should own the NodeID key and
connection state. The CLI should not copy that private key into every process.
TTY prompts must fail safely in non-interactive automation instead of assuming
consent.

### Native servers and services

Servers need non-interactive policy evaluation, external signers, audit
export, quotas, and several simultaneous principals or services. A NodeID
identifies the endpoint; the v1 capability targets exact `serviceId`,
`action`, `resource`, `applicationProtocol`, channels, and profile rather than
authorizing arbitrary access to the machine.

Replicated services should not copy one unconstrained root private key into
every replica. Future credentials could let a stable root delegate bounded,
expiring online keys and distribute rotation or revocation state. V1 has no
delegation, rotation-equivalence, or revocation mechanism: changing an
Ed25519 key changes its NodeID.

## V1 capabilities as both enforcement and explanation

V1 accepts only the exact capability schema in
[`RENDEZVOUS.md`](RENDEZVOUS.md). Consumers must render and enforce its claims
without synthesizing broader authority. The issuer directly signs:

- schema version, type, unpredictable capability ID, issuer NodeID and public
  key, issue time, not-before time, and expiry;
- exact `subject` and `audience` NodeIDs;
- exact session ID and `singleUse: true`;
- exact `actor` and nullable `onBehalfOf` policy identifiers;
- exact `serviceId`, `profile`, `action`, and `resource`;
- exact application protocol and complete authorized DataChannel
  label/protocol set;
- one of the exact `direct-preferred`, `relay-only`, `organization-only`, or
  `offline-local` privacy selectors and the implemented `rendezvous-visible`
  signaling visibility; and
- exactly `limits.maxSignals`, `limits.maxSignalBytes`, and
  `limits.maxSessionDurationMs`.

Those privacy strings are selectors, not self-enforcing facts.
`direct-preferred` permits address-revealing direct candidates and relay
fallback; `relay-only` requires relay-only configuration plus an effective-path
check. `organization-only` and `offline-local` must be rejected unless the
exact application `profile` defines the organization or local-network boundary,
allowed infrastructure, and runtime check. The token alone is not an
interoperable network-boundary definition.

V1 has no wildcard scope, protocol range, delegated credential, ephemeral
confirmation key, revocation claim, concurrency limit, or extension member.
Copying a capability alone is not sufficient to forge signaling because every
signal must also carry a valid direct signature from its asserted NodeID key.
That is not an ephemeral-key binding: adding one would require a future
version.

Signed claims should use stable identifiers and enumerated operations, not
localized strings. A client can render the same fields for a person. This
prevents the enforcement view and consent view from describing different
requests.

Changing any signed field, including target, resource, action, privacy,
channels, limits, or expiry, invalidates the issuer signature. If human
approval precedes issuance, a future protocol needs a canonical pre-issuance
request and approval-evidence schema; the complete capability digest includes
the issuer signature and therefore does not exist until issuance. A mutable
form or chat message must never substitute for that future artifact.

## Keep product state machines separate

V1 implements outbound sequence/hash state, inbound signature/chain/replay
verification, and atomic first-offer reservation inside an authenticated
session. Its required `enforceSessionPolicy` callback makes the embedding
application affirm that the signed policy is reflected in the live system. The
package cannot inspect the actual PeerConnection, ICE server ownership,
candidate filter, DataChannels, application bytes, or network boundary, and it
cannot close those objects itself. The supervisor must enforce the complete
channel/application scope and arrange real data-plane closure by the supplied
`deadline`. It does not implement directory, human-approval,
hosted-rendezvous, transport-connectivity, revocation, or migration state
machines.

Production human, agent, CLI, and server wrappers must not expose
`allowUntrustedIssuer: true`, `allowUnscoped: true`, or
`consumeCapability: false`. Those public primitive options exist for
inspection, controlled tests, or an outer layer that supplies equivalent
authorization/replay enforcement; silently enabling any of them would remove a
security decision the product surface claims to make.

A future single screen may combine these conceptual phases, but their
protocols must remain independent:

```text
authorization: requested -> approved | denied | expired | revoked (future)
rendezvous:    open -> exchanging -> closed | expired
transport:     new -> checking -> connected -> failed
migration:     pre-copy -> prepared -> committed | aborted | uncertain
```

Rendezvous cannot authoritatively infer that WebRTC connected. A connected
WebRTC path does not prove that a capability remains valid. Human approval is
not an SDP event, and an ICE restart must not mutate Weave's workload
ownership state.

Applications may present a composite view, but events should retain their
origin and correlation IDs. A target can report a transport result for
observability; rendezvous must not turn that report into a security fact. V1
does not define these composite events.

## Human trust and approval ceremonies

V1 supplies no directory, account identity, approval flow, trust-on-first-use
store, QR exchange, or issuer PKI. A product built above it could offer three
trust experiences:

1. **Organization-managed identity.** A configured authority verifies the
   service/person label and NodeID. This should be the smoothest routine path.
2. **Out-of-band pairing.** Scan a QR code, open a one-time fragment link, or
   compare a short phrase derived from the cryptographic transcript.
3. **Explicit trust on first use.** Pin the NodeID similarly to SSH
   `known_hosts`, label the first-use assumption, and make later key changes
   prominent.

A consent view should answer:

- Who is requesting the action, and on whose behalf?
- Which verified source and target nodes are involved?
- Which service, workload, and operation are requested?
- Is the grant one-time, and when does it expire?
- Will a direct path expose either peer's network address?
- Could relay use consume metered capacity or incur cost?
- Which person or policy approved the request?

Natural language can introduce a request, but the final action must refer to
the canonical structured request. A model-generated explanation is
supplementary and must not become the signed authority.

Invitation material should not be placed in ordinary URL query parameters,
HTTP referrers, analytics, shell history, or logs. A fragment-based or opaque
one-time bootstrap can lead into an authenticated exchange. A future short
authentication-string profile must specify its transcript inputs, domain
separation, entropy, comparison ceremony, and attempt limits; until then,
displayed short codes are not a v1 security property.

## Accessibility

These requirements apply to future human-facing consumers; v1 has no user
interface.

Every QR flow needs a keyboard- and screen-reader-accessible text alternative.
Verification must not depend solely on color, sound, camera access, or visual
comparison of a long hexadecimal fingerprint.

Human-facing consumers should provide:

- copyable and phonetic short verification codes once a short-authentication-
  string profile is specified;
- complete keyboard operation and visible focus;
- high-contrast states that do not rely only on color;
- localized descriptions of stable capability scopes;
- accessible expiry and pending-state announcements;
- sufficient time to inspect or renew an expiring request;
- a text alternative with security properties explicitly equivalent to the QR
  ceremony once both are specified.

Captions, transcripts, audio descriptions, and media controls belong to a
future media/application layer, but the authorization model must be able to
distinguish permission to send or receive each medium.

## Audit and privacy

V1 defines redaction requirements and recommends audit fields, but the package
does not provide an audit sink, retention store, approval log, transport
cursor store, or revocation event source. An application audit event should
be able to record:

- request, policy decision, human approval or denial, use, close, expiry, and
  revocation;
- actor, optional `onBehalfOf`, source and target NodeIDs;
- service, resource selector, and operation;
- session ID, capability digest, policy/rule identifier, and correlation ID;
- timestamps, privacy/path policy, and a stable result category.

Audit output needs a readable human projection and a lossless machine form
with application-defined cursors and retention metadata. V1 errors and
ordinary logs must not include private keys, raw capabilities, signatures,
TURN credentials, SDP, ICE candidates, or local addresses. Application bytes
must not enter rendezvous records or logs.

V1 signs the exact SDP or candidate inside the envelope and declares
`signalingVisibility: "rendezvous-visible"`; it authenticates signaling but
does not encrypt it. The structural transport should treat the bounded signed
envelope as opaque and need not parse SDP or a workload resource merely to
deliver it. A future `peer-only` profile could seal message and capability
contents end to end, but no encryption placeholder exists in v1.

Direct peer-to-peer paths can reveal network addresses. The requested and
effective policy must be explicit in both the signed grant and the consent
view. A relay hides direct candidates from the peer only when the WebRTC
configuration enforces relay-only behavior; a label in the UI is not enough.

## Modality-neutral is not yet multimodal

Authenticated rendezvous is modality-neutral when it authenticates a
session's signaling without interpreting the later application payload. The
application's bytes can represent text, images, files, model events, sensor
readings, or a Weave migration. This does not make the current implementation
a transport or a complete multimodal system.

Today:

- `@weave-net/authenticated-rendezvous` accepts bounded offer/answer SDP as
  authenticated opaque text and does not reject audio or video media sections;
- `@weave-net/webrtc-session` establishes raw DataChannels;
- `@weave-net/browser-transports` adapts reliable, ordered DataChannels to an
  exact byte stream;
- `weave-rtc` bridges reliable, ordered DataChannels to loopback TCP;
- the browser session performs one fixed-role negotiation;
- neither browser package nor sidecar exposes audio or video tracks.

That API shape does not prove a received SDP is data-only. Until there is a
shared profile validator, an authenticated DataChannel integration must inspect
each accepted description and reject every media section other than its
expected `m=application` section before `setRemoteDescription`. A media-capable
integration needs separately signed track and direction authority.

True media support would additionally need:

- media tracks/transceivers and codec negotiation;
- browser capture permissions and native capture APIs;
- perfect negotiation, repeated offer generations, and ICE restart;
- explicit authorization for audio, video, screen, and data send/receive
  directions;
- a new approval when renegotiation widens those permissions;
- media-specific latency, loss, jitter, synchronization, and congestion
  behavior;
- decisions about media E2EE, SFUs for multiparty sessions, recording,
  transcription, moderation, and retention;
- captions, transcripts, descriptions, and accessible media controls.

Different modalities should not all be forced through Weave's reliable,
ordered byte-stream contract:

| Profile | Likely transport behavior |
|---|---|
| Workload migration or file | Reliable, ordered DataChannel with bounded backpressure |
| Session control | Small reliable channel with strong bounds and priority |
| Disposable realtime telemetry | Potentially partially reliable DataChannel |
| Audio or video | RTP media tracks with media-specific controls |
| Application text, images, or tool events | Application protocol over an appropriate channel |

V1 capabilities sign one exact `profile` string, application protocol, and
complete `{label, protocol}` channel set. Profile namespacing and DataChannel
reliability are application/integration policies, not v1 wire invariants. A
future media version could separately specify profiles and directions such as
`audio-send` or `video-receive`. SDP remains responsible for codec-level
negotiation. MIME types, codec inventories, and application records should not
become rendezvous routing semantics.

The package compares `action`, `resource`, `applicationProtocol`, `channels`,
`serviceId`, and `profile` with explicit trusted local policy, but it does not
parse SDP, inspect an established DataChannel, or interpret application bytes.
The browser session or native supervisor must configure only the accepted
label/protocol set, reject unexpected channels, and enforce application and
reliability requirements. It must also enforce the accepted ICE/TURN privacy
path and close the real PeerConnection/DataChannels by `session.deadline`;
`maxSessionDurationMs` only makes later rendezvous-session operations fail.
`enforceSessionPolicy` is a trusted assertion of that integration work, not a
fact the standalone package can independently observe.

V1 has no signed introduction or renegotiation generation. Its exact signed,
hash-chained signal envelope binds the one authorized profile and channel set
through the capability digest. Supporting negotiation generations or a wider
profile set later requires a new version or separately specified fail-closed
extension.

## Optimization order

The priorities for this layer are:

1. **Cryptographic correctness:** peer binding, proof of possession,
   exact issuer-signed capabilities, direct source/target NodeID signatures,
   expiry, signal hash-chain verification, replay defense, and an untrusted
   rendezvous assumption. Delegation, ephemeral confirmation keys, and
   revocation distribution remain future work.
2. **Deterministic automation:** strict bounded schemas, stable error codes,
   canonical-byte ingress, canonical hashes, atomic first-offer binding, chain
   validation, cancellation, and portable test vectors. The structural
   transport exposes cursor and idempotency fields only; each concrete adapter
   must specify scope, ordering, retention, invalidation, batching, and retry
   windows before independent implementations can interoperate.
3. **Cross-layer enforcement:** map signed privacy, channel, application, and
   lifetime constraints to the actual PeerConnection/DataChannels, provision
   capabilities outside the signal transport, and use durable shared replay
   state where restart and multi-process safety matter.
4. **Human trust:** comprehensible scopes, exact approval binding, name
   provenance, safe pairing, and revocation in future human-facing products.
5. **Privacy and secret hygiene:** explicit address-exposure policy and
   redacted logs in v1; minimal routing metadata and sealed payloads in a
   future confidentiality profile.
6. **Portability:** a language-neutral wire format, a small structural
   transport interface, and clean browser/server integration points. V1
   includes `InMemoryReplayStore`, not an in-memory transport adapter.
7. **Operations:** connection-success rate, authorization and setup latency,
   expiration behavior, quotas, availability, and audit completeness in a
   future hosted or application transport.
8. **Media breadth and data-plane performance:** only after control-plane
   invariants are measured and stable.

An application transport carries small, short-lived signaling bursts rather
than workload data. A future hosted transport should be optimized for many
waiting sessions, candidate bursts, duplicate delivery, reconnecting watches,
expiration, and denial of abusive clients—not bulk throughput.

Current package measurements and tests should cover:

- NodeID derivation and direct Ed25519 signature verification;
- exact capability signature, trust, scope, time, privacy, channel, and limit
  validation;
- canonical capability and signal digests across insertion order and Unicode;
- signal sequence, hash-chain, duplicate, equivocation, gap, and replay
  behavior;
- canonical-byte rejection before cryptography and atomic first-offer
  `compareAndReserve` behavior;
- close/deadline commit barriers across in-flight crypto, replay, and handler
  boundaries;
- fail-closed session-policy acknowledgement and sanitized clock, replay,
  injected-crypto, and external-signer failures;
- `InMemoryReplayStore` bounds, atomicity, failure, and process-local
  limitations; and
- stable errors and absence of secret or signaling content in diagnostics.

Future application transport and product measurements include:

- successful authorized-session establishment rate by client kind;
- authorization-decision and rendezvous-delivery latency percentiles;
- reconnect/resume success from every transport-persisted cursor;
- duplicate and replay records rejected without state divergence;
- sessions and grants expired within documented clock-skew bounds;
- zero secrets or candidate addresses in protocol diagnostics and audit logs;
- approval completion, denial, timeout, and abandonment rates;
- keyboard- and screen-reader-complete human ceremonies;
- direct versus relayed connection results, measured in the transport layer.

## Acceptance scenarios

### Implemented-v1 package acceptance

V1 should demonstrate:

1. Ed25519 public keys derive exact stable `wn1-` NodeIDs, and changing one bit
   changes the identity.
2. RFC 8785 canonicalization, signature inputs, signatures, and digests match
   the portable golden vectors.
3. The exact issuer-signed capability succeeds only for a locally trusted
   issuer and its precise subject, audience, session, action, resource,
   protocol, channels, privacy, service, profile, limits, and time window.
4. Changing any signed capability or signal field fails verification.
5. Direct peer signatures and per-sender signal hash chains accept exact
   duplicates but reject equivocation, a wrong predecessor, a sequence gap,
   an unprovable old signal, and sequence exhaustion.
6. Single-use capability state is bound atomically to the digest of the first
   fully verified offer. The original live session accepts an exact transport
   retry without applying it twice, while a conflicting offer fails closed. A
   new/restarted session also fails closed on a surviving shared reservation;
   losing an `InMemoryReplayStore` loses that protection, and v1 implements no
   persisted chain-state recovery.
7. `InMemoryReplayStore` enforces its process-local bounds and fails closed on
   replay-store error; tests do not present it as durable or replicated.
8. `createAuthenticatedSession` composes with an application-supplied fake
   `RendezvousTransport`: `outbound` produces a record that is canonicalized
   for publication, and `inbound` verifies the received canonical bytes
   without importing WebRTC or interpreting SDP.
9. Stable errors and ordinary diagnostics contain no private key, raw
   capability, signature, SDP, ICE candidate, TURN credential, or local
   address.

These scenarios use deterministic clocks, nonces, keys, and portable golden
vectors. Browser and real-network smokes supplement rather than replace the
model-level tests.

### Future product and integration acceptance

When the corresponding application components exist, they should also
demonstrate:

1. Two native services exchange capability-scoped signaling through a durable
   application transport and independently verify the same signal chains.
2. A browser and native sidecar exchange opaque signed signaling through an
   application network transport without that transport parsing SDP.
3. A CLI renders a capability for a human while JSON output contains the exact
   same claims and recomputed capability digest.
4. An autonomous client evaluates a request, receives `pending-approval`,
   resumes from an application transport cursor, and continues only after an
   approval bound to a future canonical pre-issuance request whose claims match
   the subsequently signed capability exactly.
5. A product refuses to issue or accept a capability when an approved target,
   resource, action, expiry, or privacy policy has changed.
6. Expired capabilities cannot start a new session. If future revocation is
   added, both new-connection and established-connection behavior follows its
   separately versioned policy.
7. The same NodeID hosts two services, and a capability for one cannot reach
   the other.
8. Two principals share a node, and audit output preserves exact `actor` and
   `onBehalfOf` values.
9. An application transport disconnects, resumes from its cursor, and neither
   loses nor applies a signed signaling record twice.
10. Product audits retain digests and stable decisions without raw
    capabilities, TURN secrets, SDP, ICE candidates, workload bytes, or local
    addresses.
11. A future specified pairing profile demonstrates equivalent QR and
    text-only keyboard/screen-reader ceremonies, including transcript binding,
    entropy, and attempt limits.
12. A future media offer requesting an unauthorized track or direction is
    rejected before negotiation; adding a new medium requires newly specified
    authority.

## Historical analogies

### Kubernetes API, controllers, and clients

[Kubernetes API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/)
demonstrate the value of one canonical machine API serving
controllers, command-line tools, and graphical interfaces. The analogy is the
separation of state and projections, not adopting its resource model or
operational complexity. Rendezvous should similarly avoid making the CLI or
web UI the source of truth.

### SSH host keys

[SSH's architecture](https://www.rfc-editor.org/rfc/rfc4251.html) makes endpoint
key identity visible and supports remembered first-use decisions.
The useful lesson is that a human name and a cryptographic endpoint are
different. Weave should improve on silent trust-on-first-use with explicit
issuer provenance, short-lived capabilities, and clear key-change handling.

### OAuth scopes and consent

[OAuth 2.0](https://www.rfc-editor.org/rfc/rfc6749.html) shows how a human-facing
consent view can describe machine-enforced
scopes and how an authorization decision can be separate from the resource
connection. V1 capabilities are short lived, single use, and bound to exact
source, target, and session NodeID semantics; every signal also requires a
direct signature by its asserted NodeID key. A future version could add a
separately specified ephemeral session-key confirmation rather than implying
that v1 already has one.

### WebAuthn and device-mediated approval

[WebAuthn](https://www.w3.org/TR/webauthn-3/) illustrates that a human ceremony
can authorize a precise
cryptographic operation while private key material stays inside a device or
trusted component. Rendezvous does not need to adopt WebAuthn as its NodeID
format to retain that separation.

### WebRTC signaling and media

[WebRTC](https://www.w3.org/TR/webrtc/) deliberately leaves signaling to the
application and separates it from
the media/data path. That makes a replaceable rendezvous interface natural,
but it also means WebRTC support alone is not an identity system, capability
issuer, human consent model, or complete multimodal product.

## Recommended product posture

Describe the first release as an **authenticated rendezvous building block
with a replaceable transport interface for WebRTC signaling**. It is
consumable by software and suitable for future human and agent projections.
It does not implement the transport, hosted rendezvous, issuer policy, agent,
UI, or “multimodal Weave.”

That posture preserves the useful universal boundary: every consumer can
authenticate capability-scoped signaling addressed to a cryptographic NodeID,
while delivery, identity presentation, policy approval, media semantics, and
workload behavior remain independent and replaceable layers.
