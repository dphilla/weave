#!/usr/bin/env bash
# Exercise the wrapper in disposable checkouts. Cargo, Chrome, packaging, and
# browser work are stubs; Node runs the real version/JSON/hash checks only.

set -euo pipefail

if [[ "${WEAVE_PI_SMOKE_TEST_TOOL:-0}" == 1 ]]; then
  tool="$(basename "$0")"
  case "$tool" in
    cargo)
      if [[ "$1" == --version ]]; then printf '%s\n' 'cargo fixture'; exit 0; fi
      [[ "$*" == 'build --locked --release -p weave-cli --message-format=json-render-diagnostics' ]] || exit 91
      printf '%s\n' 'cargo-build' >> "$TEST_EVENTS"
      case "$TEST_MODE" in build-fail|default-build-fail) printf '%s\n' 'injected compiler build failure' >&2; exit 19 ;; esac
      [[ -z "${WEAVE_BIN+x}" && -z "${WEAVE_PI_WASM+x}" && -z "${WEAVE_PI_USE_FIXTURE+x}" ]] || exit 92
      if [[ "$TEST_MODE" != missing-executable ]]; then
        mkdir -p "$(dirname "$EXPECTED_COMPILER")"
        ln -s "$TEST_SCRIPT" "$EXPECTED_COMPILER"
      fi
      "$REAL_NODE" --input-type=module - <<'NODE'
import path from "node:path";
const manifest = path.join(process.cwd(), "crates/weave-cli/Cargo.toml");
const target = { name: "weave", kind: ["bin"] };
const record = { reason: "compiler-artifact", target, manifest_path: manifest,
  executable: process.env.TEST_MODE === "absolute-target" ? process.env.EXPECTED_COMPILER
    : path.relative(process.cwd(), process.env.EXPECTED_COMPILER) };
// A same-name dependency executable must not be mistaken for this package.
console.log(JSON.stringify({ ...record, manifest_path: "/other/Cargo.toml", executable: "/stale/weave" }));
if (process.env.TEST_MODE !== "missing-artifact") console.log(JSON.stringify(record));
if (process.env.TEST_MODE === "ambiguous-artifact") console.log(JSON.stringify({ ...record, executable: "/other/weave" }));
console.log(JSON.stringify({ reason: "build-finished", success: true }));
NODE
      exit 0
      ;;
    node)
      if [[ "$1" == -e && "$TEST_MODE" == old-node ]]; then
        printf '%s\n' 'Node.js 22+ with its built-in WebSocket client is required' >&2
        exit 1
      fi
      case "$1" in --version|-e|--input-type=module) exec "$REAL_NODE" "$@" ;; esac
      case "$1" in
        demos/pi-migration/build.mjs)
          [[ $# == 3 && "$2" == --out-dir ]] || exit 93
          [[ "$WEAVE_BIN" == "$EXPECTED_COMPILER" ]] || exit 94
          [[ -z "${WEAVE_PI_WASM+x}" && -z "${WEAVE_PI_USE_FIXTURE+x}" ]] || exit 95
          printf 'package|%s|%s\n' "$WEAVE_BIN" "$3" >> "$TEST_EVENTS"
          if [[ "$TEST_MODE" == package-fail ]]; then printf '%s\n' 'injected packaging failure' >&2; exit 23; fi
          if [[ "$TEST_MODE" == package-missing ]]; then exit 0; fi
          "$WEAVE_BIN" transform
          "$REAL_NODE" --input-type=module - "$3" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const dist = process.argv[2];
const html = "<!doctype html><title>fresh compiler fixture</title>\n";
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, "index.html"), html);
fs.writeFileSync(path.join(dist, "build-manifest.json"), JSON.stringify({
  htmlSha256: process.env.TEST_MODE === "hash-mismatch" ? "0".repeat(64)
    : createHash("sha256").update(html).digest("hex"),
}));
NODE
          exit 0
          ;;
        demos/pi-migration/e2e.mjs)
          shift
          html='' transport='' quick=0 soak=0 literal=0 artifacts=''
          while (($# > 0)); do
            case "$1" in
              --html) html="$2"; shift 2 ;;
              --chrome) [[ "$2" == "$EXPECTED_CHROME" ]] || exit 96; shift 2 ;;
              --artifacts) artifacts="$2"; shift 2 ;;
              --transport) transport="$2"; shift 2 ;;
              --soak-ms) soak="$2"; shift 2 ;;
              --quick) quick=1; shift ;;
              --literal-ice) literal=1; shift ;;
              *) printf 'unexpected E2E argument: %s\n' "$1" >&2; exit 97 ;;
            esac
          done
          [[ -s "$html" && -n "$artifacts" ]] || exit 98
          printf 'browser|%s|%s|quick=%s|soak=%s|literal=%s\n' \
            "$transport" "$html" "$quick" "$soak" "$literal" >> "$TEST_EVENTS"
          if [[ "$TEST_MODE" == "$transport-fail" ]]; then printf 'injected %s browser failure\n' "$transport" >&2; exit 24; fi
          mkdir -p "$artifacts"
          printf '%s\n' '{"passed":true}' > "$artifacts/results.json"
          exit 0
          ;;
      esac
      ;;
    chrome) [[ "$1" == --version ]] || exit 99; printf '%s\n' 'Chrome fixture'; exit 0 ;;
    rustc) [[ "$1" == --version ]] || exit 99; printf '%s\n' 'rustc fixture'; exit 0 ;;
    git) [[ "$*" == 'rev-parse HEAD' ]] || exit 99; printf '%s\n' fixture-git-sha; exit 0 ;;
    weave-current) printf '%s\n' 'compiler-used' >> "$TEST_EVENTS"; exit 0 ;;
    stale-compiler) printf '%s\n' 'stale-compiler-used' >> "$TEST_EVENTS"; exit 99 ;;
  esac
  printf 'unexpected fake tool invocation: %s\n' "$tool" >&2
  exit 99
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TEST_SCRIPT="$ROOT/.github/ci/pi-demo-smoke.test.sh"
REAL_NODE="$(command -v "${NODE_BIN:-node}")"
"$REAL_NODE" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/weave-pi-smoke-test.XXXXXX")"
TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT
case_count=0

run_case() {
  local mode="$1" expected="$2" diagnostic="$3"
  shift 3
  case_count=$((case_count + 1))
  local case_root="$TEST_ROOT/case-$case_count" tool utility_path status=0 artifact_path node_bin chrome_bin
  mkdir -p "$case_root/repo/.github/ci" "$case_root/repo/demos/pi-migration/dist" \
    "$case_root/bin" "$case_root/tmp" "$case_root/artifacts"
  cp "$ROOT/.github/ci/pi-demo-smoke.sh" "$ROOT/.github/ci/artifact-lifecycle.sh" "$case_root/repo/.github/ci/"
  printf '%s\n' checkout-html > "$case_root/repo/demos/pi-migration/dist/index.html"
  printf '%s\n' checkout-fixture > "$case_root/repo/demos/pi-migration/pi-fixture.mjs"
  : > "$case_root/events"
  # Keep the wrapper and fake-tool children on the interpreter under test.
  ln -s "$BASH" "$case_root/bin/bash"
  # No system PATH fallback: missing Cargo/rustc must not discover a real
  # installation on another host. These are the only required host utilities.
  for tool in basename dirname mkdir mktemp ln cat tee grep sed rm; do
    utility_path="$(command -v "$tool")"
    ln -s "$utility_path" "$case_root/bin/$tool"
  done
  for tool in node cargo rustc chrome git; do ln -s "$TEST_SCRIPT" "$case_root/bin/$tool"; done
  ln -s "$TEST_SCRIPT" "$case_root/stale-compiler"
  node_bin="$case_root/bin/node"
  chrome_bin="$case_root/bin/chrome"
  case "$mode" in
    missing-node) node_bin="$case_root/missing-node" ;;
    missing-chrome) chrome_bin="$case_root/missing-chrome" ;;
    missing-cargo) mv "$case_root/bin/cargo" "$case_root/disabled-cargo" ;;
    missing-rustc) mv "$case_root/bin/rustc" "$case_root/disabled-rustc" ;;
    stale-dist)
      mkdir "$case_root/artifacts/dist"
      printf '%s\n' stale-html > "$case_root/artifacts/dist/index.html"
      ;;
    dist-symlink) ln -s "$case_root/repo/demos/pi-migration/dist" "$case_root/artifacts/dist" ;;
    dangling-dist) ln -s "$case_root/absent" "$case_root/artifacts/dist" ;;
  esac
  (
    unset WEAVE_CI_ARTIFACT_DIR WEAVE_CI_KEEP_TEMP
    export WEAVE_CI_ARTIFACT_DIR="$case_root/artifacts"
    case "$mode" in
      default-temp|default-build-fail|default-keep) unset WEAVE_CI_ARTIFACT_DIR ;;
      checkout-artifacts) export WEAVE_CI_ARTIFACT_DIR="$case_root/repo/artifacts" ;;
    esac
    [[ "$mode" != default-keep ]] || export WEAVE_CI_KEEP_TEMP=1
    export CARGO_TARGET_DIR='../relocated target'
    [[ "$mode" != absolute-target ]] || export CARGO_TARGET_DIR="$case_root/relocated target"
    export REAL_NODE TEST_SCRIPT WEAVE_PI_SMOKE_TEST_TOOL=1 TEST_MODE="$mode" TEST_EVENTS="$case_root/events"
    export EXPECTED_COMPILER="$case_root/relocated target/release/weave-current" EXPECTED_CHROME="$chrome_bin"
    export WEAVE_BIN="$case_root/stale-compiler" WEAVE_PI_WASM="$case_root/stale.wasm" WEAVE_PI_USE_FIXTURE=1
    export NODE_BIN="$node_bin" CHROME_BIN="$chrome_bin" TMPDIR="$case_root/tmp"
    export PATH="$case_root/bin"
    "$BASH" "$case_root/repo/.github/ci/pi-demo-smoke.sh" "$@"
  ) > "$case_root/run.log" 2>&1 || status=$?

  if { [[ "$expected" == pass ]] && [[ "$status" != 0 ]]; } \
    || { [[ "$expected" == fail ]] && [[ "$status" == 0 ]]; }; then
    printf 'FAIL Pi wrapper %s: expected %s, got exit %s\n' "$mode" "$expected" "$status" >&2
    cat "$case_root/run.log" >&2
    exit 1
  fi
  if [[ -n "$diagnostic" ]] && ! grep -Fq -- "$diagnostic" "$case_root/run.log"; then
    printf 'FAIL Pi wrapper %s: missing diagnostic %s\n' "$mode" "$diagnostic" >&2
    cat "$case_root/run.log" >&2
    exit 1
  fi
  [[ "$(cat "$case_root/repo/demos/pi-migration/dist/index.html")" == checkout-html ]]
  [[ "$(cat "$case_root/repo/demos/pi-migration/pi-fixture.mjs")" == checkout-fixture ]]
  ! grep -Fq stale-compiler-used "$case_root/events"
  artifact_path="$(sed -n 's/^Pi demo smoke artifacts: //p' "$case_root/run.log")"
  if [[ "$expected" == pass && "$mode" != help ]]; then
    local quick=0 soak=0
    [[ "$mode" != quick ]] || quick=1
    [[ "$mode" != default-temp && "$mode" != default-keep ]] || quick=1
    [[ "$mode" != soak ]] || soak=370000
    grep -Fxq cargo-build "$case_root/events"
    grep -Fxq compiler-used "$case_root/events"
    grep -Fxq "package|$case_root/relocated target/release/weave-current|$artifact_path/dist" "$case_root/events"
    grep -Fxq "browser|local|$artifact_path/dist/index.html|quick=$quick|soak=$soak|literal=0" "$case_root/events"
    grep -Fxq "browser|webrtc|$artifact_path/dist/index.html|quick=1|soak=0|literal=1" "$case_root/events"
    if [[ "$mode" == default-temp ]]; then
      [[ ! -e "$artifact_path" ]]
    else
      [[ -s "$artifact_path/compiler.json" && -s "$artifact_path/versions.txt" ]]
      grep -Fq 'html_sha256=' "$artifact_path/versions.txt"
      [[ -s "$artifact_path/local/results.json" && -s "$artifact_path/webrtc/results.json" ]]
    fi
  fi
  case "$mode" in
    missing-node|old-node|missing-chrome|missing-cargo|missing-rustc|stale-dist|dist-symlink|dangling-dist|checkout-artifacts|bad-option|bad-soak|help)
      [[ ! -s "$case_root/events" ]]
      ;;
    build-fail|default-build-fail|missing-artifact|ambiguous-artifact|missing-executable)
      ! grep -Eq '^package\||^browser\|' "$case_root/events"
      [[ -s "$artifact_path/cargo-artifacts.jsonl" || -s "$artifact_path/cargo-build.log" ]]
      ;;
    package-fail|package-missing|hash-mismatch) ! grep -Eq '^browser\|' "$case_root/events" ;;
    local-fail) ! grep -Fq 'browser|webrtc|' "$case_root/events" ;;
    webrtc-fail) grep -Fq 'browser|local|' "$case_root/events" ;;
  esac
  if [[ "$mode" == stale-dist ]]; then [[ "$(cat "$case_root/artifacts/dist/index.html")" == stale-html ]]; fi
  if [[ "$mode" == dangling-dist ]]; then [[ ! -e "$case_root/absent" && -L "$case_root/artifacts/dist" ]]; fi
}

run_case baseline pass ''
run_case absolute-target pass ''
run_case quick pass '' --quick
run_case soak pass '' --soak-ms 370000
run_case missing-node fail 'Node.js 22+ is required'
run_case old-node fail 'Node.js 22+ with its built-in WebSocket client is required'
run_case missing-chrome fail 'Chrome/Chromium is required'
run_case missing-cargo fail 'required tool is unavailable: cargo'
run_case missing-rustc fail 'required tool is unavailable: rustc'
run_case build-fail fail 'current Weave compiler build failed'
run_case missing-artifact fail 'Cargo must report exactly one executable'
run_case ambiguous-artifact fail 'Cargo must report exactly one executable'
run_case missing-executable fail 'ENOENT'
run_case package-fail fail 'injected packaging failure'
run_case package-missing fail 'Pi packaging did not produce'
run_case hash-mismatch fail 'does not match its build-manifest SHA-256'
run_case local-fail fail 'injected local browser failure'
run_case webrtc-fail fail 'injected webrtc browser failure'
run_case stale-dist fail 'dist already exists'
run_case dist-symlink fail 'dist already exists'
run_case dangling-dist fail 'dist already exists'
run_case checkout-artifacts fail 'artifacts must be outside the checkout'
run_case bad-option fail 'usage:' --unknown
run_case bad-soak fail '--soak-ms must be an integer' --soak-ms -1
run_case bad-soak fail '--soak-ms must be an integer' --soak-ms 900001
run_case help pass 'usage:' --help
run_case default-temp pass '' --quick
run_case default-keep pass '' --quick
run_case default-build-fail fail 'current Weave compiler build failed'
printf 'PASS Pi demo smoke wrapper (%s fixture cases; no builds or browsers)\n' "$case_count"
