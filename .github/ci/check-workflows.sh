#!/usr/bin/env bash
# Syntax-check every centralized shell entry point and statically validate the
# GitHub Actions workflows. CI downloads actionlint through Go at one pin; a
# developer-installed actionlint is used when available.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.github/ci/versions.env"
cd "$ROOT"

bash -n .github/ci/*.sh
bash -n demos/*/*.sh
bash -n scripts/*.sh
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
while IFS= read -r use_line; do
  reference="$(printf '%s\n' "$use_line" | sed -E 's/^.*uses:[[:space:]]*([^[:space:]#]+).*$/\1/')"
  case "$reference" in
    ./*) continue ;;
  esac
  if ! printf '%s\n' "$reference" | grep -Eq '@[0-9a-f]{40}$'; then
    printf 'external action is not immutable-SHA pinned: %s\n' "$use_line" >&2
    pin_failures=$((pin_failures + 1))
  fi
done < <(grep -nH -E '^[[:space:]]*uses:' .github/workflows/*.yml .github/ci/setup/action.yml)
((pin_failures == 0)) || exit 1

if command -v actionlint >/dev/null 2>&1; then
  actionlint
else
  go run "github.com/rhysd/actionlint/cmd/actionlint@$ACTIONLINT_VERSION"
fi
