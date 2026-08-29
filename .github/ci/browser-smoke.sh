#!/usr/bin/env bash
# Build prerequisites and run the required real Chrome <-> WAMR smoke test.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.github/ci/artifact-lifecycle.sh"
cd "$ROOT"

[[ -n "${WAMR_ROOT:-}" ]] || {
  printf '%s\n' 'WAMR_ROOT must point to the verified WAMR checkout' >&2
  exit 1
}
NODE_BIN="${NODE_BIN:-node}"
command -v "$NODE_BIN" >/dev/null 2>&1 || { printf 'Node.js is required: %s\n' "$NODE_BIN" >&2; exit 1; }

find_chrome() {
  local candidate resolved
  local -a candidates=()
  if [[ -n "${CHROME_BIN:-}" ]]; then
    candidates+=("$CHROME_BIN")
  fi
  case "$(uname -s)" in
    Darwin)
      candidates+=(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        '/Applications/Chromium.app/Contents/MacOS/Chromium'
      )
      ;;
    *)
      candidates+=(/usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser)
      ;;
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

weave_ci_artifacts_init weave-browser-smoke ARTIFACT_DIR
ROOT_CARGO_TARGET="${CARGO_TARGET_DIR:-$ROOT/target}"
WAMR_CARGO_TARGET="${CARGO_TARGET_DIR:-$ROOT/wamr/target}"
printf 'browser smoke artifacts: %s\n' "$ARTIFACT_DIR"
WOVEN="$ARTIFACT_DIR/counter.woven.wasm"

cargo build --locked --release -p weave-cli
WAMR_ROOT="$WAMR_ROOT" cargo build --locked --release --manifest-path wamr/Cargo.toml
"$ROOT_CARGO_TARGET/release/weave" transform guests/counter.wat -o "$WOVEN" --period 256

{
  printf 'git_sha=%s\n' "$(git rev-parse HEAD)"
  "$NODE_BIN" --version
  printf 'chrome_bin=%s\n' "$CHROME_BIN"
  "$CHROME_BIN" --version
  git -C "$WAMR_ROOT" rev-parse HEAD
} > "$ARTIFACT_DIR/versions.txt"

WEAVE_SMOKE_REQUIRED=1 \
CHROME_BIN="$CHROME_BIN" \
WAMR_BIN="${WEAVE_WAMR_BIN:-$WAMR_CARGO_TARGET/release/weave-wamr}" \
WEAVE_DEMO_WASM="$WOVEN" \
"$NODE_BIN" demos/browser-wamr/e2e-smoke.mjs --require 2>&1 | tee "$ARTIFACT_DIR/browser-smoke.log"
