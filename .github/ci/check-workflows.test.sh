#!/usr/bin/env bash
# Exercise the real validator in disposable repositories, without downloads,
# recursive self-tests, or execution of scripts being syntax-checked.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/weave-workflow-validation-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT
cp "$ROOT/.github/ci/check-workflows.sh" "$TEST_ROOT/validator-under-test.sh"

case_count=0
failure_count=0
SHA=0123456789abcdef0123456789abcdef01234567

write_action() {
  local file="$1" style="$2" reference="$3" indent
  if [[ "$file" == */setup/action.yml ]]; then
    printf '%s\n' 'name: Fixture setup' 'description: Fixture only' 'runs:' \
      '  using: composite' '  steps:' > "$file"
    indent='    '
  else
    printf '%s\n' 'name: Fixture workflow' 'on: push' 'jobs:' '  check:' \
      '    runs-on: ubuntu-latest' '    steps:' > "$file"
    indent='      '
  fi
  # Commented examples must not be treated as active dependencies.
  printf '%s# uses: owner/commented@main\n%s# - uses: owner/commented@v4\n' \
    "$indent" "$indent" >> "$file"
  if [[ "$style" == mapping ]]; then
    printf '%s- name: Fixture action\n%s  uses:    %s\n' \
      "$indent" "$indent" "$reference" >> "$file"
  else
    printf '%s-   uses:    %s\n' "$indent" "$reference" >> "$file"
  fi
}

new_fixture() {
  case_count=$((case_count + 1))
  CASE_ROOT="$TEST_ROOT/case-$case_count"
  mkdir -p "$CASE_ROOT/.github/ci/setup" "$CASE_ROOT/.github/workflows" \
    "$CASE_ROOT/demos/aaa-syntax" "$CASE_ROOT/demos/browser-sidecar" \
    "$CASE_ROOT/demos/server-chain" "$CASE_ROOT/demos/zzz-syntax" \
    "$CASE_ROOT/scripts" "$CASE_ROOT/bin"
  cp "$TEST_ROOT/validator-under-test.sh" "$CASE_ROOT/.github/ci/check-workflows.sh"
  printf '%s\n' 'ACTIONLINT_VERSION=fixture-must-not-download' > "$CASE_ROOT/.github/ci/versions.env"

  local script
  for script in .github/ci/000-first.sh .github/ci/package-smoke.sh \
    .github/ci/semantic-conformance.sh .github/ci/browser-sidecar-smoke.sh \
    .github/ci/awake-guard.sh .github/ci/wait-for.sh \
    demos/aaa-syntax/000-first.sh demos/browser-sidecar/run.sh \
    scripts/000-first.sh scripts/cleanup.sh; do
    printf '%s\n' '#!/usr/bin/env bash' \
      'printf executed > "$WEAVE_WORKFLOW_TEST_EXECUTED"' 'exit 87' > "$CASE_ROOT/$script"
    chmod +x "$CASE_ROOT/$script"
  done
  printf '%s\n' '#!/usr/bin/env bash' 'unset WEAVE_CI_ARTIFACT_DIR' > "$CASE_ROOT/.github/ci/qualification.sh"
  for script in artifact-lifecycle cleanup awake-guard wait-for spec-corpus check-workflows; do
    printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$CASE_ROOT/.github/ci/$script.test.sh"
    chmod +x "$CASE_ROOT/.github/ci/$script.test.sh"
  done
  printf '%s\n' '#!/usr/bin/env bash' '[[ "$1" == --list ]] || exit 88' \
    "printf '%s\\n' 'route wasmtime:node:wazero'" > "$CASE_ROOT/demos/server-chain/run.sh"
  chmod +x "$CASE_ROOT/demos/server-chain/run.sh"
  printf '%s\n' '#!/usr/bin/env bash' \
    'printf actionlint > "$WEAVE_WORKFLOW_TEST_LINT_MARKER"' > "$CASE_ROOT/bin/actionlint"
  printf '%s\n' '#!/usr/bin/env bash' 'printf unexpected-go > "$WEAVE_WORKFLOW_TEST_GO_MARKER"' \
    'exit 89' > "$CASE_ROOT/bin/go"
  chmod +x "$CASE_ROOT/bin/actionlint" "$CASE_ROOT/bin/go"
  write_action "$CASE_ROOT/.github/workflows/check.yml" mapping "owner/action@$SHA"
  write_action "$CASE_ROOT/.github/ci/setup/action.yml" mapping './.github/actions/local'
}

run_fixture() {
  local label="$1" expected="$2" diagnostic="${3:-}" status=0 failed=0
  PATH="$CASE_ROOT/bin:$PATH" \
    WEAVE_WORKFLOW_TEST_EXECUTED="$CASE_ROOT/executed" \
    WEAVE_WORKFLOW_TEST_LINT_MARKER="$CASE_ROOT/linted" \
    WEAVE_WORKFLOW_TEST_GO_MARKER="$CASE_ROOT/go-invoked" \
    bash "$CASE_ROOT/.github/ci/check-workflows.sh" > "$CASE_ROOT/run.log" 2>&1 || status=$?
  if [[ "$expected" == pass ]]; then
    if [[ "$status" != 0 || ! -f "$CASE_ROOT/linted" ]]; then
      printf 'FAIL %s: expected success and actionlint, got status %s\n' "$label" "$status" >&2
      failed=1
    fi
  else
    if [[ "$status" == 0 ]]; then
      printf 'FAIL %s: invalid fixture was accepted\n' "$label" >&2
      failed=1
    fi
    if [[ -f "$CASE_ROOT/linted" ]]; then
      printf 'FAIL %s: actionlint ran before the static rejection\n' "$label" >&2
      failed=1
    fi
    if ! grep -Fq -- "$diagnostic" "$CASE_ROOT/run.log"; then
      printf 'FAIL %s: missing diagnostic %s\n' "$label" "$diagnostic" >&2
      failed=1
    fi
  fi
  if [[ -f "$CASE_ROOT/executed" || -f "$CASE_ROOT/go-invoked" ]]; then
    printf 'FAIL %s: executed a syntax-only script or attempted a Go invocation\n' "$label" >&2
    failed=1
  fi
  if [[ "$failed" == 1 ]]; then
    failure_count=$((failure_count + 1))
    cat "$CASE_ROOT/run.log" >&2
  fi
}

new_fixture
run_fixture 'valid baseline; syntax checks do not execute script bodies' pass

for broken in .github/ci/zz-broken.sh demos/zzz-syntax/zz-broken.sh scripts/zz-broken.sh; do
  new_fixture
  # Each glob has a valid, lexically earlier file. `bash -n glob...` checks
  # only that first file; this must reject the later file independently.
  printf '%s\n' '#!/usr/bin/env bash' 'if then' > "$CASE_ROOT/$broken"
  run_fixture "non-first syntax error: $broken" fail "$broken"
done

for missing in .github/workflows/check.yml .github/ci/setup/action.yml; do
  new_fixture
  mv "$CASE_ROOT/$missing" "$CASE_ROOT/missing-input.yml"
  run_fixture "missing action scan input: $missing" fail 'failed to scan workflow action references'
done

for location in .github/workflows/check.yml .github/ci/setup/action.yml; do
  for style in mapping sequence; do
    for reference in owner/action@v4 owner/action@main owner/action@0123456; do
      new_fixture
      write_action "$CASE_ROOT/$location" "$style" "$reference"
      run_fixture "reject $location $style $reference" fail 'external action is not immutable-SHA pinned:'
    done
    new_fixture
    write_action "$CASE_ROOT/$location" "$style" "owner/action@main # uses: owner/decoy@$SHA"
    run_fixture "reject comment pin spoof: $location $style" fail 'external action is not immutable-SHA pinned:'
    for reference in "owner/action@$SHA # pinned" './.github/actions/local # local' \
      "'owner/action@$SHA' # single quoted" "\"owner/action@$SHA\" # double quoted" \
      "'./.github/actions/local' # single quoted" '"./.github/actions/local" # double quoted'; do
      new_fixture
      write_action "$CASE_ROOT/$location" "$style" "$reference"
      run_fixture "accept $location $style $reference" pass
    done
  done
done

if [[ "$failure_count" != 0 ]]; then
  printf 'FAIL workflow validation (%s/%s fixtures failed)\n' "$failure_count" "$case_count" >&2
  exit 1
fi
printf 'PASS workflow validation (%s fixture cases; no downloads or recursive tests)\n' "$case_count"
