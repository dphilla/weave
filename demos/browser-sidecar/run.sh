#!/usr/bin/env bash
# Build disposable demo artifacts, then supervise Wasmtime, the generic
# WebRTC sidecar, and the bounded signaling/static server.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

NODE_BIN="${NODE_BIN:-node}"
command -v "$NODE_BIN" >/dev/null 2>&1 || {
  printf 'Node.js is required: %s\n' "$NODE_BIN" >&2
  exit 1
}
command -v go >/dev/null 2>&1 || { printf '%s\n' 'Go is required' >&2; exit 1; }
command -v cargo >/dev/null 2>&1 || { printf '%s\n' 'Cargo is required' >&2; exit 1; }

DEMO_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/weave-browser-sidecar.XXXXXX")"
cleanup() {
  rm -rf -- "$DEMO_TEMP"
}
trap cleanup EXIT INT TERM

CARGO_OUTPUT="${CARGO_TARGET_DIR:-$ROOT/target}"
WEAVE_BIN="$CARGO_OUTPUT/release/weave"
SIDECAR_BIN="$DEMO_TEMP/weave-rtc"
WOVEN="$DEMO_TEMP/counter.woven.wasm"

cargo build --locked --release -p weave-cli
(
  cd sidecars/webrtc
  go build -mod=readonly -trimpath -o "$SIDECAR_BIN" ./cmd/weave-rtc
)
"$WEAVE_BIN" transform guests/counter.wat -o "$WOVEN" --period 256

"$NODE_BIN" demos/browser-sidecar/controller.mjs \
  --sidecar "$SIDECAR_BIN" \
  --weave "$WEAVE_BIN" \
  --wasm "$WOVEN" \
  "$@"
