# Three-server, three-runtime migration chain

This demo starts three independent server processes and moves one active Wasm
instance through three runtime engines over real TCP:

```text
Wasmtime (Rust process) → V8/WebAssembly (Node.js process) → wazero (Go process)
```

The final combined `EMIT`/`WEAVE_DONE` stream is compared byte-for-byte with
an uninterrupted Wasmtime golden run. Any duplicate, skipped, or changed
host-visible counter event at either ownership boundary fails the demo.

## Automated local proof

Prerequisites are Bash, standard Unix utilities, Python 3, the Rust toolchain,
Node.js 18 or newer, Go 1.22 or newer, and permission to bind loopback TCP
listeners. CI currently qualifies the exact newer toolchain pins in
`.github/ci/versions.env`; the documented Node/Go floors do not yet have
separate minimum-version jobs. Run from the repository root:

```sh
demos/server-chain/run.sh
```

The launcher deliberately delegates all builds, process ownership, ephemeral
port allocation, finite waits, log capture, and golden comparison to the
central `.github/ci/conformance.sh` driver. No CI logic is duplicated under
`demos/`. Each run gets a fresh timestamp/PID leaf so prior output cannot be
mistaken for the current result:

```text
target/demo-artifacts/server-chain/20260829T120000Z-12345/
├── fixture.woven.wasm
├── golden.events
├── manifest.txt
└── cases/1-wasmtime-to-node-to-wazero/
    ├── combined.events
    ├── control-*.stdout
    └── hop-*.{stdout,stderr}
```

Use another route or artifact location without changing the script:

```sh
WEAVE_DEMO_ARTIFACT_ROOT=/tmp/weave-chain \
  demos/server-chain/run.sh --route node:wasmtime:wazero
```

Do not shorten the default 200,000,000-iteration fixture casually. wazero can
finish a small workload before the controller reaches the next hop; the
driver synchronizes on emitted events, but the workload must remain live.

## Three actual hosts

Build Rust and Go on each destination, or cross-compile them for that host's
exact OS and architecture. Copy the woven module to A. The Node host needs the
entire `js/` directory because `weave-node.mjs` imports sibling modules:

```sh
cargo build --locked --release -p weave-cli
(cd go/weave-wazero && go build -mod=readonly -o /tmp/weave-wazero .)
target/release/weave transform guests/counter.wat \
  -o /tmp/counter.woven.wasm --period 64
```

Prepare the first `migrate` command in a fourth terminal, then start the cold
targets. Server C (Go/wazero):

```sh
/tmp/weave-wazero serve --listen 0.0.0.0:7003
```

Server B (Node/V8):

```sh
node js/weave-node.mjs serve --listen 0.0.0.0:7002
```

Server A (Rust/Wasmtime), initially owning the workload:

```sh
target/release/weave serve --listen 0.0.0.0:7001 \
  --module /tmp/counter.woven.wasm --pre-woven \
  --invoke run --arg 2000000000
```

From a controller that can reach each control listener:

```sh
target/release/weave migrate --node server-a:7001 --to server-b:7002
target/release/weave status  --node server-b:7002
target/release/weave migrate --node server-b:7002 --to server-c:7003
target/release/weave status  --node server-c:7003
```

The sample has a finite counter. If A prints `WEAVE_DONE` before the first
migration is submitted, restart A and issue the prepared command sooner. The
servers intentionally remain available after a run; stop each foreground
server with Ctrl-C when finished.

Only server A needs the woven module initially. A cold target requests the
content-addressed module during the migration handshake, validates it, and
then receives memory, globals, stack state, and the `env.emit` service blob.
The `--to` address is dialed by the current source—not by the controller—so
`server-b:7002` must be resolvable/reachable from A and `server-c:7003` from B.

The manual run should show monotonically increasing `EMIT` indices across all
three logs and exactly one final `WEAVE_DONE`. The automated form is the
stronger proof because it compares the entire trace.

## Network and host-state boundaries

The native protocol-v2 listener is unauthenticated raw TCP. Use a private
network or an authenticated encrypted tunnel; do not expose these ports
directly to the Internet. Each demo node owns at most one workload.

This route proves the bundled service-set contract and the mutated state of
`env.emit`, the service actually called by `guests/counter.wat`; it is not a
general plugin ABI. A workload with other imports needs the same named,
compatible service implementation and portable snapshot semantics in all
three hosts. Open files, sockets, and opaque runtime objects do not become
migratable merely because the servers can connect.
