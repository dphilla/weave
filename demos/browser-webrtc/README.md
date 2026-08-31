# Browser ↔ browser WebRTC migration

This demo moves one running woven WebAssembly instance from browser A to
browser B and back, without putting the migration bytes through an application
server:

```text
Browser A ⇄ reliable ordered RTCDataChannel ⇄ Browser B
                         Weave protocol v2

             A ⇄ bounded HTTP(S) signaling ⇄ B
                  offer / answer / ICE only
```

The browser adapter flattens DataChannel message boundaries into Weave's
`readExact(n)` byte stream, fragments writes into messages no larger than 16
KiB or the negotiated SCTP ceiling, applies finite backpressure and receive
bounds, and refuses unordered or partially reliable channels. The migration
protocol, state verification, and PREPARED/COMMIT ownership boundary are
unchanged. The automated browser qualification currently covers Chrome; other
standards-compatible browsers are expected but not yet a CI claim.

The byte adapter now comes from the reusable
`@weave-net/browser-transports` package. PeerConnection creation, signaling,
ICE handling, fixed A/B roles, and Weave control channels still live in this
demo; extracting that headless session is the next separately reviewed step.

## Run it locally

Prerequisites are Node.js 18 or newer, Rust/Cargo, and two current browser
tabs. From the repository root:

```sh
demos/browser-webrtc/run.sh
```

The launcher builds `weave`, transforms `guests/counter.wat`, writes the woven
module beneath `target/demo-artifacts/browser-webrtc/`, and starts the server
on <http://127.0.0.1:8790/>. Its printed launch URL includes a newly generated
192-bit local bearer token. No package install is involved.

1. Open the printed URL. It becomes peer A and creates a random 128-bit room
   identifier in the URL fragment.
2. Use **Open peer B**. Wait until both pages say `connected` and all three
   data channels are open.
3. In A, click **Start in peer A**, then **Migrate to other peer**.
4. B verifies the full state hash and continues at the captured instruction.
   The last A `EMIT n …` and first B emission must be `EMIT n+50000 …`.
5. Click **Migrate to other peer** in B to send the same instance back to A.

Each direction has a dedicated one-shot migration channel. Reload both pages
for another round trip; this makes channel lifetime and failure ownership
unambiguous in the demo.

To run the pieces manually or use another already-woven module:

```sh
cargo build --locked -p weave-cli
target/debug/weave transform guests/counter.wat \
  -o /tmp/counter.woven.wasm --period 256
node demos/browser-webrtc/server.mjs \
  --http 127.0.0.1:8790 --wasm /tmp/counter.woven.wasm
```

## What changes across real networks

Two local tabs need no external ICE service: host candidates are enough. Two
devices on a normal LAN often work the same way. Across NATs and firewalls,
three pieces become operational dependencies:

- **Signaling** carries SDP descriptions, certificate fingerprints, and
  trickled ICE candidates. WebRTC deliberately does not define signaling.
  This demo uses bounded HTTP long polling so it has no npm dependency.
- **STUN** lets a peer discover a public, NAT-mapped candidate. It does not
  relay the migration.
- **TURN** is the connectivity fallback when no direct candidate pair succeeds.
  A TURN-selected migration sends every state byte through that relay, so
  bandwidth and state-size policy matter much more here than for a video call.

Supply deployment-owned ICE configuration and credentials through your secret
environment (repeatable `--ice-server-json` flags are also supported):

```sh
WEAVE_SIGNAL_TOKEN='a-long-random-secret' \
WEAVE_ICE_SERVERS_JSON='[
  {"urls":"stun:stun.example.net"},
  {"urls":["turn:turn.example.net?transport=udp","turns:turn.example.net?transport=tcp"],"username":"user","credential":"password"}
]' \
node demos/browser-webrtc/server.mjs \
  --http 0.0.0.0:8790 \
  --wasm /tmp/counter.woven.wasm
```

Open the first page with `#token=a-long-random-secret`; its generated peer link
carries the token in the fragment. The fragment stays out of the initial page
request and Referer, then the app deliberately sends the token in
`Authorization` headers for config, module, and signaling requests. Prefer
environment/secret injection over credentials in shell history. Put the
server behind HTTPS before using it outside a trusted development network.

The demo token is shared service access, not per-room or per-role participant
identity: a holder can impersonate either role. Production needs short-lived
room/role credentials, occupancy enforcement, rate limits, and short-lived
TURN credentials. TLS and access control prevent an on-path network attacker,
but a malicious or compromised signaling service can still substitute SDP
fingerprints unless peer identity is bound and verified out of band.

The receiving tab also allowlists the exact SHA-256 and size of the woven
module it fetched from this server and caps accepted memory at 64 MiB. The
wire-level state hash proves consistency, not source identity or workload
authorization; other applications should supply their own `authorizeOffer`
policy, tighter quotas, and user consent before accepting and compiling a
peer-provided module.

The UI reports the selected ICE candidate types and labels a TURN path
explicitly. Test TURN/UDP and TURN/TCP/TLS from the actual networks you expect
to support; a public STUN server alone is not a reliable fallback.

## Should WebRTC become the one transport everywhere?

It is feasible, but it is not the best default for every edge. A native peer
can implement the same SCTP-over-DTLS-over-ICE stack, making WebRTC a common
browser↔browser, browser↔server, and server↔server transport. Doing so also
adds signaling, ICE lifecycle, DTLS/SCTP libraries, TURN qualification, and
larger operational costs to otherwise straightforward server links.

The recommended boundary is one Weave `ReliableOrderedByteStream` contract
with multiple host transports:

| Edge | Default transport | Why |
|---|---|---|
| browser ↔ browser | WebRTC DataChannel | Browser-native P2P and ICE traversal |
| browser ↔ native | WebRTC or the existing WebSocket bridge | Choose direct traversal vs deployment simplicity |
| native ↔ native on reachable networks | TCP | Smaller stack, easier operations, better bulk-transfer behavior |
| native ↔ native behind hostile NAT | Optional WebRTC backend | Use ICE/TURN only where it adds value |

A good next increment is a host-local Go/Pion WebRTC sidecar that converts one
DataChannel to the existing loopback TCP node interface. That proves
browser↔Wasmtime/Node/wazero/WAMR with one native WebRTC implementation before
embedding a stack in every runtime. Benchmark direct TCP, direct DataChannel,
and forced TURN before making native WebRTC a default.

WebTransport is not a replacement for this topology: the browser API is
browser-to-server, not browser-to-browser P2P.

Primary references for these boundaries are the
[W3C WebRTC Recommendation](https://www.w3.org/TR/webrtc/),
[RFC 8831 Data Channels](https://www.rfc-editor.org/rfc/rfc8831.html),
[RFC 8489 STUN](https://www.rfc-editor.org/rfc/rfc8489.html),
[RFC 8656 TURN](https://www.rfc-editor.org/rfc/rfc8656.html), and the
[W3C WebTransport draft](https://www.w3.org/TR/webtransport/).

## Host functionality and the plugin boundary

WebRTC moves bytes; it does not make DOM objects, sockets, file descriptors,
or other host resources serializable. Both tabs in this demo implement the
same in-process `env.emit` service and its portable 16-byte snapshot. Today's
`HostService` boundary is a stable name plus `snapshot()` and pre-COMMIT
`restore()`; versioning is only a naming convention. It does not yet provide
version negotiation, activation/abort hooks, or a generic ownership fence.

A production plugin/service contract still needs those lifecycle pieces for
external resources. That work belongs above transport and is the same whether
bytes travel by TCP, WebSocket, or WebRTC.

## Tests

Dependency-free unit and real-loopback signaling tests:

```sh
node --test \
  demos/browser-wamr/browser-transport.test.mjs \
  demos/browser-webrtc/server.test.mjs
```

They cover stream coalescing/splitting, fragmentation and negotiated message
ceilings, reliability rejection, receive/close bounds, ordered and idempotent
signaling in both directions, authorization, queue expiry/byte limits,
cross-site browser-request rejection, static-route allowlisting, and public-bind
protection. The optional real two-tab round trip needs Node 22+ and
Chrome/Chromium:

```sh
node demos/browser-webrtc/e2e-smoke.mjs --require
```

It starts isolated signaling and loopback STUN services, launches two pages in
a disposable Chrome profile, exercises bearer-protected config/module and
signaling routes, verifies the exact next counter event in both directions,
and cleans up every listener and process. This proves a real same-host
DataChannel and exercises STUN gathering; it does not assert a selected
server-reflexive/NAT or relay path. Pass `--artifacts PATH` to retain both tab
logs and screenshots.
