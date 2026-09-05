#!/usr/bin/env bash
# Lint, build, and test the independent WAMR adapter workspace.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

[[ -n "${WAMR_ROOT:-}" ]] || {
  printf '%s\n' 'WAMR_ROOT must point to the verified WAMR checkout' >&2
  exit 1
}
[[ -f "$WAMR_ROOT/core/iwasm/include/wasm_export.h" ]] || {
  printf 'WAMR_ROOT is not a WAMR source tree: %s\n' "$WAMR_ROOT" >&2
  exit 1
}

WAMR_ROOT="$WAMR_ROOT" cargo clippy --locked --manifest-path wamr/Cargo.toml --all-targets -- -D warnings
WAMR_ROOT="$WAMR_ROOT" cargo test --locked --manifest-path wamr/Cargo.toml
WAMR_ROOT="$WAMR_ROOT" cargo build --locked --release --manifest-path wamr/Cargo.toml
