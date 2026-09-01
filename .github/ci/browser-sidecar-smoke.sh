#!/usr/bin/env bash
# Build the generic Pion sidecar and require a real
# Chrome -> Wasmtime -> Chrome migration over its two WebRTC/TCP mappings.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.github/ci/artifact-lifecycle.sh"
cd "$ROOT"

NODE_BIN="${NODE_BIN:-node}"
command -v "$NODE_BIN" >/dev/null 2>&1 || {
  printf 'Node.js is required: %s\n' "$NODE_BIN" >&2
  exit 1
}
command -v go >/dev/null 2>&1 || { printf '%s\n' 'Go is required' >&2; exit 1; }

find_chrome() {
  local candidate resolved
  local -a candidates=()
  [[ -z "${CHROME_BIN:-}" ]] || candidates+=("$CHROME_BIN")
  case "$(uname -s)" in
    Darwin)
      candidates+=(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        '/Applications/Chromium.app/Contents/MacOS/Chromium'
      )
      ;;
    *) candidates+=(/usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser) ;;
  esac
  candidates+=(google-chrome google-chrome-stable chromium chromium-browser)
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then printf '%s\n' "$candidate"; return 0; fi
    resolved="$(command -v "$candidate" 2>/dev/null || true)"
    if [[ -n "$resolved" && -x "$resolved" ]]; then printf '%s\n' "$resolved"; return 0; fi
  done
  return 1
}

CHROME_BIN="$(find_chrome)" || {
  printf '%s\n' 'Chrome/Chromium is required; set CHROME_BIN to its executable' >&2
  exit 1
}

weave_ci_artifacts_init weave-browser-sidecar ARTIFACT_DIR
ROOT_CARGO_TARGET="${CARGO_TARGET_DIR:-$ROOT/target}"
WOVEN="$ARTIFACT_DIR/counter.woven.wasm"
SIDECAR_BIN="$ARTIFACT_DIR/bin/weave-rtc"
mkdir -p -- "$ARTIFACT_DIR/bin"
printf 'browser sidecar smoke artifacts: %s\n' "$ARTIFACT_DIR"

cargo build --locked --release -p weave-cli
(
  cd sidecars/webrtc
  go build -mod=readonly -trimpath -o "$SIDECAR_BIN" ./cmd/weave-rtc
)
"$ROOT_CARGO_TARGET/release/weave" transform guests/counter.wat -o "$WOVEN" --period 256

{
  printf 'git_sha=%s\n' "$(git rev-parse HEAD)"
  "$NODE_BIN" --version
  printf 'chrome_bin=%s\n' "$CHROME_BIN"
  "$CHROME_BIN" --version
  rustc --version
  cargo --version
  go version
  (cd sidecars/webrtc && go list -mod=readonly -m all)
} > "$ARTIFACT_DIR/versions.txt"

WEAVE_SMOKE_REQUIRED=1 \
CHROME_BIN="$CHROME_BIN" \
WEBRTC_SIDECAR_BIN="$SIDECAR_BIN" \
WEAVE_BIN="$ROOT_CARGO_TARGET/release/weave" \
WEAVE_DEMO_WASM="$WOVEN" \
"$NODE_BIN" demos/browser-sidecar/e2e-smoke.mjs \
  --require --artifacts "$ARTIFACT_DIR" 2>&1 | tee "$ARTIFACT_DIR/browser-sidecar-smoke.log"
