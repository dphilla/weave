#!/usr/bin/env bash
# Safe compatibility entry point for the original native/Node/wazero E2E.
# All orchestration remains in the centralized CI subsystem.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

ARTIFACT_ROOT="${WEAVE_CI_ARTIFACT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/weave-native-e2e.XXXXXX")}"
mkdir -p "$ARTIFACT_ROOT"
printf 'native E2E artifacts: %s\n' "$ARTIFACT_ROOT"

WEAVE_CI_ARTIFACT_DIR="$ARTIFACT_ROOT/checkpoint" .github/ci/checkpoint-file.sh
WEAVE_CI_ARTIFACT_DIR="$ARTIFACT_ROOT/runtime-pairs" .github/ci/conformance.sh --suite native
WEAVE_CI_ARTIFACT_DIR="$ARTIFACT_ROOT/rust-guest" .github/ci/rust-guest.sh
