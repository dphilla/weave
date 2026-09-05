# Weave — Design

This document explains *why* Weave is built the way it is: how you can move a
running portable Wasm workload between runtime adapters when none of their
engines exposes its execution stack, and where the semantic boundaries of
that capability lie.

Prior art shaped the constraints but not the mechanism. CRIU freezes Linux
processes via kernel APIs; vMotion iteratively pre-copies VM memory with
hardware dirty tracking; Loophole Labs' Architect migrates via Firecracker
snapshots. All three rely on a privileged substrate that can observe the
workload from below. Wasm runtimes offer no such substrate — a wasmtime stack
frame, a V8 frame and a wazero frame share nothing — and the whole point of
Weave is to be substrate-independent. So Weave takes the opposite route:
**the workload is compiled into a form that can observe and reconstruct
itself**, and the host's role shrinks to moving bytes it can already reach
through the standard embedding API.

## 1. The transform

`weave-transform` is a whole-module Wasm→Wasm compiler (`wasmparser` in,
`wasm-encoder` out; typing driven by wasmparser's validator so there is no
hand-maintained instruction table to drift out of sync).

### 1.1 Which functions get instrumented

A function is *instrumented* iff it can remain live on the native stack
unboundedly long:

- it contains a `loop`, or
- it makes an indirect call (unknown callee, conservative), or
- it sits on a call-graph cycle (Tarjan SCC — this is what makes pure
  recursion like `fib` checkpointable), or
- it (transitively) calls any instrumented function — computed as a fixpoint,
  which gives the complementary invariant: **a non-instrumented function can
  never have an unwind pass through it**, so it needs no frame spill machinery.

Functions that touch funcref tables/globals or passive segments are *flattened*
(they need the shadow/gating machinery below) even when they don't need
checkpoint sites. Functions using memory 0 are also flattened for logical
memory bounds and growth, and every tail call is lowered even in a leaf
caller. Other non-instrumented functions are re-encoded verbatim.

### 1.2 Flattening + registerization

Instrumented functions are lowered out of structured control flow entirely:

```
block $bad
  loop $dispatch
    block bN-1 … block b0
      (br_table (local.get $pc) b0 b1 … bN-1 $bad)
    end  ;; flat block 0 code … explicit terminator
    end  ;; flat block 1 …
    …
  end
end
unreachable
```

Every operand-stack value is assigned a local keyed by `(stack depth, type)`
("registerization"). This costs code size and some speed — Weave's stated
priority is completeness and exactness over performance — and buys the
property that makes everything else simple: **at any point, the complete live
state of a function is exactly its locals plus `$pc`**. There is never a live
wasm operand stack across a checkpoint site, because every value lives in a
local between instructions.

Branch argument shuffles route through trampoline blocks so a `br_if`'s taken
path can't clobber slots the fall-through still needs. `br_table` lowers to a
nested-block jump pad. `return_call*` lowers to `call`+`return` (identical
semantics; trades tail-stack behavior for checkpointability). Dead code is
tracked with validator-grade reachability and simply not emitted.

### 1.3 Unwind / rewind

Checkpoint sites are (a) a counter-gated `weave.poll` at every instrumented
function entry and loop back-edge, and (b) an unwind check after every call
that can transitively unwind. The countdown global amortizes host-call cost:
one host call per `poll_period` site executions (default 512).

**Unwind:** poll returns nonzero → `__weave_state = UNWINDING` → the innermost
function writes `[func_id, resume_pc, all spillable locals]` into the shadow
stack in linear memory and returns a dummy value; each caller's check does the
same. The entry wrapper observes the unwind, saves all mutable application
globals into the weave region (via generated `$globals_save` — required
because JS hosts cannot read v128 or funcref globals through the API), records
which entry was live, and sets `__weave_flag = UNWOUND`. The unwind cost
scales with live call depth and saved state; it is microseconds in the test
fixtures, and is only one component of total handoff downtime.

**Rewind:** the host calls `__weave_resume`. It reloads application globals,
rehydrates funcref tables, sets state to REWINDING and re-enters the recorded
entry with dummy arguments. Each instrumented function's prologue notices
REWINDING, pops its frame, restores locals and `pc`, and the dispatch loop
re-executes the *call instruction* that was live — rebuilding the native stack
frame-by-frame. The innermost frame (detected by `sp == stack_base`) flips
state to RUN and execution continues on the instruction after the poll.

The shadow stack grows by `memory.grow` and relocates itself (copying live
frames) on overflow. Frame headers carry the function id; a mismatch traps
immediately rather than corrupting silently.

Private allocations occupy a suffix of physical memory 0. The region's first
u32 records the current guest-visible page count; guest `memory.size` reads
that value, and guest accesses use unsigned, overflow-safe logical bounds.
Guest `memory.grow` enforces the original declared maximum, grows physical
memory, shifts the entire private suffix, updates its pointers, and clears the
new guest pages. Guest addresses and active data-segment offsets remain
unchanged. This keeps single-memory runtime compatibility without exposing
checkpoint storage through guest memory instructions. A host-owned imported
primary memory with a finite maximum is rejected because its capacity cannot
be changed by transformation; physical allocation failures remain possible.

### 1.4 Why the snapshot is so small a concept

Everything the guest self-spills lands in linear memory. Mutable globals are
saved into linear memory. Funcref table contents are shadowed as i32 function
indices in linear memory. Therefore:

> **snapshot = memory contents + a fixed list of exported mutable i32 control
> globals + one opaque blob per host service.**

The host-side guest ABI never exceeds: read/write exported memory, get/set
exported i32 globals, and call exports. A runtime also has to supply the
module's declared imports and transport. This small surface is why the same
state model works in wasmtime, V8/Chrome, wazero, and WAMR without engine
stack APIs.

### 1.5 Funcrefs, tables, segments

Function references cannot cross machines (they're engine pointers), but their
*identity* can: the transformer appends a canonical table containing every
function and shadows each funcref value with its index (`ref.func k` → shadow
`k`; `table.get` reads the table's shadow array; null → −1). Spills store the
shadow; restores rebuild the ref via `table.get $canon`. Runtime table
mutation (`table.set/grow/fill/copy/init`) goes through generated helpers that
maintain per-table shadow arrays in memory, and `__weave_resume` rehydrates
real tables (growing them as needed) from those arrays. Modules that never
mutate tables pay none of this.

Passive data/element segments have observable drop-state. Weave never actually
drops a segment (a restored instance on a fresh instantiation must still have
it); instead `data.drop`/`elem.drop` set flag bytes in the weave region and
`memory.init`/`table.init` are gated to reproduce exact spec trap semantics —
including "init after drop traps" *after a migration*. The module's original
`start` is folded into `__weave_init`, which runs on fresh starts only, so
initialization side effects don't replay on restore.

### 1.6 Support matrix, with reasons

Supported core-Wasm proposals: MVP, multi-value, sign-ext, sat-trunc, bulk
memory, funcref reference types, SIMD/v128, multiple memories, and tail calls
(lowered). Rejected with diagnostics:

- **Shared memories / threads.** A consistent checkpoint of concurrently
  mutated memory requires stopping all threads at safepoints simultaneously;
  without a cross-thread barrier protocol any snapshot could be torn. This is
  a real theorem, not an implementation gap; a future multi-threaded Weave
  would need poll-rendezvous across threads.
  Atomic instructions on unshared memories are also rejected explicitly.
- **externref.** An externref is an opaque handle to *host* state; no portable
  serialization can exist by definition. The migratable pattern — i32 handles
  plus a `HostService` that owns and serializes the actual state — is exactly
  what Weave's service layer provides.
- **funcref in public function signatures.** Would require rewriting every
  signature (shadow parameters) including indirect-call types; LLVM/Go/Rust
  toolchains never emit it (function pointers are table indices). Rejected
  rather than half-supported.
- **exceptions / GC / memory64 / table64**: out of scope for the current guest ABI; each
  is a bounded, known extension of the same machinery.

Unsupported table widths, exception tags/instructions, and GC instructions
(including constant expressions) are checked before general input validation.
They produce explicit unsupported-feature diagnostics instead of reaching
instrumentation or looking like malformed supported input. Supported inputs
still undergo full input and generated-output validation.

## 2. The protocol (amortization)

See `docs/PROTOCOL.md` for the frame grammar. The design goals: peer-to-peer
(source dials target directly), streaming (the target applies pages into a
live instance as they arrive), and amortized (after module synchronization,
the workload keeps running through the bulk of the memory transfer).

- **Iterative pre-copy.** Dirty tracking is content-based (truncated SHA-256
  per 4 KiB page) because Wasm gives no write-protection or dirty bits; a
  cryptographic digest is mandatory since a missed dirty page is silent
  corruption. All-zero pages are elided. Because instantiation applies active
  data segments, every restore target explicitly clears all memories before
  it accepts sparse pages; “fresh instance” alone is not a zero baseline.
  Each `poll` scans/sends a bounded byte budget, so the guest's pause per poll
  is bounded; rounds repeat until a round re-sends ≤ threshold pages (or a
  round cap).
- **Stop-and-copy.** The unwind puts the live stack *into memory*; the final
  round therefore automatically carries the call stack, saved globals and
  service state as ordinary page deltas plus two small frames. Measured final
  deltas in the test matrix are 0–2 pages. Total downtime also includes
  streaming that delta, hashing the complete staged state, and commit; a
  high-dirty workload can therefore have a materially longer pause while
  still using bounded host memory.
- **Verification.** The target recomputes SHA-256 over the complete final
  state (all memories + control globals + service blobs) and must match the
  source's `FINAL_END` hash before it acknowledges. Three independent
  implementations (Rust, JS, Go) of the hash stream agree byte-for-byte —
  this is checked implicitly by every cross-runtime migration.
- **Prepare/commit ownership.** Until `PREPARED`, the source still holds a
  complete checkpoint and any error rewinds locally (covered by an explicit
  kill-the-target-mid-stream test). `PREPARED` is the irreversible boundary:
  the source sends `COMMIT` and retires even if `COMMIT_OK` is lost, while the
  target cannot execute before receiving `COMMIT`. This prevents split-brain
  execution; an ambiguous commit may sacrifice availability instead.

Single-threaded hosts (JS) cannot do socket work while the guest runs, so the
JS plugin uses *unwind-yield*: poll requests an unwind on a time slice, the
host does its async round, then immediately rewinds. Same guest ABI, same
protocol, different host scheduling — which is the point of putting the
machinery in the guest.
Fresh initialization is synchronous and suppresses yield polls until the
original start completes. Runtime-specific automatic startup exports are
disabled during instantiation so staging never executes guest code.

Chrome has no raw TCP API. `js/weave-browser.mjs` adapts binary WebSocket
messages to the same bounded byte-stream interface, and the demo relay bridges
them to native TCP in both directions. See
[`BROWSER_WAMR.md`](BROWSER_WAMR.md) for the exact portable workload contract.

## 3. Host services

Host functions are the one thing that genuinely lives outside the module. Weave
requires stateful host interfaces to implement:

```
name() -> stable identifier        snapshot() -> bytes        restore(bytes)
```

Blobs ride in the snapshot/protocol (sorted lexicographically by UTF-8 name
bytes and hashed with everything else). Both peers must register the exact
same service set; the target rejects
missing, extra, duplicate, or reordered blobs and runs restore hooks only after
the final state hash matches. The built-in `env.emit*` services triple as:
progress reporting, a cross-runtime determinism check, and byte-compatibility
reference implementations across the bundled hosts.

Restore is a staging operation on fresh, non-executing target service objects.
It must not publish externally visible effects. Services representing leases,
sockets, or other external ownership need an application-specific fence that
is published only after protocol COMMIT.

## 4. What "production grade" means here

- Every transformed module is re-validated before leaving the transformer.
- Differential testing: transformed-but-never-checkpointed modules must be
  observationally identical to the originals.
- Checkpoint determinism: interrupt/restore at arbitrary polls must reproduce
  the uninterrupted run exactly (results *and* full host-visible event
  sequence) — enforced across processes, runtimes, and chains of migrations.
- End-to-end integrity hashes gate every resume.
- Protocol phases, module metadata, page ranges, round counts, memory quotas,
  ordered control globals, and exact service contracts are checked before a
  target acknowledges a migration.
- Failure paths are first-class: pre-commit abort/rollback and lost
  post-commit confirmation are tested, with at-most-one executor preserved.
