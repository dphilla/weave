# Continuous integration

Weave's CI is organized as a layered conformance system rather than one large
workflow. All CI-specific implementation and pins are centralized in
[`../.github/ci`](../.github/ci/README.md); [`.github/workflows`](../.github/workflows/)
contains only triggers, permissions, job ordering, and artifact upload wiring.

## Tiers

| Tier | Trigger | Purpose | Workflow |
|---|---|---|---|
| Pull request | PRs to `main`, manual dispatch | Language gates, checkpoint-file restore, representative migration routes, and fixed expected native guest semantics | `pr.yml` |
| Main conformance | Every push to `main`, manual dispatch | Language gates, all 16 directed runtime pairs, native/WAMR semantic and SIMD routes, Rust/LLVM guest, and browser migration demos | `conformance.yml` |
| Nightly adversity | Daily, manual dispatch | Protocol failure-path tests, repeated workload-progress thresholds, WAMR multi-memory, both real-browser routes, and host-service baseline | `nightly.yml` |
| Corpus | Weekly, manual dispatch | Transform and validate valid modules extracted from the official core Wasm testsuite | `weekly-corpus.yml` |
| Qualification | `v*` tags, manual dispatch | Deterministic non-publishing runtime qualification with long artifact retention | `qualification.yml` |

The qualification workflow never publishes a release and has only
`contents: read` permission. A tag indicates a candidate to test, not proof
that it passed; release publication should wait for this workflow's result.
It composes Rust formatting/Clippy, units, workflow validation, checkpoint
restore, the Rust guest, all runtime directions, fixed guest semantics and SIMD state migration,
WAMR/Chrome, browser/WebRTC, host-service baseline, and adversity.
It intentionally excludes the floating upstream corpus and the advisory Go
race lane; inspect their separate recent runs. Rust quality is required on
PRs, main, and qualification, including WAMR Clippy in configured WAMR lanes.

## Why it is split

The PR tier answers, “did this change obviously break Weave?” It keeps one
incoming and outgoing compatibility path through every independently written
native protocol implementation without putting the entire Cartesian product
on the merge path.

The main tier answers, “does the advertised portability topology still
hold?” It checks every directed pair because migration direction matters.
The scheduled tiers answer slower questions about protocol failure paths,
interpreter/browser integration, upstream Wasm evolution, and host-service
state.

The representative PR route set also includes the exact
Wasmtime→Node→wazero chain documented in `demos/server-chain`. The real
browser-peer and browser/native-sidecar smokes start on main/nightly rather
than the PR merge path; their signaling/controller tests and the underlying
DataChannel/session/sidecar tests remain in the language unit lanes.

[`semantic-conformance.sh`](../.github/ci/semantic-conformance.sh) adds fixed
expected traces for initialization, memory size/growth/bounds, tail calls, and
entry results. It checks standalone execution and real migration independently
of the ordinary woven Wasmtime golden run, so a shared transformer bug cannot
pass merely by producing the same wrong behavior everywhere. PRs run the
native lane; main adds WAMR and live SIMD/multiple-memory state. Qualification
runs both. See the [semantic lane documentation](../.github/ci/README.md#fixed-guest-semantics)
for commands, fixtures, and replay settings.

The weekly corpus accepts only explicit unsupported-feature rejections.
Unexpected transformer errors, crashes, and invalid output are hard failures,
without per-module or diagnostic-pattern baseline exceptions. The same policy
is checked locally by `.github/ci/spec-corpus.test.sh` and in workflow validation.

This mirrors established systems practice: compiler projects use fast common
builders plus specialist buildbots, browser projects share one conformance
harness across engines, and VM migration implementations test state-machine
failure cuts independently from ordinary unit tests.

## Host functionality and the “plugin” idea

Weave does not attempt to serialize arbitrary host-process state. Stateful host
functionality crosses a migration through the `HostService` contract: a stable
service name plus `snapshot()` and staging-only `restore()` operations. Both
peers must advertise the same service set, and the service blobs participate in
the final state hash. A socket, lease, DOM object, GPU handle, or similar
external resource still needs an application-defined ownership fence that is
activated only after protocol `COMMIT`.

That fence is a requirement, not a feature already exposed by `HostService`.
Today there is no version negotiation, activate/abort callback, or generic
fencing API; service versioning can only be encoded by naming convention.

The nightly `host-service-baseline.sh` lane is the first CI home for that idea.
It groups the existing Rust, JavaScript, and Go checks for canonical service
identity, set mismatch, hash-before-restore ordering, rollback before
`PREPARED`, and no rollback after an uncertain commit. Here “plugin” means a
portable host-service implementation; it is not yet a dynamic library ABI,
package format, discovery mechanism, or proof that arbitrary host APIs migrate.

The next increment should add versioned, language-neutral host-service vectors
and a deliberately stateful reference service. Those fixtures and their matrix
belong under `.github/ci`, invoked through `host-service-baseline.sh`;
runtime-specific workflow fragments should not be added beside product source.

The baseline also runs the public Rust lifecycle regressions and transforms
`js/test-support/lifecycle.wat` with the current compiler before repeating the
JavaScript lifecycle/ownership tests. This complements the recorded genuine
Wasm fixture used by the Rust-free JavaScript lane. See [`LIBRARY.md`](LIBRARY.md)
for the guarded API, cancellation, and restore contract.

## Artifacts and replay

Conformance and browser jobs upload their complete artifact directories even
on failure. Retention is 7 days for PRs, 30 days for main/nightly/corpus, and
90 days for release qualification. A conformance artifact includes:

- Git commit and exact tool/runtime versions.
- Selected pair/route, fixture, argument, and event threshold.
- Woven module and uninterrupted golden stream.
- Per-hop stdout/stderr and every control-client response.
- Concatenated host-visible stream and diff on divergence.

The browser-peer artifact adds both tab logs/screenshots, selected ICE-path
diagnostics, and an exact boundary-continuity result. The browser-sidecar
artifact adds the browser log/screenshot, sidecar control transcript and
stderr, native runtime/control logs, selected path, and exact continuity at
both Browser→Wasmtime and Wasmtime→Browser boundaries. CI supplies only a
local STUN binding responder for deterministic loopback candidates. A
separate forced-TURN matrix is still needed before claiming continuous
qualification through restrictive enterprise/mobile networks.

The JavaScript unit lane also packs every workspace under `packages/`, checks
that its license and public-only file boundary are present, installs all
tarballs into a clean temporary consumer, and imports their public exports.
The implementation is centralized in `.github/ci/package-smoke.sh`; packages
do not carry separate lockfiles or CI scripts.

The manifest values map directly back to local environment variables and
`conformance.sh --edge/--route`, making a failing job reproducible without
copying workflow YAML.

## Local power and suspend behavior

Long local qualification and conformance runs automatically hold a macOS
`caffeinate -i -s` assertion. This leaves display sleep alone while preventing
idle sleep and AC-powered system sleep. Set `WEAVE_CI_PREVENT_SLEEP=0` to
disable it. Hosted Linux runners take no platform-specific action.

Forced sleep, including closing a laptop lid, can override that assertion.
The conformance harness therefore uses active, monotonic deadlines for process
completion, readiness, and event thresholds. Suspend time no longer turns a
healthy runtime into a timeout immediately after wake. The investigation that
motivated this behavior, its evidence, and the recurrence plan are in
[`WAMR_TIMEOUT_INVESTIGATION.md`](WAMR_TIMEOUT_INVESTIGATION.md).

## Local cleanup and failure retention

Central runners use one artifact lifecycle: a default temporary directory is
deleted after success, retained after failure, and retained on any result when
`WEAVE_CI_KEEP_TEMP=1` is set. A caller-provided `WEAVE_CI_ARTIFACT_DIR` is
never removed. Process-owning harnesses separately shut down their exact child
PIDs or process groups on normal exit, error, `SIGINT`, and `SIGTERM`.

For manual recovery, preview the centralized allowlisted cleanup first:

```sh
scripts/cleanup.sh --dry-run
scripts/cleanup.sh --dry-run --all
```

The default removes known demo output only. `--temp` adds owned direct
children of `TMPDIR` matching exact Weave harness prefixes; `--builds` adds
only the root and WAMR build trees. The command never runs a Git cleanup or
restores tracked files, so implementation edits cannot be mistaken for test
residue. See the
[CI subsystem cleanup documentation](../.github/ci/README.md#local-cleanup) for
the complete behavior and commands.

## Initial rollout

1. Manually dispatch `Pull request` and confirm all required jobs and uploaded
   artifacts on GitHub-hosted infrastructure.
2. Make the Rust tests, Rust formatting and Clippy, JavaScript, Go, and
   representative conformance jobs branch protection requirements.
3. Let `Main conformance`, including all real-browser routes, pass at least
   once before treating README runtime claims as CI-qualified.
4. Observe several scheduled runs, then decide whether advisory Go race can
   become required and whether timeouts/iteration counts need tuning.

Branch protection/rulesets are repository settings, not YAML. Until those
named checks are configured as required, GitHub will run them but will not
block a merge. Main also reruns the language gates so direct pushes cannot rely
solely on the PR event.

See the [CI subsystem README](../.github/ci/README.md) for exact commands,
prerequisites, matrices, pin policy, and extension points.
