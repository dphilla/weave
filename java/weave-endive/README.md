# weave-endive

`weave-endive` is a symmetric Weave node backed by
[Endive](https://github.com/bytecodealliance/endive), a pure-JVM WebAssembly
runtime. It can start a pre-woven workload, receive one over the Weave v2 wire
protocol, migrate the running workload onward, and answer the same
`migrate`/`status` control commands as the Wasmtime, Node, wazero, and WAMR
runners. Like the Rust CLI, it can also write and resume checkpoint files.

The adapter is an independent Java implementation of `weave.meta`, the `WVSN`
snapshot, the state hash, the v2 frames, dirty-page pre-copy, and control
schema v1, byte-compatible with `weave-core`. Every cross-runtime migration
checks that compatibility. It uses only Endive's public embedding API: exported
memories and i32 globals, export calls, and host functions.

## Build

JDK 11 or newer and Maven build and test the adapter; the formatter
(`mvn spotless:apply` or `spotless:check`) needs JDK 21 or newer. CI uses the
pins in `.github/ci/versions.env`.

```sh
mvn -f java/weave-endive/pom.xml package
```

This runs the tests and writes `target/weave-endive.jar` with its dependencies
in `target/lib`. `java/weave-endive/weave-endive` is the launcher used below and
by the CI harnesses. The dependencies are Endive's `runtime`, `wasm`, and
`compiler` artifacts and Jackson for control JSON (plus JUnit for tests).

Each module is compiled to JVM bytecode with Endive's runtime compiler, never
falling back to its interpreter. A node compiles a received module once and
caches it by content hash. Instantiation runs no guest code: Endive's automatic
`_start` call is disabled, `__weave_init` runs only for a fresh workload, and
migration targets clear their memories before accepting sparse pages. Guest
code runs on one thread with a 256 MiB stack, because every Wasm frame is also
a JVM frame.

## Use

Transform a module with the root CLI, then run or serve it:

```sh
cargo run -p weave-cli -- transform guests/counter.wat \
  -o /tmp/counter.woven.wasm --period 64

java/weave-endive/weave-endive run --module /tmp/counter.woven.wasm \
  --invoke run --arg 1000000
```

Start an idle target and a source node in separate terminals, then request a
migration with any Weave control client:

```sh
java/weave-endive/weave-endive serve --listen 127.0.0.1:9202
java/weave-endive/weave-endive serve --listen 127.0.0.1:9201 \
  --module /tmp/counter.woven.wasm --invoke run --arg 200000000

cargo run -p weave-cli -- migrate --node 127.0.0.1:9201 --to 127.0.0.1:9202
```

`weave-endive migrate` and `status` are the legacy clients, as in the other
runners. The listener also implements the
[structured control contract](../../docs/CONTROL.md): epochs, operation IDs,
256 retained operations, and the same ownership reporting. `--budget`,
`--max-rounds`, and `--dirty-threshold` tune pre-copy as in `weave-wazero`.

Checkpoint files interoperate with `weave checkpoint` and `weave restore` in
both directions:

```sh
java/weave-endive/weave-endive checkpoint --module /tmp/counter.woven.wasm \
  --invoke run --arg 200000000 --after-polls 1000 -o /tmp/counter.snap
cargo run -p weave-cli -- restore /tmp/counter.woven.wasm /tmp/counter.snap \
  --pre-woven
```

## Current workload boundary

Workloads may import only the portable built-ins `env.emit(i32, i64)`,
`env.emit32(i32)`, and `env.emit64(i64)`, whose snapshots match the other
runners. Command-line arguments and results support i32, i64, f32, and f64,
and results print exactly as the Rust CLI prints them.

Endive's compiler does not yet support SIMD (`v128`). An Endive node rejects a
SIMD workload before staging it, so the migration fails before PREPARED and the
source keeps running. It does not advertise `simd`, so `weave inspect --node`
reports the incompatibility in advance. Multiple memories, funcref tables,
passive segments, multi-value, sign extension, and saturating conversions are
supported.

Incoming modules are capped at 256 MiB, and aggregate memory accepted at
handoff at 1 GiB. Starting the JVM and compiling a module take a few hundred
milliseconds, which adds to cold-cache migrations.

## Tests

`mvn verify` runs the unit and in-process migration tests. These include live
migrations between two nodes, rollback before PREPARED, retirement after a lost
COMMIT_OK, busy, SIMD, and service-set rejections, and structured control. The
format tests compare against bytes produced by the Rust CLI; see
[`src/test/resources/golden`](src/test/resources/golden/README.md) to
regenerate them. Format the code with `mvn spotless:apply`.

Cross-runtime coverage lives in the central CI scripts:
`.github/ci/run-unit.sh java`, `.github/ci/conformance.sh --suite endive`,
`.github/ci/semantic-conformance.sh endive`, and
`.github/ci/control-interface.sh`.
