#!/usr/bin/env bash
# Isolated tests for default/caller-provided artifact retention semantics.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIFECYCLE="$ROOT/.github/ci/artifact-lifecycle.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/weave-artifact-lifecycle-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/tmp" "$TEST_ROOT/caller"

run_case() {
  local expected_status="$1"
  shift
  local output status=0
  output="$(TMPDIR="$TEST_ROOT/tmp" bash -c '
    set -euo pipefail
    source "$1"
    shift
    weave_ci_artifacts_init weave-lifecycle-case ARTIFACT_DIR
    printf "%s\n" "$ARTIFACT_DIR"
    touch "$ARTIFACT_DIR/sentinel"
    "$@"
  ' bash "$LIFECYCLE" "$@")" || status=$?
  [[ "$status" == "$expected_status" ]] || {
    printf 'expected status %s, got %s\n' "$expected_status" "$status" >&2
    exit 1
  }
  printf '%s\n' "${output%%$'\n'*}"
}

success_path="$(run_case 0 true)"
[[ ! -e "$success_path" ]] || {
  printf 'successful default artifacts were retained: %s\n' "$success_path" >&2
  exit 1
}

failure_path="$(run_case 7 bash -c 'exit 7')"
[[ -f "$failure_path/sentinel" ]] || {
  printf 'failed-run artifacts were not retained: %s\n' "$failure_path" >&2
  exit 1
}

kept_path="$(WEAVE_CI_KEEP_TEMP=1 run_case 0 true)"
[[ -f "$kept_path/sentinel" ]] || {
  printf 'WEAVE_CI_KEEP_TEMP did not retain artifacts: %s\n' "$kept_path" >&2
  exit 1
}

caller_path="$TEST_ROOT/caller/artifacts"
WEAVE_CI_ARTIFACT_DIR="$caller_path" run_case 0 true >/dev/null
[[ -f "$caller_path/sentinel" ]] || {
  printf 'caller-provided artifacts were removed: %s\n' "$caller_path" >&2
  exit 1
}

rm -rf -- "$failure_path" "$kept_path"
printf '%s\n' 'PASS artifact lifecycle cleanup and retention'
