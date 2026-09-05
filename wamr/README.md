# weave-wamr

`weave-wamr` is a symmetric Weave node backed by the WebAssembly Micro
Runtime (WAMR). It can start a pre-woven workload, receive one over the Weave
v2 wire protocol, migrate the running workload onward, and answer the same
`migrate`/`status` control commands as the Wasmtime, Node, and wazero runners.

The adapter is deliberately thin: Rust's existing `weave-core` owns metadata,
framing, hashes, and values, while `weave-host` owns dirty-page pre-copy and
the target state machine. Only ordinary public APIs from WAMR's
`wasm_export.h` are used for execution, memories, globals, and host imports.

## Build

The tested runtime is **WAMR `WAMR-2.4.4`**. CMake 3.14 or newer, a C
toolchain, and Cargo are required.

```sh
git clone --depth 1 --branch WAMR-2.4.4 \
  https://github.com/bytecodealliance/wasm-micro-runtime.git /tmp/wamr

WAMR_ROOT=/tmp/wamr cargo build --release --manifest-path wamr/Cargo.toml
```

`WAMR_ROOT` remains external: no WAMR sources or generated bindings are
vendored. The build compiles a static fast interpreter with bulk memory, SIMD,
reference types, and multiple memories enabled. SIMD uses SIMDe v0.8.2,
downloaded by CMake at immutable commit
`71fd833d9666141edcd1d3c109a80e228303d8d7`; the first build needs GitHub access.
`compat.rs` generates checked adaptations of three WAMR source files in the
Cargo build directory. These retain memory indices in fast bytecode for scalar
and SIMD accesses, memory size/growth, and bulk operations, filling WAMR
2.4.4's fast-interpreter multi-memory gaps. Explicit bounds checks remain
enabled for every memory. The external pinned checkout is never modified.
On Darwin, WAMR's native stack guard-page optimization
is disabled because its `alloca`-based stack walk conflicts with Rust's own
guard; WAMR's interpreter operand/call-stack bounds checks remain enabled.
Because the adapter contains a small handwritten C ABI, the build rejects a
different or unverifiable WAMR tag. Set `WEAVE_WAMR_ALLOW_UNTESTED=1` only
when deliberately accepting that ABI risk.

Instantiation executes no guest functions. In particular, WAMR's automatic
`__post_instantiate` and `__wasm_call_ctors` calls are disabled in the generated
runtime source so incoming workloads cannot run before COMMIT. These exports
remain available when deliberately invoked, including by a guest entry that
owns its initialization.

## Use

First transform a module with the root CLI; WAMR consumes the resulting
portable Wasm directly:

```sh
cargo run -p weave-cli -- transform guests/counter.wat \
  -o /tmp/counter.woven.wasm --period 64

WAMR_ROOT=/tmp/wamr cargo run --manifest-path wamr/Cargo.toml -- \
  run /tmp/counter.woven.wasm --invoke run --arg 1000000
```

Start an idle target and a source node in separate terminals:

```sh
WAMR_ROOT=/tmp/wamr cargo run --manifest-path wamr/Cargo.toml -- \
  serve --listen 127.0.0.1:9102

WAMR_ROOT=/tmp/wamr cargo run --manifest-path wamr/Cargo.toml -- \
  serve --listen 127.0.0.1:9101 --module /tmp/counter.woven.wasm \
  --invoke run --arg 200000000
```

Incoming migrations default to a 1 GiB aggregate linear-memory limit at
handoff. Use `--max-memory-bytes BYTES` on `serve` to choose an explicit
deployment quota. This bounds restore allocation, not later guest-initiated
`memory.grow` after resume.

Then request migration using any Weave control client:

```sh
WAMR_ROOT=/tmp/wamr cargo run --manifest-path wamr/Cargo.toml -- \
  migrate --node 127.0.0.1:9101 --to 127.0.0.1:9102

WAMR_ROOT=/tmp/wamr cargo run --manifest-path wamr/Cargo.toml -- \
  status --node 127.0.0.1:9102
```

A WAMR node can be either endpoint in a chain. A browser endpoint carries the
same frame bytes over its WebSocket transport; a WebSocket-to-TCP bridge is
still needed when the browser and this raw-TCP node communicate directly.

## Current workload boundary

This supports arbitrary workloads that the current transformer accepts **and**
whose external imports are limited to the portable built-ins:

- `env.emit(i32, i64)`
- `env.emit32(i32)`
- `env.emit64(i64)`

Their 16-byte accumulator snapshots are byte-compatible with the other
runners. Adding arbitrary WASI/application imports requires a service plugin
whose behavior and snapshot format exist at both endpoints; silently moving
unmodeled host state would be incorrect.

The project-wide ABI exclusions still apply: shared memories/threads,
exceptions, GC types, and memory64. CLI arguments support i32, i64, f32, and
f64. Migrated SIMD state and multi-memory contents are handled by the guest
ABI and WAMR memory APIs even though a v128 value cannot currently be entered
as a command-line argument.

`tests/fixtures/multi-memory.wat` is a focused interop fixture. It includes a
source-cleared active data-segment byte, so a successful migration verifies
both indexed memory handling and the all-zero target baseline required by
pre-copy page elision.

`tests/fixtures/simd-multi-memory.wat` combines live SIMD locals, SIMD loads and
stores in memory 1, independent scalar memories, indexed growth and size, and
cross-memory copy/fill/init. Adapter tests checkpoint it mid-loop, restore into
a new instance, and check its result. Separate cases verify indexed SIMD and
bulk accesses still trap at the memory boundary, and that constructor exports
remain dormant during fresh and incoming instantiation.
