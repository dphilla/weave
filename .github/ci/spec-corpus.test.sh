#!/usr/bin/env bash
# Exercise corpus classification end to end without downloading or compiling.

set -euo pipefail

# The test installs symlinks to itself as deterministic external tools.
# Their tiny protocol keeps the real harness, report, and exit checks in play.
if [[ "${WEAVE_CORPUS_TEST_TOOL:-0}" == 1 ]]; then
  case "$(basename "$0")" in
    cargo)
      printf '%s\n' cargo >> "$WEAVE_CORPUS_TEST_EVENTS"
      if [[ "${WEAVE_CORPUS_TEST_FORBID_CARGO:-0}" == 1 ]]; then
        printf '%s\n' 'test forbids Cargo when WEAVE_BIN is supplied' >&2
        exit 97
      fi
      exit 0
      ;;
    curl)
      printf '%s\n' download >> "$WEAVE_CORPUS_TEST_EVENTS"
      printf '%s\n' 'test forbids downloading a replacement for an explicit tool' >&2
      exit 96
      ;;
    wasm-tools)
      case "$1" in
        --version) printf '%s\n' 'wasm-tools corpus-test'; exit 0 ;;
        json-from-wast)
          printf '%s\n' extract >> "$WEAVE_CORPUS_TEST_EVENTS"
          case "$(head -1 "$2")" in
            extract-error|';; extract-error with valid modules surrounding a negative assertion')
              # A failed extractor may have left partial output. It must never
              # count as a successfully extracted or transformed script.
              printf '%s\n' valid > commands.0.wasm
              printf '%s\n' '{"commands":[{"type":"module","filename":"commands.0.wasm"}]}' > commands.json
              printf '%s\n' 'error: expected `(` in negative assertion' >&2
              exit 1
              ;;
            malformed-json) printf '%s\n' '{' > commands.json; exit 0 ;;
            missing-json) exit 0 ;;
            json-array) printf '%s\n' '[]' > commands.json; exit 0 ;;
            missing-commands) printf '%s\n' '{}' > commands.json; exit 0 ;;
            wrong-commands) printf '%s\n' '{"commands":{}}' > commands.json; exit 0 ;;
            malformed-command) printf '%s\n' '{"commands":[null]}' > commands.json; exit 0 ;;
            missing-command-type) printf '%s\n' '{"commands":[{}]}' > commands.json; exit 0 ;;
            wrong-command-type) printf '%s\n' '{"commands":[{"type":1}]}' > commands.json; exit 0 ;;
            missing-filename) printf '%s\n' '{"commands":[{"type":"module"}]}' > commands.json; exit 0 ;;
            wrong-filename) printf '%s\n' '{"commands":[{"type":"module","filename":1}]}' > commands.json; exit 0 ;;
            empty-filename) printf '%s\n' '{"commands":[{"type":"module","filename":""}]}' > commands.json; exit 0 ;;
            traversal) printf '%s\n' '{"commands":[{"type":"module","filename":"../escape.wasm"}]}' > commands.json; exit 0 ;;
            absolute-path) printf '%s\n' '{"commands":[{"type":"module","filename":"/escape.wasm"}]}' > commands.json; exit 0 ;;
            backslash-path) printf '%s\n' '{"commands":[{"type":"module","filename":"..\\escape.wasm"}]}' > commands.json; exit 0 ;;
            newline-path) printf '%s\n' '{"commands":[{"type":"module","filename":"escape\n.wasm"}]}' > commands.json; exit 0 ;;
            wrong-extension) printf '%s\n' '{"commands":[{"type":"module","filename":"commands.txt"}]}' > commands.json; exit 0 ;;
            duplicate-module)
              printf '%s\n' valid > commands.0.wasm
              printf '%s\n' '{"commands":[{"type":"module","filename":"commands.0.wasm"},{"type":"module","filename":"commands.0.wasm"}]}' > commands.json
              exit 0
              ;;
            missing-extraction)
              printf '%s\n' '{"commands":[{"type":"module","filename":"commands.0.wasm"}]}' > commands.json
              exit 0
              ;;
            symlink-extraction)
              ln -s "$2" commands.0.wasm
              printf '%s\n' '{"commands":[{"type":"module","filename":"commands.0.wasm"}]}' > commands.json
              exit 0
              ;;
            quoted-wat)
              printf '%s\n' '(module (func (export "run")))' > commands.0.wat
              printf '%s\n' '{"commands":[{"type":"module","filename":"commands.0.wat","module_type":"text"}]}' > commands.json
              exit 0
              ;;
            source-mutation|tool-mutation)
              printf '%s\n' valid > commands.0.wasm
              printf '%s\n' '{"commands":[{"type":"module","filename":"commands.0.wasm"}]}' > commands.json
              if [[ "$(head -1 "$2")" == source-mutation ]]; then
                printf '%s\n' ';; source changed during extraction' >> "$2"
              else
                # This path is a regular, disposable copy, never the shared
                # symlink back to this committed test script.
                [[ -f "$WEAVE_CORPUS_TEST_MUTATE_TOOL" && ! -L "$WEAVE_CORPUS_TEST_MUTATE_TOOL" ]] || exit 93
                printf '\n%s\n' '# tool changed during extraction' >> "$WEAVE_CORPUS_TEST_MUTATE_TOOL"
              fi
              exit 0
              ;;
          esac
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
      printf '%s\n' transform >> "$WEAVE_CORPUS_TEST_EVENTS"
      [[ "$1" == transform && "$3" == -o ]] || exit 2
      case "$(head -1 "$2")" in
        valid|invalid-output) cp "$2" "$4"; exit 0 ;;
        '(module (func (export "run")))')
          [[ "$2" == *.wat ]] || exit 2
          printf '%s\n' valid > "$4"
          exit 0
          ;;
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
REAL_GIT="$(command -v git)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/weave-spec-corpus-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT
TOOLS="$TEST_ROOT/tool aliases"
mkdir -p "$TOOLS"
for tool in cargo curl wasm-tools weave; do ln -s "$SCRIPT" "$TOOLS/$tool"; done

fixture_git() (
  # Never let an inherited Git repository/index pointer redirect fixture writes.
  while IFS= read -r name; do unset "$name"; done < <(compgen -v GIT_)
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0 \
    "$REAL_GIT" "$@"
)

assert_provenance() {
  python3 - "$1" "$TOOLS" <<'PY'
import hashlib
import json
import pathlib
import sys

case_root, tools = map(pathlib.Path, sys.argv[1:])
artifact = case_root / "artifacts"
document = json.loads((artifact / "inputs.json").read_text())
assert document["schema_version"] == 1
assert document["testsuite"] == {
    "path": str((case_root / "corpus").resolve()),
    "mode": "supplied",
    "expected_commit": "supplied",
    "commit": "supplied-unversioned",
    "git_state": "unversioned",
}, document["testsuite"]
for name, executable in (("wasm_tools", "wasm-tools"), ("weave", "weave")):
    expected = tools / executable
    assert document[name]["path"] == str(expected.absolute()), document[name]
    assert document[name]["sha256"] == hashlib.sha256(expected.read_bytes()).hexdigest()
assert document["wasm_tools"]["version"] == "wasm-tools corpus-test"
files = sorted((case_root / "corpus").glob("*.wast"))
assert document["wast_files"] == [
    {"path": file.name, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
    for file in files
]
summary = dict(line.split("=", 1) for line in (artifact / "summary.txt").read_text().splitlines())
for key, expected in (("testsuite_mode", "supplied"),
                      ("testsuite_expected_commit", "supplied"),
                      ("testsuite_commit", "supplied-unversioned"),
                      ("wasm_tools", "wasm-tools corpus-test")):
    assert summary[key] == expected, (key, summary[key])
for key in ("wast_scripts", "transformed", "expected_rejections", "hard_failures"):
    assert int(summary[key]) >= 0
PY
}

case_count=0
run_case() {
  local stem="$1" mode="$2" diagnostic="$3" expected_status="$4" expected_result="$5"
  local minimum="${6:-0}" setup="${7:-}" status=0
  local case_root="$TEST_ROOT/case-$case_count"
  LAST_CASE_ROOT="$case_root"
  case_count=$((case_count + 1))
  mkdir -p "$case_root/corpus"
  printf '%s\n%s\n' "$mode" "$diagnostic" > "$case_root/corpus/$stem.wast"
  if [[ "$setup" == nested-git ]]; then
    fixture_git -C "$case_root" init --quiet --template=
    fixture_git -C "$case_root" -c user.name=Fixture -c user.email=fixture@example.invalid \
      -c commit.gpgsign=false -c core.hooksPath=/dev/null \
      commit --quiet --allow-empty -m 'enclosing repository is not corpus provenance'
  fi
  PATH="$TOOLS:$PATH" WEAVE_CORPUS_TEST_TOOL=1 WEAVE_CORPUS_TEST_FORBID_CARGO=1 \
  WEAVE_CORPUS_TEST_EVENTS="$case_root/events.log" \
  WEAVE_BIN="$TOOLS/weave" WASM_TOOLS_BIN="$TOOLS/wasm-tools" \
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
  if grep -Eq '^(cargo|download)$' "$case_root/events.log"; then
    printf 'corpus case %s unexpectedly built or downloaded an explicit tool\n' "$stem" >&2
    exit 1
  fi
  case "$expected_result" in
    extract-failure|json-read-failure|missing-extraction)
      if grep -qx transform "$case_root/events.log"; then
        printf 'corpus case %s transformed untrusted/partial extraction output\n' "$stem" >&2
        exit 1
      fi
      ;;
  esac
  assert_provenance "$case_root"
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

run_case extraction extract-error '' 1 extract-failure
run_case negative-extraction ';; extract-error with valid modules surrounding a negative assertion' \
  $'(module (func (export "before")))\n(assert_invalid\n  (module (type $a (sub (struct))) (type $b (sub (struct)))\n    (type $c (sub $a $b (struct))))\n  "multiple supertypes")\n(module (func (export "after")))' \
  1 extract-failure
for mode in malformed-json missing-json json-array missing-commands wrong-commands \
  malformed-command missing-command-type wrong-command-type missing-filename \
  wrong-filename empty-filename traversal absolute-path backslash-path newline-path \
  wrong-extension duplicate-module symlink-extraction; do
  run_case "$mode" "$mode" '' 1 json-read-failure
done
run_case missing-extraction missing-extraction '' 1 missing-extraction
run_case quoted-text quoted-wat '' 0 transformed 1
run_case 'module with spaces' valid '' 0 transformed 1
run_case nested-corpus valid '' 0 transformed 1 nested-git

run_invalid_tool() {
  local variable="$1" kind="$2" status=0
  local case_root="$TEST_ROOT/case-$case_count"
  local wasm="$TOOLS/wasm-tools" weave="$TOOLS/weave" invalid
  case_count=$((case_count + 1))
  mkdir -p "$case_root/corpus"
  printf '%s\n' valid > "$case_root/corpus/valid.wast"
  : > "$case_root/events.log"
  invalid="$case_root/explicit tool"
  case "$kind" in
    missing) ;;
    nonexecutable) printf '%s\n' 'not executable' > "$invalid"; chmod 600 "$invalid" ;;
    directory) mkdir "$invalid" ;;
    empty) invalid='' ;;
  esac
  if [[ "$variable" == WASM_TOOLS_BIN ]]; then wasm="$invalid"; else weave="$invalid"; fi
  PATH="$TOOLS:$PATH" WEAVE_CORPUS_TEST_TOOL=1 WEAVE_CORPUS_TEST_FORBID_CARGO=1 \
  WEAVE_CORPUS_TEST_EVENTS="$case_root/events.log" \
  WEAVE_BIN="$weave" WASM_TOOLS_BIN="$wasm" \
  WEAVE_CI_ARTIFACT_DIR="$case_root/artifacts" \
  WEAVE_CORPUS_MIN_SUCCESSES=1 WEAVE_CORPUS_MAX_WAST_FILES=0 \
    "$ROOT/.github/ci/spec-corpus.sh" "$case_root/corpus" > "$case_root/run.log" 2>&1 || status=$?
  if [[ "$status" == 0 ]]; then
    printf 'corpus accepted %s=%s (%s)\n' "$variable" "$invalid" "$kind" >&2
    exit 1
  fi
  if [[ -s "$case_root/events.log" ]]; then
    printf 'corpus processed, built, or downloaded despite invalid explicit %s (%s)\n' "$variable" "$kind" >&2
    cat "$case_root/events.log" >&2
    cat "$case_root/run.log" >&2
    exit 1
  fi
  if ! grep -q "$variable" "$case_root/run.log"; then
    printf 'corpus invalid %s (%s) lacked a useful tool-selection diagnostic\n' "$variable" "$kind" >&2
    cat "$case_root/run.log" >&2
    exit 1
  fi
}
for variable in WASM_TOOLS_BIN WEAVE_BIN; do
  for kind in missing nonexecutable directory empty; do run_invalid_tool "$variable" "$kind"; done
done

# A previous .wasm must not conceal an extractor that no longer creates it.
# Reusing the same artifacts must fail before touching the previous evidence.
run_case stale-output valid '' 0 transformed 1
reuse_root="$LAST_CASE_ROOT"
cp "$reuse_root/artifacts/report.tsv" "$reuse_root/saved-report.tsv"
cp "$reuse_root/artifacts/inputs.json" "$reuse_root/saved-inputs.json"
printf '%s\n' missing-extraction > "$reuse_root/corpus/stale-output.wast"
: > "$reuse_root/events.log"
status=0
PATH="$TOOLS:$PATH" WEAVE_CORPUS_TEST_TOOL=1 WEAVE_CORPUS_TEST_FORBID_CARGO=1 \
WEAVE_CORPUS_TEST_EVENTS="$reuse_root/events.log" \
WEAVE_BIN="$TOOLS/weave" WASM_TOOLS_BIN="$TOOLS/wasm-tools" \
WEAVE_CI_ARTIFACT_DIR="$reuse_root/artifacts" \
WEAVE_CORPUS_MIN_SUCCESSES=1 WEAVE_CORPUS_MAX_WAST_FILES=0 \
  "$ROOT/.github/ci/spec-corpus.sh" "$reuse_root/corpus" > "$reuse_root/reuse.log" 2>&1 || status=$?
case_count=$((case_count + 1))
if [[ "$status" == 0 || -s "$reuse_root/events.log" ]]; then
  printf '%s\n' 'corpus reused prior extraction artifacts instead of refusing them' >&2
  cat "$reuse_root/reuse.log" >&2
  exit 1
fi
if ! cmp -s "$reuse_root/saved-report.tsv" "$reuse_root/artifacts/report.tsv" \
  || ! cmp -s "$reuse_root/saved-inputs.json" "$reuse_root/artifacts/inputs.json"; then
  printf '%s\n' 'refused artifact reuse overwrote prior evidence' >&2
  exit 1
fi
if ! grep -Eiq 'existing|reuse|fresh|already|overwrite|stale' "$reuse_root/reuse.log"; then
  printf '%s\n' 'artifact reuse lacked a useful refusal diagnostic' >&2
  cat "$reuse_root/reuse.log" >&2
  exit 1
fi

run_mutation() {
  local mode="$1" status=0
  local case_root="$TEST_ROOT/case-$case_count"
  case_count=$((case_count + 1))
  mkdir -p "$case_root/corpus" "$case_root/tool copy"
  printf '%s\n' "$mode" > "$case_root/corpus/mutation.wast"
  cp "$case_root/corpus/mutation.wast" "$case_root/original.wast"
  cp "$SCRIPT" "$case_root/tool copy/weave"
  chmod +x "$case_root/tool copy/weave"
  cp "$case_root/tool copy/weave" "$case_root/original-tool"
  PATH="$TOOLS:$PATH" WEAVE_CORPUS_TEST_TOOL=1 WEAVE_CORPUS_TEST_FORBID_CARGO=1 \
  WEAVE_CORPUS_TEST_EVENTS="$case_root/events.log" \
  WEAVE_CORPUS_TEST_MUTATE_TOOL="$case_root/tool copy/weave" \
  WEAVE_BIN="$case_root/tool copy/weave" WASM_TOOLS_BIN="$TOOLS/wasm-tools" \
  WEAVE_CI_ARTIFACT_DIR="$case_root/artifacts" \
  WEAVE_CORPUS_MIN_SUCCESSES=1 WEAVE_CORPUS_MAX_WAST_FILES=0 \
    "$ROOT/.github/ci/spec-corpus.sh" "$case_root/corpus" > "$case_root/run.log" 2>&1 || status=$?
  if [[ "$status" != 1 ]]; then
    printf 'corpus mutation %s: expected hard failure, got %s\n' "$mode" "$status" >&2
    cat "$case_root/run.log" >&2
    exit 1
  fi
  python3 - "$case_root" "$mode" <<'PY'
import hashlib
import json
import pathlib
import sys

root, mode = pathlib.Path(sys.argv[1]), sys.argv[2]
document = json.loads((root / "artifacts/inputs.json").read_text())
rows = [line.split("\t") for line in (root / "artifacts/report.tsv").read_text().splitlines()[1:]]
assert [row[2] for row in rows] == ["transformed", "input-change"], rows
summary = dict(line.split("=", 1) for line in (root / "artifacts/summary.txt").read_text().splitlines())
assert summary["transformed"] == "1" and summary["hard_failures"] == "1", summary
assert document["wast_files"][0]["sha256"] == hashlib.sha256((root / "original.wast").read_bytes()).hexdigest()
assert document["weave"]["sha256"] == hashlib.sha256((root / "original-tool").read_bytes()).hexdigest()
if mode == "source-mutation":
    assert (root / "corpus/mutation.wast").read_bytes() != (root / "original.wast").read_bytes()
else:
    assert (root / "tool copy/weave").read_bytes() != (root / "original-tool").read_bytes()
assert (root / "events.log").read_text().splitlines() == ["extract", "transform"]
PY
}
run_mutation source-mutation
run_mutation tool-mutation

run_early_rejection() {
  local minimum="$1" maximum="$2" empty="$3" expected_status="$4" status=0
  local case_root="$TEST_ROOT/case-$case_count"
  case_count=$((case_count + 1))
  mkdir -p "$case_root/corpus"
  : > "$case_root/events.log"
  if [[ "$empty" != yes ]]; then printf '%s\n' valid > "$case_root/corpus/valid.wast"; fi
  PATH="$TOOLS:$PATH" WEAVE_CORPUS_TEST_TOOL=1 WEAVE_CORPUS_TEST_FORBID_CARGO=1 \
  WEAVE_CORPUS_TEST_EVENTS="$case_root/events.log" \
  WEAVE_BIN="$TOOLS/weave" WASM_TOOLS_BIN="$TOOLS/wasm-tools" \
  WEAVE_CI_ARTIFACT_DIR="$case_root/artifacts" \
  WEAVE_CORPUS_MIN_SUCCESSES="$minimum" WEAVE_CORPUS_MAX_WAST_FILES="$maximum" \
    "$ROOT/.github/ci/spec-corpus.sh" "$case_root/corpus" > "$case_root/run.log" 2>&1 || status=$?
  if [[ "$status" != "$expected_status" || -s "$case_root/events.log" ]]; then
    printf 'invalid limits/empty corpus case expected early status %s, got %s\n' "$expected_status" "$status" >&2
    cat "$case_root/run.log" >&2
    exit 1
  fi
  if [[ "$empty" == yes ]]; then
    grep -q 'no top-level .wast files' "$case_root/run.log" || {
      printf '%s\n' 'empty corpus lacked a useful diagnostic' >&2
      exit 1
    }
  else
    grep -q 'corpus limits' "$case_root/run.log" || {
      printf '%s\n' 'invalid corpus limit lacked a useful diagnostic' >&2
      exit 1
    }
  fi
}
run_early_rejection 0 0 yes 1
for invalid in -1 abc 01 1.5 1000000000 '1+1' ' 1'; do
  run_early_rejection "$invalid" 0 no 2
  run_early_rejection 0 "$invalid" no 2
done

printf 'PASS spec corpus classification (%s cases; no failure exceptions)\n' "$case_count"
