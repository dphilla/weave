#!/usr/bin/env bash
# Non-publishing release qualification. This composes the same central lanes
# used on PR/main/nightly; it does not create a GitHub release or modify tags.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

[[ -n "${WAMR_ROOT:-}" ]] || { printf '%s\n' 'WAMR_ROOT is required' >&2; exit 1; }
ARTIFACT_ROOT="${WEAVE_CI_ARTIFACT_DIR:-${TMPDIR:-/tmp}/weave-qualification}"
mkdir -p "$ARTIFACT_ROOT"

.github/ci/run-unit.sh rust
.github/ci/run-unit.sh js
.github/ci/run-unit.sh go
.github/ci/run-wamr.sh
.github/ci/check-workflows.sh

WEAVE_CI_ARTIFACT_DIR="$ARTIFACT_ROOT/checkpoint" \
  .github/ci/checkpoint-file.sh
WEAVE_CI_ARTIFACT_DIR="$ARTIFACT_ROOT/rust-guest" \
  .github/ci/rust-guest.sh
WEAVE_CI_ARTIFACT_DIR="$ARTIFACT_ROOT/conformance" \
  .github/ci/conformance.sh --suite all
WEAVE_CI_ARTIFACT_DIR="$ARTIFACT_ROOT/multi-memory" \
  .github/ci/wamr-fixture.sh --skip-build
WEAVE_CI_ARTIFACT_DIR="$ARTIFACT_ROOT/browser" \
  .github/ci/browser-smoke.sh
WEAVE_CI_ARTIFACT_DIR="$ARTIFACT_ROOT/browser-peer" \
  .github/ci/browser-peer-smoke.sh
WEAVE_CI_ARTIFACT_DIR="$ARTIFACT_ROOT/adversity" \
  .github/ci/adversity.sh all
.github/ci/host-service-baseline.sh 2>&1 | tee "$ARTIFACT_ROOT/host-service-baseline.log"
