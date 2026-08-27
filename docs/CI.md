# Continuous integration

Weave's CI is organized as a layered conformance system rather than one large
workflow. All CI-specific implementation and pins are centralized in
[`../.github/ci`](../.github/ci/README.md); [`.github/workflows`](../.github/workflows/)
contains only triggers, permissions, job ordering, and artifact upload wiring.

## Tiers

| Tier | Trigger | Purpose | Workflow |
|---|---|---|---|
| Pull request | PRs to `main`, manual dispatch | Language gates, checkpoint-file restore, and a representative directed migration cycle plus chain | `pr.yml` |
| Main conformance | Every push to `main`, manual dispatch | Language gates, all 16 directed Wasmtime/Node/wazero/WAMR pairs, Rust/LLVM guest, and required real Chrome | `conformance.yml` |
| Nightly adversity | Daily, manual dispatch | Protocol failure-path tests, repeated workload-progress thresholds, WAMR multi-memory, browser, and host-service baseline | `nightly.yml` |
| Corpus | Weekly, manual dispatch | Transform and validate valid modules extracted from the official core Wasm testsuite | `weekly-corpus.yml` |
| Qualification | `v*` tags, manual dispatch | Deterministic non-publishing runtime qualification with long artifact retention | `qualification.yml` |

The qualification workflow never publishes a release and has only
`contents: read` permission. A tag indicates a candidate to test, not proof
that it passed; release publication should wait for this workflow's result.
It composes units, workflow validation, checkpoint restore, the Rust guest,
all runtime directions, WAMR/Chrome, host-service baseline, and adversity.
It intentionally excludes the floating upstream corpus and the two known-red
advisory lanes (Rust quality and Go race); inspect their separate recent runs.

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

## Artifacts and replay

Conformance and browser jobs upload their complete artifact directories even
on failure. Retention is 7 days for PRs, 30 days for main/nightly/corpus, and
90 days for release qualification. A conformance artifact includes:

- Git commit and exact tool/runtime versions.
- Selected pair/route, fixture, argument, and event threshold.
- Woven module and uninterrupted golden stream.
- Per-hop stdout/stderr and every control-client response.
- Concatenated host-visible stream and diff on divergence.

The manifest values map directly back to local environment variables and
`conformance.sh --edge/--route`, making a failing job reproducible without
copying workflow YAML.

## Initial rollout

1. Manually dispatch `Pull request` and confirm all required jobs and uploaded
   artifacts on GitHub-hosted infrastructure.
2. Make the Rust, JavaScript, Go, and representative conformance jobs branch
   protection requirements. Leave the named Rust-quality job advisory until
   its inherited baseline is repaired.
3. Let `Main conformance` pass at least once before treating README runtime
   claims as CI-qualified.
4. Observe several scheduled runs, then decide whether advisory Go race can
   become required and whether timeouts/iteration counts need tuning.
5. Repair formatting/Clippy findings and promote that existing job to a PR
   requirement.

Branch protection/rulesets are repository settings, not YAML. Until those
named checks are configured as required, GitHub will run them but will not
block a merge. Main also reruns the language gates so direct pushes cannot rely
solely on the PR event.

See the [CI subsystem README](../.github/ci/README.md) for exact commands,
prerequisites, matrices, pin policy, and extension points.
