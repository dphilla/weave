#!/usr/bin/env bash
# Syntax-check every centralized shell entry point and statically validate the
# GitHub Actions workflows. CI downloads actionlint through Go at one pin; a
# developer-installed actionlint is used when available.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.github/ci/versions.env"
cd "$ROOT"

# bash -n accepts one script; additional arguments are that script's argv.
shell_scripts=0
for script in .github/ci/*.sh demos/*/*.sh scripts/*.sh; do
  if ! bash -n "$script"; then
    printf 'shell syntax check failed: %s\n' "$script" >&2
    exit 1
  fi
  shell_scripts=$((shell_scripts + 1))
done
printf 'PASS shell syntax (%s scripts)\n' "$shell_scripts"
[[ -x demos/server-chain/run.sh ]] || {
  printf '%s\n' 'demos/server-chain/run.sh must be executable' >&2
  exit 1
}
[[ -x scripts/cleanup.sh ]] || {
  printf '%s\n' 'scripts/cleanup.sh must be executable' >&2
  exit 1
}
[[ -x .github/ci/package-smoke.sh ]] || {
  printf '%s\n' '.github/ci/package-smoke.sh must be executable' >&2
  exit 1
}
[[ -x .github/ci/semantic-conformance.sh ]] || {
  printf '%s\n' '.github/ci/semantic-conformance.sh must be executable' >&2
  exit 1
}
[[ -x .github/ci/browser-sidecar-smoke.sh ]] || {
  printf '%s\n' '.github/ci/browser-sidecar-smoke.sh must be executable' >&2
  exit 1
}
[[ -r .github/ci/awake-guard.sh ]] || {
  printf '%s\n' '.github/ci/awake-guard.sh must be readable' >&2
  exit 1
}
[[ -x .github/ci/wait-for.sh ]] || {
  printf '%s\n' '.github/ci/wait-for.sh must be executable' >&2
  exit 1
}
[[ -x demos/browser-sidecar/run.sh ]] || {
  printf '%s\n' 'demos/browser-sidecar/run.sh must be executable' >&2
  exit 1
}
grep -Fxq 'unset WEAVE_CI_ARTIFACT_DIR' .github/ci/qualification.sh || {
  printf '%s\n' 'qualification.sh must not leak its root artifact override into child lifecycle tests' >&2
  exit 1
}

bash .github/ci/check-workflows.test.sh
.github/ci/artifact-lifecycle.test.sh
.github/ci/cleanup.test.sh
.github/ci/awake-guard.test.sh
.github/ci/wait-for.test.sh
.github/ci/spec-corpus.test.sh

server_chain_list="$(demos/server-chain/run.sh --list)"
[[ "$server_chain_list" == 'route wasmtime:node:wazero' ]] || {
  printf 'unexpected server-chain route:\n%s\n' "$server_chain_list" >&2
  exit 1
}

pin_failures=0
pin_references=0
# Check block-style mapping and sequence entries, including composite actions.
# Capture grep's status: process substitution would hide file-read failures.
scan_status=0
use_lines="$(grep -nH -E '^[[:space:]]*(-[[:space:]]+)?uses:' \
  .github/workflows/*.yml .github/ci/setup/action.yml)" || scan_status=$?
if [[ "$scan_status" -gt 1 ]]; then
  printf '%s\n' 'failed to scan workflow action references' >&2
  exit 1
fi
while IFS= read -r use_line; do
  [[ -n "$use_line" ]] || continue
  pin_references=$((pin_references + 1))
  # Remove grep's file:line prefix, then parse only the leading uses value.
  # A later "uses:" inside a comment must not override an unpinned reference.
  reference="${use_line#*:}"
  reference="${reference#*:}"
  reference="$(printf '%s\n' "$reference" | sed -nE \
    "s/^[[:space:]]*(-[[:space:]]+)?uses:[[:space:]]*['\"]?([^[:space:]#'\"]+).*$/\\2/p")"
  case "$reference" in
    ./*) continue ;;
  esac
  if ! printf '%s\n' "$reference" | grep -Eq '@[0-9a-f]{40}$'; then
    printf 'external action is not immutable-SHA pinned: %s\n' "$use_line" >&2
    pin_failures=$((pin_failures + 1))
  fi
done <<< "$use_lines"
((pin_failures == 0)) || exit 1
printf 'PASS action pins (%s references)\n' "$pin_references"

if command -v actionlint >/dev/null 2>&1; then
  actionlint
else
  go run "github.com/rhysd/actionlint/cmd/actionlint@$ACTIONLINT_VERSION"
fi
