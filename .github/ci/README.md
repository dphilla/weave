# Weave CI subsystem

This directory is the single home for CI-only commands, external dependency
pins, setup logic, conformance matrices, and artifact conventions. Product
tests remain beside the Rust, JavaScript, Go, and WAMR code they exercise;
CI does not add package-manager files, Makefile targets, or setup fragments to
those source trees.

The YAML files in [`../workflows`](../workflows/) are deliberately thin. They
install requested toolchains, invoke the commands here, and upload artifacts.
The same commands are directly runnable from the repository root.
Hosted jobs set `CARGO_TARGET_DIR` beneath `RUNNER_TEMP`, so CI compilation
does not populate checkout-local `target/` trees. Local commands retain normal
Cargo behavior unless the caller sets that variable too.

## Inventory

| Path | Purpose |
|---|---|
| `versions.env` | Rust, Node, Go, wasm-tools, actionlint, WAMR source pins |
| `setup/action.yml` | Shared GitHub Actions toolchain setup and download cache |
| `artifact-lifecycle.sh` | Shared success/failure retention policy for default temporary artifacts |
| `artifact-lifecycle.test.sh` | Isolated lifecycle cleanup and retention checks |
| `cleanup.sh` | Allowlisted manual cleanup; never resets source or arbitrary ignored files |
| `cleanup.test.sh` | Isolated containment, symlink, dry-run, and scope checks |
| `awake-guard.sh` | Shared macOS power assertion for long local entry points |
| `awake-guard.test.sh` | Isolated platform, bypass, argv, and exit-status checks |
| `run-unit.sh` | Required Rust-quality, root Rust, JavaScript, and Go lanes |
| `package-smoke.sh` | Pack, clean-install, and import every reusable JavaScript workspace |
| `typecheck.sh` | Pack and clean-install authenticated rendezvous, strictly compile browser/Node/custom-provider consumers, and execute the Node consumer |
| `typecheck/package.json`, `typecheck/package-lock.json` | Exact CI-only TypeScript and Node declaration dependencies; no product dependencies |
| `with-timeout.sh` | Portable process-group timeout and forced cleanup |
| `wait-for.sh` | Suspend-safe process, output, and event condition waits |
| `wait-for.test.sh` | Isolated condition success and active-time timeout checks |
| `conformance.sh` | Real-process, real-TCP golden-trace pair and route driver |
| `control-interface.sh` | Structured CLI/adversarial-peer checks and persistent four-runtime operation-recovery cycle |
| `semantic-conformance.sh` | Fixed expected guest traces for initialization, memory, tail calls, and SIMD before/after migration |
| `checkpoint-file.sh` | Checkpoint-file → fresh-process restore golden check |
| `rust-guest.sh` | Out-of-tree Rust/LLVM guest build and Wasmtime→Node migration |
| `native-e2e.sh` | Safe composition used by the legacy `scripts/e2e.sh` shim |
| `prepare-wamr.sh` | Safe temporary checkout plus immutable WAMR tag verification |
| `prepare-wasm-tools.sh` | Platform-select and checksum the pinned official corpus tool |
| `run-wamr.sh` | Independent WAMR workspace strict Clippy, tests, and release build |
| `browser-smoke.sh` | Required Chrome → WAMR → Chrome → WAMR smoke |
| `browser-peer-smoke.sh` | Required Chrome A → B → A WebRTC smoke with local signaling/STUN |
| `browser-sidecar-smoke.sh` | Required Chrome → generic Pion sidecar → Wasmtime → Chrome smoke |
| `pi-demo-smoke.sh` | Fresh Cargo compiler → single-file Pi HTML → real Chrome local and WebRTC migrations |
| `pi-demo-smoke.test.sh` | Isolated compiler provenance, packaging, browser invocation, failure, and retention checks (JavaScript lane) |
| `wamr-fixture.sh` | Multiple-memory Wasmtime → WAMR → Wasmtime chain |
| `adversity.sh` | Protocol failure tests and repeated migration thresholds |
| `host-service-baseline.sh` | Current built-in host-service behavior tests |
| `spec-corpus.sh` | Weekly official WebAssembly testsuite transformer smoke |
| `spec-corpus.test.sh` | Corpus classification regression checks with deterministic fake tools |
| `qualification.sh` | Deterministic, non-publishing runtime qualification composition |
| `check-workflows.sh` | Per-file shell syntax, action SHA pins, CI harness tests, and pinned actionlint validation |
| `check-workflows.test.sh` | Isolated valid/broken repositories proving syntax and action-pin checks reject regressions |

Each script supports `--help` where it has options. Scripts use argv arrays,
finite waits, exact child PIDs, and caller-selected artifact directories. They
do not use broad `pkill` cleanup.

## Local commands

From the repository root:

```sh
.github/ci/run-unit.sh rust-quality
.github/ci/run-unit.sh rust
.github/ci/run-unit.sh js
.github/ci/run-unit.sh go

# Validate CI definitions and run the validator's offline regression fixtures.
bash .github/ci/check-workflows.sh
# Run just the fixtures, without downloading actionlint or building runtimes.
bash .github/ci/check-workflows.test.sh

# Human/agent CLI control against all four native adapters and faulty peers.
WEAVE_CI_ARTIFACT_DIR=/tmp/weave-control-check \
  bash .github/ci/control-interface.sh

# Exercise only the publishable package boundary from a clean consumer.
.github/ci/package-smoke.sh

# Check the installed TypeScript API and execute its native Node Web Crypto consumer.
.github/ci/typecheck.sh

# See the selected topology without building anything.
.github/ci/conformance.sh --suite pr --list

# Run one pair or a multi-hop chain.
WEAVE_CI_ARTIFACT_DIR=/tmp/weave-edge \
  .github/ci/conformance.sh --edge wasmtime:wasmtime
WEAVE_CI_ARTIFACT_DIR=/tmp/weave-route \
  .github/ci/conformance.sh --route wasmtime:node:wazero

# Compare against fixed expected guest behavior, including a three-hop native route.
.github/ci/semantic-conformance.sh native

# Unique non-WAMR product scenarios retained from the original E2E harness.
.github/ci/checkpoint-file.sh
.github/ci/rust-guest.sh
```

### Installed TypeScript consumers

The JavaScript lane (including `run-unit.sh all`) runs `typecheck.sh`, so the
existing PR, main, and release language gates enforce it without an additional
workflow job. The runner builds a fresh npm archive and installs it in an
out-of-checkout consumer. Three strict TypeScript configurations check DOM-only
browser types, DOM-free Node types, and an ES-only custom crypto provider. Invalid
providers, keys, signing hooks, and policies must still produce type errors;
`skipLibCheck` is disabled. The compiled Node consumer then creates real Ed25519
identities and signs and verifies a capability through an external signing hook.

The compiler and Node ambient types are pinned only in `typecheck/package.json`
and its lockfile, installed with `npm ci --ignore-scripts`. A first run needs
npm registry access; once those exact dependencies are cached,
`npm_config_offline=true .github/ci/typecheck.sh` also works. `NODE_BIN`, `NPM_BIN`,
and npm's standard cache settings are honored. Artifacts follow the shared
retention policy below; caller-selected output must be outside the checkout,
and existing consumer/pack directories are refused instead of reused.

### Local power and suspend behavior

On macOS, `qualification.sh`, `semantic-conformance.sh`, and executing
(non-`--list`) invocations of `conformance.sh` automatically re-exec once under
the built-in
`caffeinate -i -s`. This prevents idle sleep and, while on AC power, system
sleep for the command's lifetime without keeping the display awake. The guard
is centralized in `awake-guard.sh`; qualification's inherited sentinel keeps
its nested conformance commands from creating more assertions. Set
`WEAVE_CI_PREVENT_SLEEP=0` to opt out.

A lid close or explicit sleep may override a power assertion. Conformance
condition waits therefore measure their allowance with Python's monotonic
uptime clock through `wait-for.sh`, not Bash's wall-clock-based `SECONDS`.
Time spent suspended does not consume a runtime's active timeout. If wall time
advances at least two seconds beyond active time, the helper prints a suspend
notice. The artifact manifest records the selected awake-guard mode.

Hosted Linux runners do not invoke a power utility. Their workflow-level
timeout remains the outer bound around the suspend-safe per-process limits.

### Local cleanup

The convenient entry point is the dependency-free source-tree shim; cleanup
policy and implementation remain centralized in this directory:

```sh
# Preview or remove only known generated demo outputs.
scripts/cleanup.sh --dry-run
scripts/cleanup.sh

# Also sweep owned, direct TMPDIR children with exact harness prefixes.
scripts/cleanup.sh --temp

# Also discard the root Cargo and independent WAMR build caches.
scripts/cleanup.sh --builds

# Preview every supported cleanup class.
scripts/cleanup.sh --dry-run --all
```

The command deliberately never invokes `git clean`, `git restore`, or
`git reset`; tracked edits and unrelated untracked/ignored files are outside
its scope. `--temp` does not use a broad `weave-*` deletion: it accepts only
explicit harness prefixes, direct children of the physical temporary root,
owned by the current user, with no symlink components. `--builds` accepts only
this checkout's `target/` and `wamr/target/` trees.

Central runners that create their own temporary artifact directory remove it
automatically after success and retain it after failure. Set
`WEAVE_CI_KEEP_TEMP=1` to retain a successful default directory. A caller-set
`WEAVE_CI_ARTIFACT_DIR` is always retained so workflow upload steps and local
diagnostics remain reliable.

Process shutdown remains event-driven: the conformance harness tracks exact
child PIDs, its condition waits use active elapsed time, the timeout helper
owns a process group, and the browser harnesses close their Chrome/service
children in `finally` and signal handlers. Cleanup
does not use `pkill`, and the manual command does not guess which processes
are safe to terminate. `SIGKILL` and machine loss cannot run an exit handler;
after confirming no run remains active, use `scripts/cleanup.sh --temp` to
remove its allowlisted filesystem residue.

Rust protocol tests and every conformance command bind loopback TCP ports.
They therefore need an environment that permits localhost listeners.

WAMR is an independent workspace and needs CMake, a C compiler, and its
external source tree:

```sh
ci_tmp="$(mktemp -d)"
.github/ci/prepare-wamr.sh "$ci_tmp/wasm-micro-runtime"
export WAMR_ROOT="$ci_tmp/wasm-micro-runtime"
.github/ci/run-wamr.sh
.github/ci/conformance.sh --suite wamr
.github/ci/wamr-fixture.sh --skip-build
.github/ci/semantic-conformance.sh wamr
```

`prepare-wamr.sh` intentionally accepts destinations only beneath
`RUNNER_TEMP`, or beneath `TMPDIR` outside Actions. It refuses dirty or
wrong-origin checkouts and verifies both `wamr/WAMR_VERSION` and the immutable
commit in `versions.env` before checkout.

The browser lane additionally requires Node 22 or newer and Chrome/Chromium:

```sh
WEAVE_CI_ARTIFACT_DIR=/tmp/weave-browser-artifacts \
  .github/ci/browser-smoke.sh
WEAVE_CI_ARTIFACT_DIR=/tmp/weave-browser-peer-artifacts \
  .github/ci/browser-peer-smoke.sh
WEAVE_CI_ARTIFACT_DIR=/tmp/weave-browser-sidecar-artifacts \
  .github/ci/browser-sidecar-smoke.sh
WEAVE_CI_ARTIFACT_DIR=/tmp/weave-pi-artifacts \
  .github/ci/pi-demo-smoke.sh
```

Missing browser prerequisites are failures in this wrapper. The underlying
interactive demo retains its developer-friendly optional skip behavior.
Set `CHROME_BIN` when Chrome/Chromium is outside the usual system locations;
the resolved executable and version are recorded in `versions.txt`. Central
scripts that invoke Node honor `NODE_BIN=/absolute/path/to/node`, which is
useful when a version manager does not put Node on the non-interactive PATH.

### Fresh deployable Pi demo

`pi-demo-smoke.sh` always builds `weave-cli` with the locked Cargo dependencies,
reads the executable path from Cargo's compiler-artifact JSON, and packages
current sources with that exact compiler. It honors Cargo's relocated output,
including configuration-driven paths; inherited `WEAVE_BIN`, `WEAVE_PI_WASM`,
and fixture overrides cannot replace the compiler or guest in this lane.
The generated HTML lives under the artifact directory, outside the checkout;
the wrapper refuses checkout-local artifact directories and leaves the tracked
`demos/pi-migration/dist` untouched. Use a fresh artifact directory: an existing
`dist` directory or symlink is refused, not overwritten or reused. Both browser runs serve this generated HTML,
not a checked-in snapshot. No remote signaling, STUN, or TURN server is needed.

```sh
# Same short local + literal-ICE WebRTC checks as pull requests.
.github/ci/pi-demo-smoke.sh --quick
# Same full local recovery checks and six-minute hidden/offline soak as nightly.
.github/ci/pi-demo-smoke.sh --soak-ms 370000
# Hermetic orchestration regressions: Node required, no Rust/Chrome/downloads.
bash .github/ci/pi-demo-smoke.test.sh
```

PR runs both transports in quick mode. Main and release qualification run the
full local scenario (including recovery) plus quick WebRTC. Nightly adds the
370-second hidden/offline local soak. Missing Node 22+, Chrome, or a successful
compiler/build/browser result fails the lane; it is not an optional skip.
Each workflow uploads the tested `dist/index.html`, manifest, Cargo output,
versions/provenance, browser results, and screenshots, including on failure.
These jobs only test and upload diagnostics; they do not publish a site.
Because release qualification includes this lane, its
`WEAVE_CI_ARTIFACT_DIR` must also be outside the checkout. Qualification's
default temporary directory and the hosted workflow paths already satisfy
this; use a fresh `/tmp/...` directory for a retained local qualification run.

The ordinary Pi guest tests select `WEAVE_BIN`, then
`CARGO_TARGET_DIR/release/weave`, then checkout-local `target/release/weave`
(the last choice is used only when no target directory is specified).
JavaScript-only tests retain a source/hash-checked fixture when no CLI exists.
`run-unit.sh all` and release qualification set `WEAVE_PI_REQUIRE_CLI=1` for the
JavaScript tests: missing compilers and fixture/byte overrides then fail instead
of silently avoiding a fresh transformation.

## Conformance suites

`conformance.sh` generates one woven fixture and uninterrupted Wasmtime golden
event stream, then compares every selected route's complete `EMIT*` and
`WEAVE_DONE` stream byte-for-byte with that golden stream.

| Suite | Cases |
|---|---|
| `pr` | Wasmtime→Wasmtime, Wasmtime→Node, Node→wazero, wazero→Wasmtime, Wasmtime→Node→Wasmtime, and the demo's Wasmtime→Node→wazero route |
| `native` | All 9 directed pairs, self-pairs included, among Wasmtime, Node, and wazero, plus Wasmtime→Node→wazero |
| `wamr` | WAMR→WAMR plus both directions between WAMR and each native adapter: 7 cases |
| `all` | `native` + `wamr`: all 16 directed pairs among the four native runtimes, plus Wasmtime→Node→wazero |

Migration is requested after the source log reaches a deterministic minimum
event count, not after a timing guess. The source continues while the request
travels, so this is a reproducible lower bound rather than an exact instruction
cut. Override `WEAVE_CI_MIGRATE_AFTER_EVENTS` to replay different thresholds.
Multi-hop fixtures can use `WEAVE_CI_MIGRATE_AFTER_EVENTS_BY_HOP=1,0,...`
when each source hop needs a different synchronization threshold.
`--route` supports any three-or-more-hop native route. Logs, controls,
the woven fixture, golden stream, combined streams, diffs, tool versions, and
the exact case manifest live beneath `WEAVE_CI_ARTIFACT_DIR`.

Caller-supplied artifact directories are always retained. With no directory,
a successful local run removes its temporary directory, a failed run retains
it, and `WEAVE_CI_KEEP_TEMP=1` retains either. Most central commands share
this policy through `artifact-lifecycle.sh`; conformance keeps an integrated
artifact/process trap because it also owns exact child PIDs. `--skip-build`
requires the
default release binaries to exist (or `WEAVE_BIN`, `WEAVE_WAZERO_BIN`, and
`WEAVE_WAMR_BIN` to name them explicitly).

### Fixed guest semantics

`semantic-conformance.sh native|wamr|all` compares each runtime with fixed
expected events, independently of the woven Wasmtime golden run. The three
fixtures in [`tests/fixtures/p1`](../../tests/fixtures/p1/) cover synchronous
initialization, explicit `_start` invocation, nonfirst-entry result selection,
pure tail calls, fixed and zero memory maxima, logical size/growth, zero-filled
new pages, guest pointers, relocated table shadows, and dropped passive segments.
Each standalone check uses 1000 iterations and compares the full `EMIT*` and
`WEAVE_DONE` trace with the adjacent `.events` file.

The native lane runs those checks on Wasmtime, Node, and wazero, then migrates
the combined memory fixture through Wasmtime → Node → wazero → Wasmtime. The
WAMR lane checks Wasmtime/WAMR and runs Wasmtime → WAMR → Wasmtime for both the
combined fixture and `wamr/tests/fixtures/simd-multi-memory.wat`. The SIMD case
retains vector values across nested calls, indexed memory operations, and
checkpoints; its independently expected result is the iteration count plus
198. `all` shares builds and the standalone Wasmtime checks between lanes.

Main-fixture routes default to 80 million iterations with two-event migration
thresholds. The SIMD route defaults to 100 million and per-hop thresholds
`1,0`. Override `WEAVE_CI_SEMANTIC_ITERATIONS` (or `WEAVE_CI_ITERATIONS`) and
`WEAVE_CI_SIMD_ITERATIONS` for local investigation; smaller counts may finish
before a control request arrives. Both the uninterrupted golden and every
migrated trace must match the independent expectation. Logs and mismatch
diffs remain under the selected artifact directory.

Explicit runtime binary overrides are used without rebuilding them.
`--skip-build` reuses existing binaries, as the hosted workflows do after their
ordinary conformance steps. The native lane is required in PR/main and the
legacy native E2E composition; WAMR semantic coverage is required on main.
Release qualification runs both lanes.

## What is required today

The PR-required lanes are:

- Root Rust tests and release build.
- Rust formatting and warning-free Clippy.
- JavaScript core, transport, relay, and browser-smoke unit tests.
- Fresh single-file Pi packaging and six-tab Chrome migration over both local
  BroadcastChannel and literal-ICE WebRTC transports.
- Go format, vet, tests, and a non-source-tree build.
- The six-case representative migration suite, including the advertised
  three-runtime server demo route.
- Fixed guest semantic traces across Wasmtime/Node/wazero, including a
  Wasmtime → Node → wazero → Wasmtime migration route.
- Checkpoint-file restore in a fresh process.
- Shell/workflow static validation.

`run-unit.sh rust-quality` requires formatting in both Rust workspaces and
warning-free Clippy in the root workspace. It is a required PR job, runs in
the local/main `all` lane, and is included in release qualification.
`run-wamr.sh` additionally requires warning-free Clippy for the independent
WAMR workspace wherever the verified WAMR source is configured. Go race
instrumentation remains an advisory nightly job until it passes on every
supported Go/platform combination.

CI currently qualifies the exact current Node and Go pins in `versions.env`.
The relay's documented Node 18 floor, the wazero adapter's Go 1.22 language
floor, and the WebRTC sidecar's Go 1.24 language floor are not yet protected by
minimum-version jobs; add a scheduled compatibility matrix before treating
those floors as continuously qualified.

Real browser-to-browser WebRTC and browser-to-native WebRTC through the generic
sidecar are required on main, nightly, and release qualification. The peer
smoke launches two actual Chrome pages; the sidecar smoke launches Chrome plus
the independently built Go/Pion process and an unmodified Wasmtime TCP node.
Both migrate in both directions and check the exact next `EMIT` index at each
boundary. The sidecar smoke additionally proves its `first-data` dial remains
unopened after RTC readiness and opens on the first migration bytes. Artifacts
retain browser and sidecar selected-path views separately, protocol NDJSON,
process logs, screenshots, and tool versions. These validate real same-host
DataChannels and local STUN gathering; they do not assert that a
server-reflexive candidate was selected. Separate browsers/network namespaces
and forced TURN/UDP and TURN/TCP/TLS remain a future scheduled deployment
matrix.

## Host-service baseline, not a plugin ABI

`host-service-baseline.sh` groups today's Rust, JavaScript, and Go assertions
for service identity, staging, hash ordering, and commit uncertainty. The
directed WAMR routes separately exercise its built-in emit-service blobs. This
is useful regression coverage, but there are not yet language-neutral golden
vectors, dynamic plugin discovery, version negotiation, activation/abort
lifecycle hooks, or a general fencing API. A real plugin conformance suite
should add those vectors beneath this directory and extend this one entry
point.

## Corpus replay and failure policy

Run a small local sample with:

```sh
corpus_dir="$(mktemp -d)"
WEAVE_CI_ARTIFACT_DIR="$corpus_dir" \
WEAVE_CORPUS_MAX_WAST_FILES=5 \
WEAVE_CORPUS_MIN_SUCCESSES=1 \
  .github/ci/spec-corpus.sh
```

A full run omits `WEAVE_CORPUS_MAX_WAST_FILES`. Only explicit unsupported
diagnostic families returned with the ordinary error status are accepted.
There are no known-failure exceptions: unexpected errors, crashes, and invalid
transformed output fail the run. Inspect `report.tsv` and fix the transformer
or reject an unsupported input feature before transformation. Crash detection
takes precedence over unsupported diagnostic text.

`spec-corpus.test.sh`, also run by `check-workflows.sh`, tests this policy with
deterministic fake tools. It requires no corpus download or Rust compilation
and checks that the six former baseline exception keys now fail normally.

## External and generated data policy

- No workflow executes mutable branch code from another repository.
- GitHub Actions are immutable-SHA pinned. Dependabot proposes workflow-action
  updates, but GitHub does not scan actions inside nested composite actions;
  the three pins in `setup/action.yml` need a manual monthly audit.
- WAMR uses a product tag plus an immutable commit verification.
- `wasm-tools` is version- and per-platform-checksum-pinned in `versions.env`;
  `actionlint` is version-pinned there as well.
- The official WebAssembly testsuite is test data, not executed code. Weekly
  runs intentionally fetch its current default branch and record the exact
  commit in the artifact report so new spec cases are discovered.
- Expected rejections must use one of the explicit unsupported-feature
  diagnostics in `spec-corpus.sh`. Every other transform error is a hard
  failure; corpus names and filenames never exempt a failure. Unsupported
  table64, exception, and GC features are rejected at the input boundary.
- Go/Wasm/generated binaries are written to temporary artifact directories,
  never over the tracked source-tree binary.

WAMR 2.4.4 is retained because that is the adapter's currently qualified ABI.
It should be upgraded and requalified separately; CI executing trusted local
fixtures is not a substitute for staying current on runtime security fixes.
