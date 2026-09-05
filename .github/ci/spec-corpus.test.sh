#!/usr/bin/env bash
# Exercise corpus classification end to end without downloading or compiling.

set -euo pipefail

# The test installs three symlinks to itself as deterministic external tools.
# Their tiny protocol keeps the real harness, report, and exit checks in play.
if [[ "${WEAVE_CORPUS_TEST_TOOL:-0}" == 1 ]]; then
  case "$(basename "$0")" in
    cargo) exit 0 ;;
    wasm-tools)
      case "$1" in
        --version) printf '%s\n' 'wasm-tools corpus-test'; exit 0 ;;
        json-from-wast)
          cp "$2" commands.0.wasm
          printf '%s\n' '{"commands":[{"type":"module","filename":"commands.0.wasm"}]}' > commands.json
          exit 0
          ;;
        validate)
          if [[ "$(head -1 "$2")" == invalid-output ]]; then
            printf '%s\n' 'invalid generated module' >&2
            exit 1
          fi
          exit 0
          ;;
      esac
      exit 2
      ;;
    weave)
      [[ "$1" == transform && "$3" == -o ]] || exit 2
      case "$(head -1 "$2")" in
        valid|invalid-output) cp "$2" "$4"; exit 0 ;;
        error) sed -n '2,$p' "$2" >&2; exit 1 ;;
        signal) sed -n '2,$p' "$2" >&2; exit 139 ;;
        wrong-status) sed -n '2,$p' "$2" >&2; exit 2 ;;
      esac
      exit 2
      ;;
  esac
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/.github/ci/spec-corpus.test.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/weave-spec-corpus-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin"
for tool in cargo wasm-tools weave; do ln -s "$SCRIPT" "$TEST_ROOT/bin/$tool"; done

case_count=0
run_case() {
  local stem="$1" mode="$2" diagnostic="$3" expected_status="$4" expected_result="$5"
  local minimum="${6:-0}" status=0
  local case_root="$TEST_ROOT/case-$case_count"
  case_count=$((case_count + 1))
  mkdir -p "$case_root/corpus"
  printf '%s\n%s\n' "$mode" "$diagnostic" > "$case_root/corpus/$stem.wast"
  PATH="$TEST_ROOT/bin:$PATH" WEAVE_CORPUS_TEST_TOOL=1 \
  WEAVE_BIN="$TEST_ROOT/bin/weave" WASM_TOOLS_BIN="$TEST_ROOT/bin/wasm-tools" \
  WEAVE_CI_ARTIFACT_DIR="$case_root/artifacts" \
  WEAVE_CORPUS_MIN_SUCCESSES="$minimum" WEAVE_CORPUS_MAX_WAST_FILES=0 \
    "$ROOT/.github/ci/spec-corpus.sh" "$case_root/corpus" > "$case_root/run.log" 2>&1 || status=$?
  if [[ "$status" != "$expected_status" ]]; then
    printf 'corpus case %s/%s: expected status %s, got %s\n' "$stem" "$mode" "$expected_status" "$status" >&2
    cat "$case_root/run.log" >&2
    exit 1
  fi
  local actual_result
  actual_result="$(awk -F '\t' 'NR > 1 { print $3 }' "$case_root/artifacts/report.tsv")"
  if [[ "$actual_result" != "$expected_result" ]]; then
    printf 'corpus case %s/%s: expected %s, got %s\n' "$stem" "$mode" "$expected_result" "$actual_result" >&2
    cat "$case_root/artifacts/report.tsv" >&2
    exit 1
  fi
  if grep -Eq 'known.baseline|known.failure' "$case_root/artifacts/summary.txt"; then
    printf '%s\n' 'corpus summary retained an obsolete exception category' >&2
    exit 1
  fi
}

run_case valid valid '' 0 transformed 1
for diagnostic in \
  'weave: error: parsing input module: unsupported: table64' \
  'weave: error: parsing input module: unsupported (GC constant expression)' \
  'weave: error: unsupported: table with explicit init expression' \
  'weave: error: unsupported: imported funcref global' \
  'weave: error: emitting transformed module: unsupported: tag export'; do
  run_case unsupported error "$diagnostic" 0 rejected
done

# The six former exception keys must not excuse their old diagnostics anymore.
for stem in table_copy64 table_copy_mixed table_init64; do
  run_case "$stem" error 'weave: error: type mismatch: expected i32, found i64' 1 unexpected-transform-failure
done
for stem in throw try_table; do
  run_case "$stem" error 'weave: error: unknown tag 0: tag index out of bounds' 1 unexpected-transform-failure
done
run_case extern error 'weave: error: input module failed validation: constant expression required: non-constant operator: visit_extern_convert_any' 1 unexpected-transform-failure
run_case unexpected error 'weave: error: unexpected compiler failure' 1 unexpected-transform-failure
run_case invalid invalid-output '' 1 invalid-output
run_case panic error $'weave: error: parsing input module: unsupported: example\nthread main panicked at compiler.rs' 1 transform-crash
run_case signal signal 'weave: error: parsing input module: unsupported: example' 1 transform-crash
run_case wrong-status wrong-status 'weave: error: parsing input module: unsupported: example' 1 unexpected-transform-failure
run_case insufficient error 'weave: error: parsing input module: unsupported: example' 1 rejected 1

printf 'PASS spec corpus classification (%s cases; no failure exceptions)\n' "$case_count"
