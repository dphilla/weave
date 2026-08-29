#!/usr/bin/env bash
# Build the no_std Rust/LLVM fixture away from the source tree and migrate it
# mid-render from Wasmtime to Node.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.github/ci/versions.env"
# shellcheck disable=SC1091
source "$ROOT/.github/ci/artifact-lifecycle.sh"
cd "$ROOT"

weave_ci_artifacts_init weave-rust-guest ARTIFACT_DIR
TIMEOUT_SECONDS="${WEAVE_CI_TIMEOUT_SECONDS:-300}"
FRAMES="${WEAVE_CI_MANDEL_FRAMES:-12}"
BUILD_DIR="$ARTIFACT_DIR/build"
GUEST="$BUILD_DIR/wasm32-unknown-unknown/release/mandel.wasm"
printf 'Rust guest artifacts: %s\n' "$ARTIFACT_DIR"

[[ "$(rustc --version)" == "rustc $RUST_VERSION "* ]] || {
  printf 'Rust guest lane requires rustc %s; got %s\n' "$RUST_VERSION" "$(rustc --version)" >&2
  exit 1
}
.github/ci/with-timeout.sh "$TIMEOUT_SECONDS" \
  rustup target add wasm32-unknown-unknown
.github/ci/with-timeout.sh "$TIMEOUT_SECONDS" env CARGO_TARGET_DIR="$BUILD_DIR" \
  cargo build --locked --release --target wasm32-unknown-unknown \
  --manifest-path guests/mandel/Cargo.toml
[[ -f "$GUEST" ]] || { printf 'Rust guest build did not create %s\n' "$GUEST" >&2; exit 1; }

WEAVE_CI_ARTIFACT_DIR="$ARTIFACT_DIR/conformance" \
WEAVE_CI_FIXTURE="$GUEST" \
WEAVE_CI_ENTRY=render \
WEAVE_CI_ARG="$FRAMES" \
WEAVE_CI_MIGRATE_AFTER_EVENTS=2 \
  .github/ci/conformance.sh --edge wasmtime:node
