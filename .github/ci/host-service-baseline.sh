#!/usr/bin/env bash
# Existing built-in host-service behavior grouped behind one honest baseline.
# This is not yet a versioned plugin ABI or cross-runtime vector suite.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.github/ci/artifact-lifecycle.sh"
cd "$ROOT"
NODE_BIN="${NODE_BIN:-node}"
weave_ci_artifacts_init weave-host-service-baseline FIXTURE_DIR

cargo test --locked --release -p weave-wasmtime --test root_audit_service_mismatch -- --nocapture
cargo test --locked --release -p weave-wasmtime --test library_lifecycle
cargo test --locked --release -p weave-host --test protocol_security \
  target_rejects_unknown_service_blob_before_any_restore -- --exact --nocapture
"$NODE_BIN" --test js/weave.test.mjs
# Repeat the public-library tests against this compiler's output, not only the
# recorded woven fixture used by the standalone JavaScript test lane.
cargo run --locked --release -p weave-cli -- transform js/test-support/lifecycle.wat \
  --period 1 --stack-pages 2 -o "$FIXTURE_DIR/lifecycle.woven.wasm"
WEAVE_LIFECYCLE_FIXTURE="$FIXTURE_DIR/lifecycle.woven.wasm" \
  "$NODE_BIN" --test js/weave-lifecycle.test.mjs js/weave-lifecycle-migration.test.mjs
(
  cd go/weave-wazero
  go test -mod=readonly -count=1 ./...
)
