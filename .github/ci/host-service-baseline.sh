#!/usr/bin/env bash
# Existing built-in host-service behavior grouped behind one honest baseline.
# This is not yet a versioned plugin ABI or cross-runtime vector suite.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
NODE_BIN="${NODE_BIN:-node}"

cargo test --locked --release -p weave-wasmtime --test root_audit_service_mismatch -- --nocapture
cargo test --locked --release -p weave-host --test protocol_security \
  target_rejects_unknown_service_blob_before_any_restore -- --exact --nocapture
"$NODE_BIN" --test js/weave.test.mjs
(
  cd go/weave-wazero
  go test -mod=readonly -count=1 ./...
)
