# Weave

> AI Disclaimer: Worked on this/toyed with for years pre-ai; used AI-assistance starting in 2026; this project is *not* vibecoded

**Live migration for portable WebAssembly workloads, across machines and
across runtimes.** Weave moves a *currently executing* woven module — its
code, linear memory, globals, tables, host-service state, and live call stack
down to the exact instruction — between supported runtime adapters, where it
resumes as if nothing happened.

Verified end-to-end. The native/Node/wazero matrix compares the complete
host-visible event stream with an uninterrupted golden run; the real Chrome
smoke checks that the first newly observed event has the exact next counter
index at every runtime boundary:

| # | scenario | verified |
|---|----------|----------|
| 1 | wasmtime → wasmtime, separate processes over TCP | ✅ |
| 2 | wasmtime → Node.js (V8, web WebAssembly API) | ✅ |
| 3 | Node.js → wasmtime | ✅ |
| 4 | wasmtime → wazero (pure Go) → Node.js triple chain | ✅ |
| 5 | Rust/LLVM-compiled guest migrated mid-computation | ✅ |
| 6 | checkpoint-to-file → restore on a fresh process | ✅ |
| 7 | pre-commit migration failure → source rewinds locally, continues seamlessly | ✅ |
| 8 | funcref table mutation, passive-segment semantics, SIMD state, deep/mutual recursion across checkpoints | ✅ |
| 9 | wasmtime → WAMR → wasmtime, including multiple memories and a cleared active data segment | ✅ |
| 10 | Chrome → WAMR → Chrome → WAMR through WebSocket↔TCP relay | ✅ |
| 11 | Chrome A → Chrome B → Chrome A directly over WebRTC DataChannels | ✅ |

Run the native/Node/wazero matrix with `./scripts/e2e.sh`. Runnable, verified
three-runtime server and direct browser-peer examples live in
[`demos/server-chain`](demos/server-chain/) and
[`demos/browser-webrtc`](demos/browser-webrtc/); the Chrome/WAMR bridge remains
in [`demos/browser-wamr`](demos/browser-wamr/).

## How is that possible?

Wasm runtimes expose no way to read a live execution stack, and every engine
represents it differently — so Weave doesn't ask them to. Instead,
`weave transform` rewrites the module so it can **capture and rebuild its own
execution state using nothing but standard Wasm semantics**:

- Control flow of checkpointable functions is flattened into a
  `loop`+`br_table` dispatch over flat blocks, and the operand stack is
  registerized into locals — so "everything live" is exactly *locals + a block
  index*.
- A single injected import, `weave.poll: [] -> [i32]`, is called at function
  entries and loop back-edges (amortized by an in-guest countdown). When it
  returns nonzero, every frame spills its locals and program counter into a
  shadow stack **inside linear memory** and returns; the measured fixtures
  unwind in microseconds (cost scales with live call depth and saved state).
- `__weave_resume` rebuilds the stack frame-by-frame from that shadow stack
  and continues at the exact instruction after the poll.

Because the shadow stack, saved globals, and funcref-table shadows all live in
linear memory, **a complete snapshot is just: memory bytes + a handful of
exported i32 control globals + host-service blobs**. Any embedder that can
read/write an exported memory, get/set an exported i32 global, call an export,
and provide the workload's host imports can host a migration. No engine stack
API is required.

## Live migration ("it never stopped")

Weave streams state vMotion-style, amortizing the transfer while the workload
keeps running after the module has been synchronized:

1. **Pre-copy:** the source keeps executing; each `poll` streams a bounded
   budget of dirty 4 KiB pages (tracked by truncated SHA-256) over a byte
   stream to the target, which applies them straight into a
   ready-instantiated instance. Rounds iterate until the dirty set converges.
2. **Stop-and-copy:** the guest's stack-unwind mechanism itself takes
   microseconds. The remaining pause includes transfer of the final delta —
   typically **0–2 pages** in our tests, but potentially much larger for a
   high-dirty workload — plus target verification and commit.
3. **Verify & commit:** the target recomputes a SHA-256 over the *entire*
   received state and stages it without executing. It sends `PREPARED`; the
   source then sends an irreversible `COMMIT` and retires, and only then may
   the target run `__weave_resume`. Before `PREPARED`, failure rewinds locally.
   After it, a lost confirmation is reported as an uncertain commit and never
   causes both copies to execute (availability can be lost, but ownership is
   not duplicated).

Host functions with portable state implement the `HostService` interface:
their state serializes into the snapshot and is restored on the peer, so
explicitly modeled "external-but-interfaced" state moves too.

## Layout

```
crates/weave-core        shared model: meta section, wire protocol, snapshot, SHA-256
crates/weave-transform   the instrumenting compiler (the heart of Weave)
crates/weave-host        engine-agnostic: page tracker, migration source/target
crates/weave-wasmtime    wasmtime plugin (poll host fn, instance, serve node)
crates/weave-cli         `weave` binary: transform/run/checkpoint/restore/serve/migrate
packages/                reusable byte transports, headless WebRTC session, and gateway core
js/weave.mjs             plugin for JS runtimes (browser-clean core: standard WebAssembly API)
js/weave-browser.mjs     Weave defaults and compatibility exports for browser transports
js/weave-node.mjs        Node.js node runner (TCP transport + CLI)
go/weave-wazero          wazero (pure-Go) node runner
wamr/                    WAMR 2.4.4 adapter and symmetric node CLI
demos/                   runnable server-chain, browser-P2P, and Chrome↔WAMR examples
guests/                  test guests (WAT + Rust wasm32-unknown-unknown)
docs/                    DESIGN.md, ABI.md, PROTOCOL.md
scripts/e2e.sh           compatibility shim into the centralized native E2E
scripts/cleanup.sh       safe allowlisted local artifact cleanup shim
.github/ci/              centralized CI commands, pins, conformance, and setup
.github/workflows/       thin PR/main/nightly/corpus/qualification orchestration
```

The networking pieces under `packages/` are dependency-free, installable ESM
packages rather than demo internals. Their public boundaries, examples,
compatibility shims, and clean-package verification are documented in
[`docs/NETWORK_PACKAGES.md`](docs/NETWORK_PACKAGES.md).

For a real browser round trip, continue with the
[`browser ↔ browser WebRTC demo`](demos/browser-webrtc/README.md) or the
[`Chrome ↔ WAMR demo`](demos/browser-wamr/README.md). The
[`three-server chain`](demos/server-chain/README.md) is the shortest verified
cross-runtime native walkthrough.
For the required and scheduled verification topology, local replay commands,
and artifact policy, see [`docs/CI.md`](docs/CI.md).

## Quickstart

```sh
cargo build -p weave-cli
W=target/debug/weave

# instrument a supported core-Wasm module (no source changes)
$W transform app.wasm -o app.woven.wasm

# node B (empty, will receive)
$W serve --listen 10.0.0.2:7777 &
# node A (runs the workload)  — Node.js works identically: js/weave-node.mjs serve ...
$W serve --listen 10.0.0.1:7777 --module app.woven.wasm --pre-woven --invoke run --arg 5000000 &

# move the *running* workload from A to B
$W migrate --node 10.0.0.1:7777 --to 10.0.0.2:7777
# => ok: migrated: 10 rounds, 1714 pages total, 1 in pause window
```

Checkpoint to disk instead of migrating:

```sh
$W checkpoint app.woven.wasm --pre-woven --invoke run --arg 5000000 --after-polls 100 -o app.snap
$W restore    app.woven.wasm app.snap --pre-woven   # resumes exactly where it stopped
```

## Support matrix

The transformer supports core Wasm 2.0: MVP, multi-value, sign-extension,
saturating truncation, bulk memory, reference types (funcref), SIMD (v128),
multiple memories, and `return_call*` (lowered to call+return). Funcref tables
may be mutated and grown at runtime — Weave shadows every funcref with its
function index and rehydrates through a canonical table on restore. Passive
data/element segments keep exact drop/trap semantics across migrations.

Rejected at transform time, with precise diagnostics (see
`docs/DESIGN.md#support-matrix` for the reasoning — these are semantic
boundaries, not gaps):

- **shared (threaded) memories** — checkpointing concurrently-mutated memory
  requires stop-the-world across threads;
- **externref state** — opaque host references cannot be serialized by any
  portable mechanism; use i32 handles + a `HostService` (that pattern *is*
  migratable);
- exceptions, GC types, memory64.

Runtime capabilities still have to overlap. The bundled WAMR CLI enables the
classic interpreter, bulk memory, SIMD, reference types, and multiple
memories, and currently supplies only the three `env.emit*` sample services.
Chrome cannot directly start an export with a public `v128` parameter or
result; use a scalar guest wrapper. It can receive and resume a workload whose
internal state uses SIMD.

## Guarantees & caveats

- State moves **bit-exactly** (including NaN payloads); an end-to-end SHA-256
  over the full migrated state gates the resume.
- Checkpoints happen at poll sites (function entries + loop back-edges). A
  workload that makes no calls and runs no loops between two points cannot be
  interrupted between them — by construction there is always a poll site on
  any unbounded execution path.
- Nondeterministic *hosts* (a service returning wall-clock time, say) remain
  nondeterministic; Weave moves state faithfully but does not make your host
  functions pure.
- Every target requires an exact, byte-compatible host-service set. Open
  files, sockets, DOM nodes, JavaScript closures, GPU objects, and arbitrary
  WASI state do not migrate unless modeled by such a service.
- Native protocol-v2 nodes speak unauthenticated TCP. Browser demo servers are
  loopback-only by default; the browser-peer launcher generates a local access
  token. Use per-peer authorization, explicit origin/proxy policy, module
  allowlists, quotas, and TLS before exposing signaling or relay endpoints to
  a network. WebRTC encrypts DataChannels but does not authenticate
  application-level migration policy or a malicious signaling service.
- Incoming modules are capped at 512 MiB in Rust/JS (256 MiB in wazero), and
  aggregate memory accepted at handoff is capped at 1 GiB by default. This is
  not a lifetime cap on later guest `memory.grow` instructions.
- A target cache miss synchronizes and compiles the module before pre-copy.
  The current runners start that work at a guest poll point, so cold transfer
  time is additional downtime and can dominate for a large module. Distribute
  or pre-warm the content-addressed module on targets when low pause time is a
  requirement. The same applies to a very large final dirty set or full-state
  verification; the migration stays bounded-memory, not constant-latency.
- One workload per node process at a time (a node that migrated its workload
  away becomes idle and can receive another).
