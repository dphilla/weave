#!/usr/bin/env bash
# Build the current compiler, package one out-of-tree HTML file, and require
# real browser migrations over both supported demo transports.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
# shellcheck disable=SC1091
source "$ROOT/.github/ci/artifact-lifecycle.sh"
cd "$ROOT"

usage() {
  printf '%s\n' 'usage: .github/ci/pi-demo-smoke.sh [--quick] [--soak-ms N]' \
    '' 'Default: full local-transport checks, then quick WebRTC checks with literal ICE.' \
    '--quick       skip the longer fault cases in the local run too' \
    '--soak-ms N   hidden-tab soak in the local run only (0..900000; default 0)' \
    '' 'Requires Node.js 22+, Chrome/Chromium, Cargo, and rustc. No prerequisite is optional.' \
    'WEAVE_CI_ARTIFACT_DIR may select a persistent directory outside this checkout.'
}

QUICK=0
SOAK_MS=0
while (($# > 0)); do
  case "$1" in
    --quick) QUICK=1; shift ;;
    --soak-ms)
      [[ $# -ge 2 && "$2" =~ ^(0|[1-9][0-9]{0,5})$ && "$2" -le 900000 ]] || {
        printf '%s\n' '--soak-ms must be an integer from 0 to 900000' >&2
        exit 2
      }
      SOAK_MS="$2"; shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

resolve_executable() {
  local candidate="$1" resolved
  resolved="$(command -v "$candidate" 2>/dev/null || true)"
  [[ -n "$resolved" && -f "$resolved" && -x "$resolved" ]] || return 1
  printf '%s/%s\n' "$(cd "$(dirname "$resolved")" && pwd -P)" "$(basename "$resolved")"
}

NODE_BIN="$(resolve_executable "${NODE_BIN:-node}")" || {
  printf '%s\n' 'Node.js 22+ is required; set NODE_BIN to its executable' >&2
  exit 1
}
"$NODE_BIN" -e '
  if (Number(process.versions.node.split(".")[0]) < 22 || typeof WebSocket !== "function") {
    console.error("Node.js 22+ with its built-in WebSocket client is required");
    process.exit(1);
  }
'

find_chrome() {
  local candidate
  if [[ -n "${CHROME_BIN:-}" ]]; then
    resolve_executable "$CHROME_BIN"
    return $?
  fi
  for candidate in '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
    '/Applications/Chromium.app/Contents/MacOS/Chromium' \
    google-chrome google-chrome-stable chromium chromium-browser; do
    if resolve_executable "$candidate"; then return 0; fi
  done
  return 1
}
CHROME_BIN="$(find_chrome)" || {
  printf '%s\n' 'Chrome/Chromium is required; set CHROME_BIN to its executable' >&2
  exit 1
}
for tool in cargo rustc git; do
  resolve_executable "$tool" >/dev/null || { printf 'required tool is unavailable: %s\n' "$tool" >&2; exit 1; }
done

weave_ci_artifacts_init weave-pi-demo ARTIFACT_DIR
ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd -P)"
case "$ARTIFACT_DIR/" in
  "$ROOT/"*) printf '%s\n' 'Pi demo artifacts must be outside the checkout' >&2; exit 1 ;;
esac
DIST="$ARTIFACT_DIR/dist"
[[ ! -e "$DIST" && ! -L "$DIST" ]] || {
  printf '%s\n' 'Pi demo dist already exists; use a fresh artifact directory' >&2
  exit 1
}
printf 'Pi demo smoke artifacts: %s\n' "$ARTIFACT_DIR"

# CI tests what this Cargo invocation actually built, never an inherited demo
# override, committed fixture, or an assumed target/release path.
unset WEAVE_BIN WEAVE_PI_WASM WEAVE_PI_USE_FIXTURE
{
  printf 'git_sha=%s\n' "$(git rev-parse HEAD)"
  printf 'node_bin=%s\n' "$NODE_BIN"
  "$NODE_BIN" --version
  printf 'chrome_bin=%s\n' "$CHROME_BIN"
  "$CHROME_BIN" --version
  cargo --version
  rustc --version
  printf 'quick=%s\nlocal_soak_ms=%s\n' "$QUICK" "$SOAK_MS"
} > "$ARTIFACT_DIR/versions.txt"

if ! cargo build --locked --release -p weave-cli --message-format=json-render-diagnostics \
  > "$ARTIFACT_DIR/cargo-artifacts.jsonl" 2> "$ARTIFACT_DIR/cargo-build.log"; then
  cat "$ARTIFACT_DIR/cargo-build.log" >&2
  printf '%s\n' 'current Weave compiler build failed' >&2
  exit 1
fi
cat "$ARTIFACT_DIR/cargo-build.log" >&2
WEAVE_BIN="$("$NODE_BIN" --input-type=module - "$ROOT" "$ARTIFACT_DIR" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const [root, artifacts] = process.argv.slice(2);
const manifest = path.join(root, "crates/weave-cli/Cargo.toml");
const executables = new Set();
for (const line of fs.readFileSync(path.join(artifacts, "cargo-artifacts.jsonl"), "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  const item = JSON.parse(line);
  if (item.reason === "compiler-artifact" && item.target?.name === "weave"
    && item.target.kind?.includes("bin") && item.executable
    && typeof item.manifest_path === "string"
    && path.resolve(root, item.manifest_path) === manifest) {
    executables.add(path.resolve(root, item.executable));
  }
}
if (executables.size !== 1) throw new Error("Cargo must report exactly one executable for the current weave-cli manifest");
const executable = [...executables][0];
fs.accessSync(executable, fs.constants.X_OK);
if (!fs.statSync(executable).isFile()) throw new Error("Cargo compiler executable is not a regular file");
const hash = createHash("sha256");
for await (const chunk of fs.createReadStream(executable)) hash.update(chunk);
fs.writeFileSync(path.join(artifacts, "compiler.json"), JSON.stringify({
  executable, manifest, sha256: hash.digest("hex"),
}, null, 2) + "\n");
process.stdout.write(executable);
NODE
)"
printf 'compiler_bin=%s\n' "$WEAVE_BIN" >> "$ARTIFACT_DIR/versions.txt"

WEAVE_BIN="$WEAVE_BIN" "$NODE_BIN" demos/pi-migration/build.mjs --out-dir "$DIST" \
  2>&1 | tee "$ARTIFACT_DIR/package.log"
[[ -s "$DIST/index.html" && -s "$DIST/build-manifest.json" ]] || {
  printf '%s\n' 'Pi packaging did not produce index.html and build-manifest.json' >&2
  exit 1
}
"$NODE_BIN" --input-type=module - "$DIST" "$ARTIFACT_DIR/versions.txt" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const [dist, versions] = process.argv.slice(2);
const html = path.join(dist, "index.html");
const hash = createHash("sha256").update(fs.readFileSync(html)).digest("hex");
const manifest = JSON.parse(fs.readFileSync(path.join(dist, "build-manifest.json"), "utf8"));
if (manifest.htmlSha256 !== hash) throw new Error("Packaged Pi HTML does not match its build-manifest SHA-256");
fs.appendFileSync(versions, `html_path=${html}\nhtml_sha256=${hash}\n`);
NODE

local_args=(--transport local --soak-ms "$SOAK_MS")
if ((QUICK == 1)); then local_args+=(--quick); fi
"$NODE_BIN" demos/pi-migration/e2e.mjs --html "$DIST/index.html" --chrome "$CHROME_BIN" \
  --artifacts "$ARTIFACT_DIR/local" "${local_args[@]}" 2>&1 | tee "$ARTIFACT_DIR/local.log"
"$NODE_BIN" demos/pi-migration/e2e.mjs --html "$DIST/index.html" --chrome "$CHROME_BIN" \
  --artifacts "$ARTIFACT_DIR/webrtc" --transport webrtc --literal-ice --quick \
  2>&1 | tee "$ARTIFACT_DIR/webrtc.log"
printf '%s\n' 'PASS freshly packaged Pi demo in local and WebRTC browser modes'
