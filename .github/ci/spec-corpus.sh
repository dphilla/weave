#!/usr/bin/env bash
# Transformer smoke against valid modules extracted from the pinned official
# WebAssembly core testsuite; --upstream explicitly probes drift. This is not a declaration that
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
usage: .github/ci/spec-corpus.sh [--pinned | --upstream | TESTSUITE_DIRECTORY]

The default is the qualified immutable testsuite pin from versions.env.
--upstream fetches the current official default-branch HEAD and fails strictly
on extraction or transformer regressions. A supplied directory is never updated
and is reported separately from these managed modes. Automatically acquired
test data is kept under WEAVE_CI_ARTIFACT_DIR. The pinned wasm-tools binary is
checksum-verified there unless WASM_TOOLS_BIN names an existing executable.

Environment:
  WEAVE_CI_ARTIFACT_DIR         fresh report and extracted-module directory
  WASM_TOOLS_BIN                preinstalled wasm-tools executable
  WEAVE_BIN                    prebuilt CLI; skips the normal Cargo build
  WEAVE_CORPUS_MIN_SUCCESSES    minimum transformed valid modules (default 25)
  WEAVE_CORPUS_MAX_WAST_FILES   optional cap for local smoke testing
EOF
}

case "${1:-}" in -h|--help) usage; exit 0 ;; esac
[[ $# -le 1 ]] || { usage >&2; exit 2; }
CORPUS_MODE=pinned
case "${1:-}" in
  ''|--pinned) ;;
  --upstream) CORPUS_MODE=upstream ;;
  -*) usage >&2; exit 2 ;;
  *) CORPUS_MODE=supplied ;;
esac
MIN_SUCCESSES="${WEAVE_CORPUS_MIN_SUCCESSES:-25}"
MAX_WAST="${WEAVE_CORPUS_MAX_WAST_FILES:-0}"
for number in "$MIN_SUCCESSES" "$MAX_WAST"; do
  [[ "$number" =~ ^(0|[1-9][0-9]{0,8})$ ]] || {
    printf '%s\n' 'corpus limits must be decimal integers between 0 and 999999999' >&2
    exit 2
  }
done

weave_ci_artifacts_init weave-spec-corpus ARTIFACT_DIR
mkdir "$ARTIFACT_DIR/cases" || {
  printf '%s\n' 'corpus cases already exist or cannot be created; choose a fresh artifact directory' >&2
  exit 1
}
mkdir -p "$ARTIFACT_DIR/tools"
printf 'spec corpus artifacts: %s\n' "$ARTIFACT_DIR"

resolve_executable() {
  local candidate="$1" label="$2"
  if [[ "$candidate" != */* ]]; then candidate="$(command -v "$candidate" || true)"; fi
  [[ -n "$candidate" && -f "$candidate" && -x "$candidate" ]] || {
    printf '%s does not name an executable file: %s\n' "$label" "$1" >&2
    return 1
  }
  # Keep the final symlink name: supplied multi-call tools may inspect argv[0].
  printf '%s/%s\n' "$(cd "$(dirname "$candidate")" && pwd)" "$(basename "$candidate")"
}

if [[ -n "${WASM_TOOLS_BIN+x}" ]]; then
  WASM_TOOLS_BIN="$(resolve_executable "$WASM_TOOLS_BIN" WASM_TOOLS_BIN)"
else
  tool_env="$ARTIFACT_DIR/wasm-tools.env"
  .github/ci/prepare-wasm-tools.sh "$ARTIFACT_DIR/tools" | tee "$tool_env"
  WASM_TOOLS_BIN="$(sed -n 's/^WASM_TOOLS_BIN=//p' "$tool_env")"
  WASM_TOOLS_BIN="$(resolve_executable "$WASM_TOOLS_BIN" WASM_TOOLS_BIN)"
fi

if [[ "$CORPUS_MODE" == supplied ]]; then
  TESTSUITE="$1"
  [[ -d "$TESTSUITE" ]] || {
    printf 'testsuite directory does not exist: %s\n' "$TESTSUITE" >&2
    exit 1
  }
  EXPECTED_COMMIT=supplied
else
  testsuite_env="$ARTIFACT_DIR/testsuite.env"
  if [[ "$CORPUS_MODE" == upstream ]]; then
    .github/ci/prepare-testsuite.sh "$ARTIFACT_DIR/testsuite" --upstream | tee "$testsuite_env"
    EXPECTED_COMMIT=upstream-head
  else
    .github/ci/prepare-testsuite.sh "$ARTIFACT_DIR/testsuite" | tee "$testsuite_env"
    EXPECTED_COMMIT="$WASM_TESTSUITE_COMMIT"
  fi
  TESTSUITE="$(sed -n 's/^TESTSUITE_ROOT=//p' "$testsuite_env")"
fi

if [[ -n "${WEAVE_BIN+x}" ]]; then
  WEAVE_BIN="$(resolve_executable "$WEAVE_BIN" WEAVE_BIN)"
else
  cargo build --locked --release -p weave-cli
  ROOT_CARGO_TARGET="${CARGO_TARGET_DIR:-$ROOT/target}"
  WEAVE_BIN="$(resolve_executable "$ROOT_CARGO_TARGET/release/weave" WEAVE_BIN)"
fi
python3 .github/ci/spec-corpus-inputs.py snapshot "$TESTSUITE" "$ARTIFACT_DIR" \
  "$WASM_TOOLS_BIN" "$WEAVE_BIN" "$CORPUS_MODE" "$EXPECTED_COMMIT" "$MAX_WAST"

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
mapfile_compat < "$ARTIFACT_DIR/wast-files.txt"

successes=0
rejections=0
scripts=0
failures=0
report="$ARTIFACT_DIR/report.tsv"
printf 'wast\tmodule\tresult\tdetail\n' > "$report"

for wast in "${WAST_FILES[@]}"; do
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
  if ! python3 .github/ci/spec-corpus-inputs.py modules "$json" > "$modules_file" 2> "$case_dir/json.stderr"; then
    printf '%s\t-\tjson-read-failure\t%s\n' "$stem" "$(head -1 "$case_dir/json.stderr" | tr '\t' ' ')" >> "$report"
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

if ! python3 .github/ci/spec-corpus-inputs.py verify "$ARTIFACT_DIR/inputs.json" 2> "$ARTIFACT_DIR/inputs.stderr"; then
  printf '%s\t-\tinput-change\t%s\n' '-' "$(head -1 "$ARTIFACT_DIR/inputs.stderr" | tr '\t' ' ')" >> "$report"
  failures=$((failures + 1))
fi
{
  python3 .github/ci/spec-corpus-inputs.py summary "$ARTIFACT_DIR/inputs.json"
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
