# Browser ↔ native WebRTC sidecar

This demo moves one running woven WebAssembly workload from Chrome/V8 to an
unmodified Wasmtime TCP node and back through one generic WebRTC sidecar:

```text
Chrome/V8
  RTCDataChannel (weave.v2)
        ↕
weave-rtc (Go/Pion, no Weave frame knowledge)
  loopback TCP
        ↕
Wasmtime node
```

The Node controller serves the page and forwards bounded offer, answer, and
ICE messages between its HTTP rendezvous and the sidecar's versioned NDJSON
process interface. Migration bytes never enter HTTP, the signaling queues, or
the sidecar control stream.

Two reliable ordered DataChannels are negotiated in the initial offer. The
`browser-to-native` mapping lazily dials the native node on its first non-empty
binary payload, so a human can inspect the page without tripping the native
node's initial-frame deadline. The `native-to-browser` mapping exposes a
single-use loopback TCP listener. Each channel carries one byte-stream session
and closes symmetrically when either endpoint finishes.

## Run it

Prerequisites are Rust/Cargo, Go, and Node.js 18 or newer. From the repository
root:

```sh
demos/browser-sidecar/run.sh
```

The runner builds `weave` and `weave-rtc`, transforms the counter fixture into
a disposable temporary directory, launches an empty Wasmtime node, and prints
a token-bearing local browser URL. Open that URL in a current browser.

1. Wait for both data channels and the generated module to be ready.
2. Select **Start in browser**.
3. Select **Migrate to native**. The browser pre-copies and commits the live
   workload to Wasmtime through `browser-to-native`.
4. Select **Arm browser target**.
5. Run the exact `weave migrate` command printed by the controller. Wasmtime
   dials the sidecar's one-shot ingress mapping and returns the workload over
   `native-to-browser`.

The last `EMIT n …` at each source and the first target event should be
`EMIT n+50000 …`. Stop the controller with Ctrl-C. Its child processes and
temporary build directory are closed by their owning process and runner.

Custom ICE configuration is repeatable:

```sh
demos/browser-sidecar/run.sh \
  --ice-server-json '{"urls":"stun:stun.example.net"}' \
  --ice-server-json '{"urls":"turns:turn.example.net","username":"short-lived","credential":"secret"}'
```

TURN credentials belong in a secret-injection mechanism for a real deployment,
not shell history. The demo's bearer token protects its bounded signaling and
module routes; it is not peer identity or workload authorization.

## What is reusable

`weave-rtc` is an independently buildable process. It accepts exact channel
label/protocol mappings and bridges binary reliable ordered DataChannels to
caller-selected TCP dial/listen endpoints. It does not import Weave, parse the
Weave v2 frames, start a Wasm runtime, implement HTTP signaling, select rooms,
or know that these bytes represent a migration.

The integration is language-independent in two separate senses:

- The control boundary is bounded, versioned JSON records over stdin/stdout;
  any process supervisor can implement it.
- The data boundary is an ordinary TCP byte stream; all existing Wasmtime,
  Node, wazero, and WAMR adapters already implement it without linking Pion.

This increment directly qualifies Wasmtime. Compatibility with the other
native adapters follows from their shared TCP protocol but is not yet a claim
that every adapter has run through this sidecar in CI.

The sidecar intentionally leaves signaling transport, retry/deduplication,
identity, authorization, discovery, TURN credential issuance, application
channel policy, and workload lifecycle to its caller. Its v0.1 session is
fixed-role, one-negotiation, and single-use per mapping; it does not yet offer
renegotiation, ICE restart, connection pooling, or a multi-tenant daemon.

## Test it

The controller and route tests need no browser:

```sh
node --test \
  demos/browser-sidecar/controller.test.mjs \
  demos/browser-webrtc/server.test.mjs
```

The required real-browser harness needs Node 22+, Chrome/Chromium, built
`weave` and `weave-rtc` executables, and a woven counter fixture:

```sh
node demos/browser-sidecar/e2e-smoke.mjs \
  --require \
  --sidecar /path/to/weave-rtc \
  --weave /path/to/weave \
  --wasm /path/to/counter.woven.wasm \
  --artifacts /tmp/weave-browser-sidecar
```

The centralized `.github/ci/browser-sidecar-smoke.sh` builds those inputs,
starts a deterministic loopback STUN responder, launches real Chrome, performs
Chrome → Wasmtime → Chrome, checks the exact next counter index at both
ownership boundaries, and verifies that the `first-data` mapping reports RTC
readiness without a local dial before migration bytes arrive. It records the
browser and sidecar views of the selected ICE path separately, plus the
sidecar control trace and diagnostics, and cleans up its exact processes. It
proves same-host ICE and Pion/browser interoperability; it does not prove a
selected server-reflexive route or a forced TURN path.

## Security boundary

The sidecar's `listen` mapping is loopback-only, ephemeral, and accepts one
connection. That prevents network exposure but is not authentication against a
malicious local process racing the port. A production local daemon should use
an authenticated attachment protocol or Unix-domain peer credentials. Adding
an undisclosed preamble here would make the existing native runtimes stop being
unchanged, so that security boundary remains explicit rather than hidden.

WebRTC encrypts the DataChannel, including through TURN, but a malicious
signaling service can still substitute SDP fingerprints. Production also
needs application-level peer identity and a narrowly scoped workload
capability. Those policies sit above this byte bridge.
