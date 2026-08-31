# Weave wire protocol (v2)

A migration uses one ordered byte stream dialed by the **source** toward the
**target**. Native nodes use TCP directly. Chrome carries the identical bytes
either inside binary WebSocket messages through the demo's WebSocket↔TCP relay
or directly to another browser over a reliable ordered RTCDataChannel. The
same framing carries the tiny native TCP control API used by `weave
migrate/status`.

Framing: `[type: u8][len: u32 LE][payload: len bytes]`. Strings are
`u32 LE length + UTF-8`. Max frame 64 MiB.

| # | frame | payload | direction |
|---|---|---|---|
| 1 | HELLO | proto u8, role u8 (1 src / 2 dst / 3 ctl), runtime str | both |
| 2 | MODULE_META | module_sha256 [32], size u64, meta blob (raw `weave.meta` payload, u32-prefixed) | src→dst |
| 3 | MODULE_NEED | — | dst→src |
| 4 | MODULE_HAVE | — (content-addressed cache hit) | dst→src |
| 5 | MODULE_DATA | offset u64, bytes (≤256 KiB chunks) | src→dst |
| 6 | MODULE_OK | — (module instantiated, ready for pages) | dst→src |
| 7 | MEM_LAYOUT | n u8, then n × pages u64 (64 KiB wasm pages per memory) | src→dst |
| 8 | PAGE | mem u8, page_no u64 (4 KiB units), 4096 bytes | src→dst |
| 9 | ROUND_END | round u32, pages_sent u64 | src→dst |
| 10 | ROUND_ACK | — | dst→src |
| 11 | FINAL_BEGIN | — (guest has unwound; stop-and-copy begins) | src→dst |
| 12 | GLOBALS | u16 count × { name str, value u32 } | src→dst |
| 13 | SERVICES | u16 count × { name str, blob u32-prefixed } | src→dst |
| 14 | FINAL_END | state_sha256 [32] | src→dst |
| 15 | PREPARED | — (state verified/restored; target is not executing) | dst→src |
| 16 | ABORT | code u32, msg str | both |
| 17 | CTL_MIGRATE | target addr str | ctl→node |
| 18 | CTL_STATUS | — | ctl→node |
| 19 | CTL_OK | msg str | node→ctl |
| 20 | CTL_ERR | msg str | node→ctl |
| 21 | COMMIT | — (irreversible ownership transfer) | src→dst |
| 22 | COMMIT_OK | — (target observed COMMIT) | dst→src |

## Phases

1. **HELLO** both ways (version check).
2. **Module sync** by content hash; the target instantiates immediately
   (without `__weave_init`) so pages stream directly into place. Bundled
   runners currently initiate a cold cache-miss sync at a guest poll point;
   its transfer and compilation time precede pre-copy and add to downtime.
   Every target rejects a core Wasm start section before instantiation: the
   transformer folds the original start into `__weave_init`, and executing
   guest code while a target is only staged would violate ownership safety.
3. **Pre-copy**: any number of MEM_LAYOUT/PAGE frames while the source guest
   keeps executing; ROUND_END/ROUND_ACK delimit full passes (ACK doubles as
   backpressure). All-zero never-sent pages are elided. Dirty detection is
   truncated SHA-256 per page — content-based, since Wasm has no dirty bits.
4. **Stop-and-copy**: FINAL_BEGIN, final page delta (which now includes the
   guest's self-spilled call stack and saved globals), GLOBALS, SERVICES,
   FINAL_END.
5. **Prepare**: the target recomputes the state hash and restores the globals
   and fresh, isolated service objects. Mismatch or restore failure → ABORT,
   and the source rolls back. Match → PREPARED. The target remains stopped.
6. **Commit**: receipt of PREPARED is the source's irreversible ownership
   boundary. It sends COMMIT and retires locally even if that write or the
   following acknowledgement is lost. The target may resume only after it
   receives COMMIT, and then attempts COMMIT_OK. A COMMIT_OK delivery failure
   cannot revoke target ownership.

Protocol 2 deliberately chooses at-most-one active executor over availability
during an ambiguous final network failure. Before PREPARED, the source can
always rewind. After PREPARED, an unconfirmed COMMIT is reported as such and
the source must not rewind; if COMMIT never reached the target, neither copy
runs. Node control APIs return `CTL_ERR` with a `commit uncertain:` message in
that case, even though the source has irreversibly retired; callers must not
retry by resuming the source. Durable exactly-once failover across
process/machine crashes would
require a coordinator or application-level fencing beyond this peer protocol.
Version-1 peers are rejected during HELLO rather than being allowed to
misinterpret frame 15's old semantics.

## State hash

`SHA-256` over, in order:

```
"WVSH"
u32 LE  number of memories
per memory (index order):  u64 LE byte length, then the full contents
u32 LE  number of control globals
per global (meta order):   u32 LE name length, name bytes, u32 LE value
u32 LE  number of services
per service (UTF-8-byte order): u32 LE name length, name bytes,
                                u64 LE blob length, blob bytes
```

Implemented independently in Rust (`weave-core`), JS (`weave.mjs`) and Go
(`weave-wazero`). Wasmtime and WAMR share the Rust protocol implementation;
every cross-runtime migration is an implicit conformance test.

## Node roles

A *node* (`weave serve`, `weave-node.mjs serve`, `weave-wazero serve`, or
`weave-wamr serve`) is symmetric: it runs at most one workload, accepts CTL
commands, migrates out on CTL_MIGRATE (the poll loop picks the request up while
the workload runs), and accepts incoming migrations when idle (busy nodes
ABORT(9) new offers). Chains (A→B→C…) fall out of the symmetry. A browser tab
has the same source/target behavior but exposes it through the demo UI rather
than the raw-TCP control API.

Service restore runs only on newly created, non-executing target service
objects. A `HostService` restore implementation must stage internal state
without externally visible effects; publishing ownership of a socket, lease,
or other external resource belongs after COMMIT and requires an
application-defined fencing scheme. The current interface has only a stable
name, `snapshot()`, and `restore()`; version negotiation, activation/abort
hooks, and a generic fence are future plugin-contract work. Service names and
ordering must match exactly before PREPARED.

## Transports

The JS core (`js/weave.mjs`) is transport-agnostic. It needs
`{ readExact(n) -> Promise<Uint8Array>, write(bytes) -> Promise }`;
the application-neutral packages under [`packages/`](../packages/) supply
bounded TCP, WebSocket, and reliable ordered RTCDataChannel implementations.
`weave-node-transport.mjs` re-exports the Node package, while
`weave-browser.mjs` adds Weave's protocol defaults and relay helpers:

```js
import { acceptRelay, connectRelay } from "./weave-browser.mjs";

const sourceStream = await connectRelay(relayUrl, "wamr");
const targetStream = await acceptRelay(relayUrl);
```

RTCDataChannel is message-oriented, so the adapter discards its message
boundaries, coalesces reads, and fragments logical writes into at most 16 KiB
messages, further clamped to the negotiated SCTP maximum. It rejects unordered
and partially reliable channels, bounds unread input, and propagates
`bufferedAmount` backpressure. The channel subprotocol is `weave.v2`;
WebRTC's SCTP/DTLS/ICE layers are transport beneath the Weave frame protocol,
not new Weave frame types.

The root [`demos/browser-wamr`](../demos/browser-wamr/) relay implements both
directions: `/v1/connect/:alias` dials an allowlisted native target, while
`/v1/accept` reserves a browser target and pairs it with the next connection
to a dedicated TCP ingress port. That prefix versions the relay HTTP API, not
the carried Weave v2 stream. Chrome cannot listen on or dial raw TCP.
Its byte-transparent WebSocket-to-duplex bridge comes from
`@weave-net/ws-tcp-gateway`; routing, authentication, target policy, and the
minimal WebSocket server remain demo integration concerns.

The [`browser-webrtc`](../demos/browser-webrtc/) demo keeps WebRTC signaling
separate. Its bounded HTTP service exchanges opaque SDP offer/answer and ICE
candidate JSON with idempotent POST request IDs; migration frames flow only
over the established DataChannel. The application-neutral
`@weave-net/webrtc-session` package owns the fixed-role initial negotiation,
trickled ICE ordering, and PeerConnection lifecycle; the demo still owns HTTP
rooms/authentication, its channel allowlist, and every Weave message. Its
target allowlists the served demo module through `acceptMigration`'s
offer-admission hook. Host candidates are
sufficient for the local demo. Cross-network deployments normally add STUN
discovery and a TURN fallback; a TURN-selected path relays all migration bytes
and should be budgeted accordingly.

Protocol v2 does not authenticate or encrypt its native TCP transport. WebRTC
DataChannels are DTLS-protected, but HTTPS and signaling access control only
authenticate the signaling service and protect against on-path attackers. A
malicious signaling service can still substitute connection descriptions and
fingerprints unless peer identity is independently bound. The demos default
to loopback listeners and use bearer/origin checks where they can be exposed;
use an explicit public-origin/reverse-proxy policy, per-peer authorization,
narrow workload/target allowlists, quotas, and a firewall or authenticated
native ingress in production.

Targets enforce implementation policy before guest-memory allocation: the
bundled hosts cap a received module, inspect its declared initial memories
before instantiation, and default to 1 GiB aggregate linear memory during
restore. These are deployment limits, not extra wire fields, and custom hosts
may choose stricter limits.
