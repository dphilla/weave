#!/usr/bin/env bash
# Build a small woven fixture, then start the dependency-free static/signaling
# server. CI orchestration remains under .github/ci; this is a demo launcher.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

NODE_BIN="${NODE_BIN:-node}"
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  exec "$NODE_BIN" demos/browser-webrtc/server.mjs --help
fi

ARTIFACT_DIR="${WEAVE_DEMO_ARTIFACT_DIR:-$ROOT/target/demo-artifacts/browser-webrtc}"
ROOT_CARGO_TARGET="${CARGO_TARGET_DIR:-$ROOT/target}"
WEAVE_BIN="${WEAVE_BIN:-$ROOT_CARGO_TARGET/debug/weave}"
WOVEN="${WEAVE_DEMO_WASM:-$ARTIFACT_DIR/counter.woven.wasm}"

command -v cargo >/dev/null 2>&1 || { printf '%s\n' 'Rust/Cargo is required' >&2; exit 1; }
command -v "$NODE_BIN" >/dev/null 2>&1 || { printf 'Node.js is required: %s\n' "$NODE_BIN" >&2; exit 1; }

mkdir -p "$ARTIFACT_DIR"
cargo build --locked -p weave-cli
"$WEAVE_BIN" transform guests/counter.wat -o "$WOVEN" --period 256

exec "$NODE_BIN" demos/browser-webrtc/server.mjs --wasm "$WOVEN" "$@"
