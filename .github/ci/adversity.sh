#!/usr/bin/env bash
# Scheduled protocol/adversity entry point. Existing language-specific tests
# contain the fine-grained malformed-frame and commit-boundary assertions;
# this script groups them and adds repeated black-box workload-progress cuts.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'EOF'
usage: .github/ci/adversity.sh protocol|migration|all

  protocol   Rust/JS/Go protocol, admission, rollback, and commit-cut tests
  migration  repeat Wasmtime migration after several emission thresholds
  all        both groups
EOF
}

run_protocol() {
  RUST_BACKTRACE=1 cargo test --locked --release -p weave-host --test protocol_security -- --nocapture
  RUST_BACKTRACE=1 cargo test --locked --release -p weave-wasmtime \
    --test live_migration --test root_audit_service_mismatch -- --nocapture
  node --test js/*.test.mjs demos/browser-wamr/*.test.mjs
  (
    cd go/weave-wazero
    go test -mod=readonly -count=1 ./...
    if [[ "${WEAVE_CI_GO_RACE:-0}" == 1 ]]; then
      go test -mod=readonly -race -count=1 ./...
    fi
  )
}

run_migration() {
  local root_artifacts="${WEAVE_CI_ARTIFACT_DIR:-${TMPDIR:-/tmp}/weave-adversity}"
  local cut
  for cut in 1 7 31; do
    WEAVE_CI_ARTIFACT_DIR="$root_artifacts/cut-$cut" \
    WEAVE_CI_ITERATIONS="${WEAVE_CI_ITERATIONS:-50000000}" \
    WEAVE_CI_MIGRATE_AFTER_EVENTS="$cut" \
      .github/ci/conformance.sh --edge wasmtime:wasmtime
  done
}

case "${1:-}" in
  protocol) run_protocol ;;
  migration) run_migration ;;
  all) run_protocol; run_migration ;;
  -h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
