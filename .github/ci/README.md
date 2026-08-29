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
| `run-unit.sh` | Root Rust, JavaScript, Go, and advisory Rust-quality lanes |
| `with-timeout.sh` | Portable process-group timeout and forced cleanup |
| `conformance.sh` | Real-process, real-TCP golden-trace pair and route driver |
| `checkpoint-file.sh` | Checkpoint-file → fresh-process restore golden check |
| `rust-guest.sh` | Out-of-tree Rust/LLVM guest build and Wasmtime→Node migration |
| `native-e2e.sh` | Safe composition used by the legacy `scripts/e2e.sh` shim |
| `prepare-wamr.sh` | Safe temporary checkout plus immutable WAMR tag verification |
| `prepare-wasm-tools.sh` | Platform-select and checksum the pinned official corpus tool |
| `run-wamr.sh` | Independent WAMR workspace build and tests |
| `browser-smoke.sh` | Required Chrome → WAMR → Chrome → WAMR smoke |
| `browser-peer-smoke.sh` | Required Chrome A → B → A WebRTC smoke with local signaling/STUN |
| `wamr-fixture.sh` | Multiple-memory Wasmtime → WAMR → Wasmtime chain |
| `adversity.sh` | Protocol failure tests and repeated migration thresholds |
| `host-service-baseline.sh` | Current built-in host-service behavior tests |
| `spec-corpus.sh` | Weekly official WebAssembly testsuite transformer smoke |
| `spec-corpus-known-failures.txt` | Narrow pattern-matched upstream corpus baseline debt |
| `qualification.sh` | Deterministic, non-publishing runtime qualification composition |
| `check-workflows.sh` | Shell syntax, cleanup safety tests, and pinned actionlint validation |

Each script supports `--help` where it has options. Scripts use argv arrays,
finite waits, exact child PIDs, and caller-selected artifact directories. They
do not use broad `pkill` cleanup.

## Local commands

From the repository root:

```sh
.github/ci/run-unit.sh rust
.github/ci/run-unit.sh js
.github/ci/run-unit.sh go

# See the selected topology without building anything.
.github/ci/conformance.sh --suite pr --list

# Run one pair or a multi-hop chain.
WEAVE_CI_ARTIFACT_DIR=/tmp/weave-edge \
  .github/ci/conformance.sh --edge wasmtime:wasmtime
WEAVE_CI_ARTIFACT_DIR=/tmp/weave-route \
  .github/ci/conformance.sh --route wasmtime:node:wazero

# Unique non-WAMR product scenarios retained from the original E2E harness.
.github/ci/checkpoint-file.sh
.github/ci/rust-guest.sh
```

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
child PIDs, the timeout helper owns a process group, and the browser harnesses
close their Chrome/service children in `finally` and signal handlers. Cleanup
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
```

Missing browser prerequisites are failures in this wrapper. The underlying
interactive demo retains its developer-friendly optional skip behavior.
Set `CHROME_BIN` when Chrome/Chromium is outside the usual system locations;
the resolved executable and version are recorded in `versions.txt`. Central
scripts that invoke Node honor `NODE_BIN=/absolute/path/to/node`, which is
useful when a version manager does not put Node on the non-interactive PATH.

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

## What is required today

The PR-required lanes are:

- Root Rust tests and release build.
- JavaScript core, transport, relay, and browser-smoke unit tests.
- Go format, vet, tests, and a non-source-tree build.
- The six-case representative migration suite, including the advertised
  three-runtime server demo route.
- Checkpoint-file restore in a fresh process.
- Shell/workflow static validation.

`cargo fmt --check` and strict Clippy are present as a visibly advisory PR job
because the pre-CI repository baseline currently fails both. Once that debt is
fixed, remove `continue-on-error` in `pr.yml`; no script or workflow redesign
is needed. Go race instrumentation is likewise an advisory nightly job until
it passes on every supported Go/platform combination.

CI currently qualifies the exact current Node and Go pins in `versions.env`.
The relay's documented Node 18 floor and the Go module's 1.22 language floor
are not yet protected by minimum-version jobs; add a scheduled compatibility
matrix before treating those floors as continuously qualified.

Real browser-to-browser WebRTC is required on main, nightly, and release
qualification. The smoke starts an in-process signaling service and a minimal
loopback STUN binding responder, launches two actual Chrome pages, migrates in
both directions, and checks the exact next `EMIT` index at each boundary. Its
artifact contains both page logs and screenshots plus Chrome/tool versions.
This validates a real same-host DataChannel and exercises local STUN candidate
gathering; it does not assert that a server-reflexive candidate was selected.
Separate browsers/network namespaces and forced TURN/UDP and TURN/TCP/TLS
remain a future scheduled deployment matrix.

## Host-service baseline, not a plugin ABI

`host-service-baseline.sh` groups today's Rust, JavaScript, and Go assertions
for service identity, staging, hash ordering, and commit uncertainty. The
directed WAMR routes separately exercise its built-in emit-service blobs. This
is useful regression coverage, but there are not yet language-neutral golden
vectors, dynamic plugin discovery, version negotiation, activation/abort
lifecycle hooks, or a general fencing API. A real plugin conformance suite
should add those vectors beneath this directory and extend this one entry
point.

## Corpus replay and baseline maintenance

Run a small local sample with:

```sh
corpus_dir="$(mktemp -d)"
WEAVE_CI_ARTIFACT_DIR="$corpus_dir" \
WEAVE_CORPUS_MAX_WAST_FILES=5 \
WEAVE_CORPUS_MIN_SUCCESSES=1 \
  .github/ci/spec-corpus.sh
```

A full run omits `WEAVE_CORPUS_MAX_WAST_FILES`. Only explicit unsupported
diagnostic families and exact entries in `spec-corpus-known-failures.txt` are
accepted. New errors and stale baseline entries fail; inspect `report.tsv`,
then fix the transformer or make the narrowest reviewed baseline change.

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
  diagnostics in `spec-corpus.sh`. Post-transform table64/exception failures
  and one new-GC validation boundary are matched by exact WAST stem, module,
  and error in `spec-corpus-known-failures.txt`. Every other transform error is
  a hard failure, and a full run also fails if a baseline entry becomes stale.
- Go/Wasm/generated binaries are written to temporary artifact directories,
  never over the tracked source-tree binary.

WAMR 2.4.4 is retained because that is the adapter's currently qualified ABI.
It should be upgraded and requalified separately; CI executing trusted local
fixtures is not a substitute for staying current on runtime security fixes.
