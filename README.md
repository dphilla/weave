# Weave

**Live migration for running WebAssembly workloads, across machines and across
runtimes.** Weave moves a *currently executing* Wasm module — its code, linear
memory, globals, tables, host-service state, and the live call stack down to
the exact instruction — from one spec-compliant runtime to another, where it
resumes as if nothing happened.

Verified end-to-end (all cases byte-identical to an uninterrupted run):

| # | scenario | verified |
|---|----------|----------|
| 1 | wasmtime → wasmtime, separate processes over TCP | ✅ |
| 2 | wasmtime → Node.js (V8, web WebAssembly API) | ✅ |
| 3 | Node.js → wasmtime | ✅ |
| 4 | wasmtime → wazero (pure Go) → Node.js triple chain | ✅ |
| 5 | Rust/LLVM-compiled guest migrated mid-computation | ✅ |
| 6 | checkpoint-to-file → restore on a fresh process | ✅ |
| 7 | mid-migration failure → source rewinds locally, continues seamlessly | ✅ |
| 8 | funcref table mutation, passive-segment semantics, SIMD state, deep/mutual recursion across checkpoints | ✅ |

Run the whole matrix: `./scripts/e2e.sh`

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
  shadow stack **inside linear memory** and returns; the whole native stack
  unwinds in microseconds.
- `__weave_resume` rebuilds the stack frame-by-frame from that shadow stack
  and continues at the exact instruction after the poll.

Because the shadow stack, saved globals, and funcref-table shadows all live in
linear memory, **a complete snapshot is just: memory bytes + a handful of
exported i32 control globals + host-service blobs**. Any embedder that can
read/write an exported memory, get/set an exported i32 global, and call an
export can host a migration — that's every spec-compliant runtime, with no
WASI and no engine internals.

## Live migration ("it never stopped")

Weave streams state vMotion-style, amortizing the transfer while the workload
keeps running:

1. **Pre-copy:** the source keeps executing; each `poll` streams a bounded
   budget of dirty 4 KiB pages (tracked by truncated SHA-256) peer-to-peer
   over TCP to the target, which applies them straight into a
   ready-instantiated instance. Rounds iterate until the dirty set converges.
2. **Stop-and-copy:** the guest unwinds (microseconds), and only the final
   delta — typically **0–2 pages** in our tests — plus control globals and
   service blobs cross during the pause.
3. **Verify & resume:** the target recomputes a SHA-256 over the *entire*
   received state and must match the source's hash before `__weave_resume`
   runs. On any failure at any point, the source rewinds locally and continues
   — migration is always safe to abandon.

Host functions with state (counters, accumulators, open resources) implement
the `HostService` interface: their state serializes into the snapshot and is
restored on the peer, so "external-but-interfaced" state moves too.

## Layout

```
crates/weave-core        shared model: meta section, wire protocol, snapshot, SHA-256
crates/weave-transform   the instrumenting compiler (the heart of Weave)
crates/weave-host        engine-agnostic: page tracker, migration source/target
crates/weave-wasmtime    wasmtime plugin (poll host fn, instance, serve node)
crates/weave-cli         `weave` binary: transform/run/checkpoint/restore/serve/migrate
js/weave.mjs             plugin for JS runtimes (browser-clean core: standard WebAssembly API)
js/weave-node.mjs        Node.js node runner (TCP transport + CLI)
go/weave-wazero          wazero (pure-Go) node runner
guests/                  test guests (WAT + Rust wasm32-unknown-unknown)
docs/                    DESIGN.md, ABI.md, PROTOCOL.md
scripts/e2e.sh           the full cross-runtime verification matrix
```

## Quickstart

```sh
cargo build -p weave-cli
W=target/debug/weave

# instrument a module (any core-wasm module; no WASI, no source changes)
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

Weave supports full core Wasm 2.0: MVP, multi-value, sign-extension,
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
- One workload per node process at a time (a node that migrated its workload
  away becomes idle and can receive another).
