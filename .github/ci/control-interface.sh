#!/usr/bin/env bash
# Actual CLI and adversarial peer checks; persistent nodes retain operations.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/.github/ci/artifact-lifecycle.sh"
cd "$ROOT"
if [[ "${1:-}" == --help ]]; then
  printf '%s\n' 'usage: bash .github/ci/control-interface.sh [--skip-build]' 'Requires WAMR_ROOT, Node, Go, Rust. --skip-build requires prebuilt WEAVE_BIN, WAMR_BIN and WEAVE_WAZERO_BIN.'
  exit 0
fi
[[ $# == 0 || ( $# == 1 && "$1" == --skip-build ) ]] || { printf '%s\n' 'unknown argument' >&2; exit 2; }
weave_ci_artifacts_init weave-control-interface ARTIFACT_ROOT
export WEAVE_CI_ARTIFACT_DIR="$ARTIFACT_ROOT"
export NODE_BIN="${NODE_BIN:-node}"
export WEAVE_BIN="${WEAVE_BIN:-${CARGO_TARGET_DIR:-$ROOT/target}/release/weave}"
export WAMR_BIN="${WAMR_BIN:-${CARGO_TARGET_DIR:-$ROOT/wamr/target}/release/weave-wamr}"
export WEAVE_WAZERO_BIN="${WEAVE_WAZERO_BIN:-$ARTIFACT_ROOT/weave-wazero}"
if [[ "${1:-}" != --skip-build ]]; then
  cargo build --locked --release -p weave-cli
  cargo build --locked --release --manifest-path wamr/Cargo.toml
  (cd go/weave-wazero && go build -mod=readonly -o "$WEAVE_WAZERO_BIN" .)
fi
for binary in "$WEAVE_BIN" "$WAMR_BIN" "$WEAVE_WAZERO_BIN"; do
  [[ -x "$binary" ]] || { printf 'missing executable: %s\n' "$binary" >&2; exit 1; }
done
"$NODE_BIN" --test .github/ci/control-client.test.mjs 2>&1 | tee "$ARTIFACT_ROOT/client-tests.log"
"$NODE_BIN" .github/ci/control-interface.mjs 2>&1 | tee "$ARTIFACT_ROOT/runtime-cycle.log"
