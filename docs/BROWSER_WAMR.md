# Browser ↔ WAMR migration contract

Weave can move a running, transformed **core WebAssembly** workload between a
browser and a WAMR server when the workload stays inside the portable contract
below. “Arbitrary workload” does not mean an arbitrary browser tab, native
process, WASI program, or opaque host object: only state represented by the
woven module and explicitly serializable host services can move.

## Portable workload contract

A workload is eligible when all of these are true:

- `weave transform` accepts the module. Shared memories/threads, `externref`,
  exceptions, GC types, and memory64 are currently rejected.
- Every Wasm feature used by the transformed module is enabled in both Chrome
  and the WAMR build. The bundled WAMR adapter uses the classic interpreter
  with bulk memory, SIMD, reference types, and multiple memories enabled.
- The workload is single-threaded, with one exported entry call in flight.
- Every non-`weave.poll` import has an implementation on both peers. Any
  stateful implementation must be a `HostService`, with the same service name
  and a byte-compatible snapshot format on both sides. Weave now rejects
  missing, extra, duplicate, or reordered service state before acknowledging
  a migration.
- External effects have application-defined migration semantics. Memory,
  globals, tables, the live call stack, and service blobs move; DOM nodes,
  JavaScript closures, open sockets, file descriptors, GPU resources, and
  database transactions do not move automatically.

The browser JavaScript API cannot directly call a Wasm export whose public
signature contains `v128`. Such a workload can still migrate *into* the
browser and resume through the scalar `__weave_resume` ABI, but starting it in
Chrome requires a guest-side scalar wrapper. Public `funcref` signatures are
already rejected by the transformer.

WASI is not a portable browser host contract. A WASI application needs either
an explicitly migratable WASI service layer on both peers or a refactoring to
application-specific imports. The included runners intentionally provide only
the byte-compatible `env.emit*` demo services.

The generic Rust and JavaScript libraries can be embedded with application
services. The bundled `weave-wamr` CLI is narrower: it currently registers
only `env.emit`, `env.emit32`, and `env.emit64`, and rejects other function
imports clearly. Supporting an application-specific WAMR import requires
adding its native callback and byte-compatible service state to that adapter;
there is no safe way to infer arbitrary host behavior.

## Why a relay is required

Chrome exposes WebSocket, not raw TCP listening or dialing. The Weave frame
bytes are transport-independent, so the demo relay only translates byte
streams:

```text
Chrome source  --WebSocket--> relay --TCP--> WAMR target
Chrome target  <--WebSocket-- relay <--TCP-- WAMR source
```

For the reverse direction, Chrome first reserves the relay's accept route;
WAMR then migrates to the relay's dedicated TCP ingress address. See
`demos/browser-wamr` for the runnable flow.

The relay is not part of the snapshot protocol and never interprets migration
frames. It uses configured target aliases rather than accepting arbitrary
browser-supplied TCP destinations.

## Operational caveats

- Browser execution is cooperative. At poll sites the guest unwinds, yields to
  the event loop for WebSocket work, and resumes. A backgrounded or suspended
  tab can therefore delay progress or migration.
- A workload can only pause at injected poll sites. There is a poll on every
  unbounded path, but a long finite straight-line region is not preemptible.
- The receiving WAMR server must include the bytecode interpreter. An AOT-only
  deployment cannot execute a newly transferred portable `.wasm` module
  without an out-of-band compilation/cache policy.
- Bundled targets reject a received module over their configured cap, inspect
  declared initial memory before instantiation, and default to at most 1 GiB
  of aggregate linear memory at handoff. This bounds peer-driven restore
  allocation; deployments can choose a stricter policy. It is not a lifetime
  limiter on later guest `memory.grow` instructions.
- Production deployments should put the relay and node protocol behind
  authentication and TLS (`wss://` in the browser), enforce module/memory
  quotas, and authorize module hashes. The demo defaults to loopback and is
  not an Internet-facing control plane.

Within those boundaries, the migration is bit-exact and bidirectional. The
target checks the module metadata, phase ordering, memory layout, control
globals, service contract, and final state hash before sending `PREPARED`.
Before that point a source failure rewinds locally. After it, the source sends
an irreversible `COMMIT` and retires; the target executes only after receiving
COMMIT. A lost `COMMIT_OK` is reported as uncertain and never causes both
copies to run, though an ambiguous commit can leave neither copy running.

The checked demo path has completed a real
`Chrome → WAMR → Chrome → WAMR` round trip. The smoke asserts that the first
new `env.emit` counter index is exactly next at every ownership boundary; the
protocol independently verifies the complete transferred state hash before
commit. Focused WAMR interop also covers two memories and a source-cleared
active data segment, exercising the target's required zero baseline.
