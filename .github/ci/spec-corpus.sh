#!/usr/bin/env bash
# Weekly transformer smoke against valid modules extracted from the official
# WebAssembly core testsuite. The corpus is monitoring, not a declaration that
# every current proposal is supported: expected transformer rejections are
# counted, while panics and invalid transformed output are hard failures.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.github/ci/versions.env"
# shellcheck disable=SC1091
source "$ROOT/.github/ci/artifact-lifecycle.sh"
cd "$ROOT"

usage() {
  cat <<'EOF'
usage: .github/ci/spec-corpus.sh [TESTSUITE_DIRECTORY]

If TESTSUITE_DIRECTORY is omitted, a read-only test-data checkout is created
under WEAVE_CI_ARTIFACT_DIR. The pinned official wasm-tools binary is
checksum-verified there unless WASM_TOOLS_BIN names an existing executable.

Environment:
  WEAVE_CI_ARTIFACT_DIR         report and extracted-module directory
  WASM_TOOLS_BIN                preinstalled wasm-tools executable
  WEAVE_CORPUS_MIN_SUCCESSES    minimum transformed valid modules (default 25)
  WEAVE_CORPUS_MAX_WAST_FILES   optional cap for local smoke testing
EOF
}

case "${1:-}" in -h|--help) usage; exit 0 ;; esac
[[ $# -le 1 ]] || { usage >&2; exit 2; }

weave_ci_artifacts_init weave-spec-corpus ARTIFACT_DIR
mkdir -p "$ARTIFACT_DIR/cases" "$ARTIFACT_DIR/tools"
printf 'spec corpus artifacts: %s\n' "$ARTIFACT_DIR"

WASM_TOOLS_BIN="${WASM_TOOLS_BIN:-$ARTIFACT_DIR/tools/bin/wasm-tools}"
if [[ ! -x "$WASM_TOOLS_BIN" ]]; then
  tool_env="$ARTIFACT_DIR/wasm-tools.env"
  .github/ci/prepare-wasm-tools.sh "$ARTIFACT_DIR/tools" | tee "$tool_env"
  WASM_TOOLS_BIN="$(sed -n 's/^WASM_TOOLS_BIN=//p' "$tool_env")"
fi

if [[ $# -eq 1 ]]; then
  TESTSUITE="$1"
  [[ -d "$TESTSUITE/.git" || -d "$TESTSUITE" ]] || {
    printf 'testsuite directory does not exist: %s\n' "$TESTSUITE" >&2
    exit 1
  }
else
  TESTSUITE="$ARTIFACT_DIR/testsuite"
  if [[ ! -d "$TESTSUITE/.git" ]]; then
    git clone --depth 1 "$WASM_TESTSUITE_REPOSITORY" "$TESTSUITE"
  fi
fi

cargo build --locked --release -p weave-cli
ROOT_CARGO_TARGET="${CARGO_TARGET_DIR:-$ROOT/target}"
WEAVE_BIN="${WEAVE_BIN:-$ROOT_CARGO_TARGET/release/weave}"
MIN_SUCCESSES="${WEAVE_CORPUS_MIN_SUCCESSES:-25}"
MAX_WAST="${WEAVE_CORPUS_MAX_WAST_FILES:-0}"

expected_rejection_reason() {
  local detail="$1"
  case "$detail" in
    'weave: error: parsing input module: unsupported:'*|'weave: error: parsing input module: unsupported ('*)
      printf '%s' 'explicit unsupported input feature'
      ;;
    'weave: error: unsupported: table with explicit init expression')
      printf '%s' 'explicit unsupported table initializer'
      ;;
    'weave: error: unsupported: imported funcref global')
      printf '%s' 'explicit unsupported imported funcref global'
      ;;
    'weave: error: emitting transformed module: unsupported: tag export')
      printf '%s' 'explicit unsupported exception tag export'
      ;;
    *) return 1 ;;
  esac
}

mapfile_compat() {
  # macOS still ships Bash 3; avoid mapfile/readarray.
  while IFS= read -r line; do WAST_FILES+=("$line"); done
}
declare -a WAST_FILES=()
mapfile_compat < <(find "$TESTSUITE" -maxdepth 1 -type f -name '*.wast' -print | LC_ALL=C sort)

successes=0
rejections=0
scripts=0
failures=0
processed=0
report="$ARTIFACT_DIR/report.tsv"
printf 'wast\tmodule\tresult\tdetail\n' > "$report"

for wast in "${WAST_FILES[@]}"; do
  if ((MAX_WAST > 0 && processed >= MAX_WAST)); then break; fi
  processed=$((processed + 1))
  stem="$(basename "$wast" .wast)"
  case_dir="$ARTIFACT_DIR/cases/$stem"
  mkdir -p "$case_dir"
  json="$case_dir/commands.json"
  wast="$(cd "$(dirname "$wast")" && pwd)/$(basename "$wast")"
  if ! (
    cd "$case_dir"
    "$WASM_TOOLS_BIN" json-from-wast "$wast" -o commands.json >extract.stdout 2>extract.stderr
  ); then
    printf '%s\t-\textract-failure\t%s\n' "$stem" "$(head -1 "$case_dir/extract.stderr" | tr '\t' ' ')" >> "$report"
    failures=$((failures + 1))
    continue
  fi
  scripts=$((scripts + 1))

  modules_file="$case_dir/modules.txt"
  if ! python3 - "$json" > "$modules_file" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    document = json.load(source)
for command in document.get("commands", []):
    if command.get("type") == "module" and command.get("filename"):
        print(command["filename"])
PY
  then
    printf '%s\t-\tjson-read-failure\tcommands.json could not be parsed\n' "$stem" >> "$report"
    failures=$((failures + 1))
    continue
  fi

  while IFS= read -r module; do
    [[ -n "$module" ]] || continue
    input="$case_dir/$module"
    output="$case_dir/${module%.wasm}.woven.wasm"
    stderr="$case_dir/${module%.wasm}.transform.stderr"
    if [[ ! -f "$input" ]]; then
      printf '%s\t%s\tmissing-extraction\tjson-from-wast did not create the declared module\n' "$stem" "$module" >> "$report"
      failures=$((failures + 1))
      continue
    fi
    if "$WEAVE_BIN" transform "$input" -o "$output" >"$case_dir/${module%.wasm}.transform.stdout" 2>"$stderr"; then
      if "$WASM_TOOLS_BIN" validate "$output" > /dev/null 2>"$case_dir/${module%.wasm}.validate.stderr"; then
        printf '%s\t%s\ttransformed\t-\n' "$stem" "$module" >> "$report"
        successes=$((successes + 1))
      else
        printf '%s\t%s\tinvalid-output\t%s\n' "$stem" "$module" "$(head -1 "$case_dir/${module%.wasm}.validate.stderr" | tr '\t' ' ')" >> "$report"
        failures=$((failures + 1))
      fi
    else
      transform_status=$?
      detail="$(head -1 "$stderr" | tr '\t' ' ')"
      # A crash must never be hidden by an earlier unsupported diagnostic.
      if ((transform_status > 128)) || grep -Eiq 'panic|panicked|internal error|segmentation fault|BUG:' "$stderr"; then
        printf '%s\t%s\ttransform-crash\t%s\n' "$stem" "$module" "$detail" >> "$report"
        failures=$((failures + 1))
      elif ((transform_status == 1)) && reason="$(expected_rejection_reason "$detail")"; then
        printf '%s\t%s\trejected\t%s: %s\n' "$stem" "$module" "$reason" "$detail" >> "$report"
        rejections=$((rejections + 1))
      else
        printf '%s\t%s\tunexpected-transform-failure\t%s\n' "$stem" "$module" "$detail" >> "$report"
        failures=$((failures + 1))
      fi
    fi
  done < "$modules_file"
done

{
  printf 'testsuite_commit=%s\n' "$(git -C "$TESTSUITE" rev-parse HEAD 2>/dev/null || printf supplied-unversioned)"
  printf 'wasm_tools=%s\n' "$($WASM_TOOLS_BIN --version)"
  printf 'wast_scripts=%s\n' "$scripts"
  printf 'transformed=%s\n' "$successes"
  printf 'expected_rejections=%s\n' "$rejections"
  printf 'hard_failures=%s\n' "$failures"
} | tee "$ARTIFACT_DIR/summary.txt"

if ((failures > 0)); then
  printf '%s\n' 'spec corpus produced hard failures; see report.tsv' >&2
  exit 1
fi
if ((successes < MIN_SUCCESSES)); then
  printf 'only %s valid modules transformed; minimum is %s\n' "$successes" "$MIN_SUCCESSES" >&2
  exit 1
fi
