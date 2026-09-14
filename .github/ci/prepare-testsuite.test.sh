#!/usr/bin/env bash
# Offline acquisition tests: actual Git repositories, commits, and fetches.
# The helper runs from a copied checkout with local-only versions.env values.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/weave-testsuite-test.XXXXXX")"
TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"
on_exit() {
  local status=$?
  trap - EXIT
  if ((status == 0)) && [[ "${WEAVE_CI_KEEP_TEMP:-0}" != 1 ]]; then
    rm -rf -- "$TEST_ROOT"
  else
    printf 'retained testsuite test artifacts: %s\n' "$TEST_ROOT" >&2
  fi
  exit "$status"
}
trap on_exit EXIT

# Ignore caller Git repository/configuration and signing hooks. No command in
# this test needs an external network or a pre-existing repository/cache.
for variable in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$variable"; done
export GIT_CONFIG_NOSYSTEM=1 GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_GLOBAL="$TEST_ROOT/empty git config"
: > "$GIT_CONFIG_GLOBAL"
export GIT_AUTHOR_NAME='Weave corpus fixture' GIT_COMMITTER_NAME='Weave corpus fixture'
export GIT_AUTHOR_EMAIL=weave@example.invalid GIT_COMMITTER_EMAIL=weave@example.invalid
export RUNNER_TEMP="$TEST_ROOT/temporary root"
mkdir -p "$TEST_ROOT/project checkout/.github/ci" "$RUNNER_TEMP"
cp "$ROOT/.github/ci/prepare-testsuite.sh" "$TEST_ROOT/project checkout/.github/ci/"
HELPER="$TEST_ROOT/project checkout/.github/ci/prepare-testsuite.sh"
ORIGIN="$TEST_ROOT/local origin"
git init --quiet --template= "$ORIGIN"
git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
printf '%s\n' 'pinned corpus bytes' > "$ORIGIN/corpus.txt"
git -C "$ORIGIN" add corpus.txt
git -C "$ORIGIN" commit --quiet -m pinned
PIN="$(git -C "$ORIGIN" rev-parse HEAD)"
printf '%s\n' 'new upstream corpus bytes' > "$ORIGIN/corpus.txt"
git -C "$ORIGIN" commit --quiet -am upstream
UPSTREAM="$(git -C "$ORIGIN" rev-parse HEAD)"

write_pin() {
  printf 'WASM_TESTSUITE_REPOSITORY=%q\nWASM_TESTSUITE_COMMIT=%q\n' \
    "$ORIGIN" "$1" > "$TEST_ROOT/project checkout/.github/ci/versions.env"
}
write_pin "$PIN"
case_count=0

run_case() {
  local label="$1" expected="$2" diagnostic="$3" status=0
  shift 3
  case_count=$((case_count + 1))
  OUTPUT="$TEST_ROOT/$case_count.stdout"
  ERRORS="$TEST_ROOT/$case_count.stderr"
  "$BASH" "$HELPER" "$@" > "$OUTPUT" 2> "$ERRORS" || status=$?
  if [[ "$expected" == pass ]]; then
    if ((status != 0)); then
      printf 'FAIL %s: expected success, exit %s\n' "$label" "$status" >&2
      cat "$ERRORS" >&2
      exit 1
    fi
    [[ "$(wc -l < "$OUTPUT" | tr -d '[:space:]')" == 4 ]] || {
      printf 'FAIL %s: stdout is not exactly four provenance fields\n' "$label" >&2
      cat "$OUTPUT" >&2
      exit 1
    }
  else
    if ((status == 0)) || ! grep -Fq -- "$diagnostic" "$ERRORS" || [[ -s "$OUTPUT" ]]; then
      printf 'FAIL %s: expected rejection containing %s, exit %s\n' "$label" "$diagnostic" "$status" >&2
      cat "$OUTPUT" "$ERRORS" >&2
      exit 1
    fi
  fi
  printf 'ok %s - %s\n' "$case_count" "$label"
}

field() {
  grep -Fxq -- "$1=$2" "$OUTPUT" || {
    printf 'FAIL missing provenance %s=%s\n' "$1" "$2" >&2
    cat "$OUTPUT" >&2
    exit 1
  }
}

clone_at() {
  git clone --quiet --no-hardlinks "$ORIGIN" "$1"
  git -C "$1" checkout --quiet --detach "$2"
}

pinned="$RUNNER_TEMP/pinned checkout"
run_case 'new checkout uses pin, not newer upstream HEAD' pass '' "$pinned"
field TESTSUITE_ROOT "$pinned"
field TESTSUITE_MODE pinned
field TESTSUITE_COMMIT "$PIN"
field TESTSUITE_EXPECTED_COMMIT "$PIN"
[[ "$(git -C "$pinned" rev-parse HEAD)" == "$PIN" ]]
[[ "$(cat "$pinned/corpus.txt")" == 'pinned corpus bytes' ]]
if git -C "$pinned" symbolic-ref -q HEAD >/dev/null; then
  printf '%s\n' 'FAIL acquired checkout is not detached' >&2
  exit 1
fi

# A fetch would now fail. Successful reuse proves the pinned path is offline.
mv "$ORIGIN" "$TEST_ROOT/unavailable origin"
run_case 'correct pinned checkout is reused with origin unavailable' pass '' "$pinned"
field TESTSUITE_COMMIT "$PIN"
mv "$TEST_ROOT/unavailable origin" "$ORIGIN"

upstream="$RUNNER_TEMP/upstream checkout"
run_case 'explicit upstream fetch uses actual remote HEAD' pass '' "$upstream" --upstream
field TESTSUITE_MODE upstream
field TESTSUITE_COMMIT "$UPSTREAM"
field TESTSUITE_EXPECTED_COMMIT upstream-head
printf '%s\n' 'third upstream corpus bytes' > "$ORIGIN/corpus.txt"
git -C "$ORIGIN" commit --quiet -am third
THIRD="$(git -C "$ORIGIN" rev-parse HEAD)"
run_case 'upstream reuse actually refreshes after remote advances' pass '' "$upstream" --upstream
field TESTSUITE_COMMIT "$THIRD"
[[ "$(cat "$upstream/corpus.txt")" == 'third upstream corpus bytes' ]]
run_case 'pinned mode refuses a previously upstream checkout' fail 'commit mismatch' "$upstream"
[[ "$(git -C "$upstream" rev-parse HEAD)" == "$THIRD" ]]

dirty="$RUNNER_TEMP/dirty tracked"
clone_at "$dirty" "$PIN"
printf '%s\n' 'caller changes must survive' >> "$dirty/corpus.txt"
run_case 'dirty tracked input is refused without reset' fail 'dirty testsuite checkout' "$dirty"
grep -Fq 'caller changes must survive' "$dirty/corpus.txt"
run_case 'upstream also refuses dirty tracked input' fail 'dirty testsuite checkout' "$dirty" --upstream
[[ "$(git -C "$dirty" rev-parse HEAD)" == "$PIN" ]]

untracked="$RUNNER_TEMP/dirty untracked"
clone_at "$untracked" "$PIN"
mkdir -p "$untracked/nested directory"
printf '%s\n' 'caller data' > "$untracked/nested directory/untracked.txt"
run_case 'nested untracked input is refused' fail 'dirty testsuite checkout' "$untracked"
[[ "$(cat "$untracked/nested directory/untracked.txt")" == 'caller data' ]]

wrong_origin="$RUNNER_TEMP/wrong origin"
clone_at "$wrong_origin" "$PIN"
git -C "$wrong_origin" remote set-url origin "$TEST_ROOT/a different origin"
run_case 'wrong origin is refused before fetching' fail 'origin mismatch' "$wrong_origin"
run_case 'upstream also refuses wrong origin' fail 'origin mismatch' "$wrong_origin" --upstream
[[ "$(git -C "$wrong_origin" rev-parse HEAD)" == "$PIN" ]]

mkdir "$RUNNER_TEMP/existing directory"
printf '%s\n' 'caller file' > "$RUNNER_TEMP/existing file"
run_case 'pre-existing empty directory is not adopted' fail 'ordinary .git directory' "$RUNNER_TEMP/existing directory"
run_case 'pre-existing file is not replaced' fail 'ordinary .git directory' "$RUNNER_TEMP/existing file"
[[ "$(cat "$RUNNER_TEMP/existing file")" == 'caller file' ]]

ln -s "$RUNNER_TEMP/absent target" "$RUNNER_TEMP/dangling destination"
run_case 'dangling destination symlink is refused' fail 'symlink destination or parent' "$RUNNER_TEMP/dangling destination"
[[ -L "$RUNNER_TEMP/dangling destination" && ! -e "$RUNNER_TEMP/absent target" ]]
ln -s "$pinned" "$RUNNER_TEMP/linked destination"
run_case 'existing destination symlink is refused' fail 'symlink destination or parent' "$RUNNER_TEMP/linked destination"
mkdir "$RUNNER_TEMP/real parent"
ln -s "$RUNNER_TEMP/real parent" "$RUNNER_TEMP/linked parent"
run_case 'symlink parent is refused even inside temporary root' fail 'symlink destination or parent' "$RUNNER_TEMP/linked parent/checkout"
[[ ! -e "$RUNNER_TEMP/real parent/checkout" ]]

git_link="$RUNNER_TEMP/linked git directory"
clone_at "$git_link" "$PIN"
mv "$git_link/.git" "$RUNNER_TEMP/shared git metadata"
ln -s "$RUNNER_TEMP/shared git metadata" "$git_link/.git"
run_case '.git symlink is refused' fail 'ordinary .git directory' "$git_link"
worktree="$RUNNER_TEMP/linked Git worktree"
git -C "$ORIGIN" worktree add --quiet --detach "$worktree" "$PIN"
run_case 'linked-worktree .git pointer is refused' fail 'ordinary .git directory' "$worktree"

redirected="$RUNNER_TEMP/redirected worktree"
clone_at "$redirected" "$PIN"
git -C "$redirected" config core.worktree "$ORIGIN"
run_case 'existing core.worktree redirection is refused' fail 'worktree is redirected' "$redirected"
[[ "$(git -C "$ORIGIN" rev-parse HEAD)" == "$THIRD" ]]

run_case 'temporary root itself is refused' fail 'below CI temporary root' "$RUNNER_TEMP"
run_case 'outside temporary root is refused' fail 'below CI temporary root' "$TEST_ROOT/outside checkout"
run_case 'parent traversal is refused' fail 'parent traversal is not allowed' "$RUNNER_TEMP/../outside checkout"
RUNNER_TEMP=/ run_case 'filesystem root cannot be temporary root' fail 'existing non-root directory' "$RUNNER_TEMP/new checkout"
RUNNER_TEMP="$TEST_ROOT" run_case 'checkout descendants are refused even under allowed temporary root' fail 'outside the project checkout' "$TEST_ROOT/project checkout/forbidden"
[[ ! -e "$TEST_ROOT/project checkout/forbidden" ]]

# Relative paths are resolved from the caller, not from the copied project.
previous_directory="$PWD"
cd "$RUNNER_TEMP"
run_case 'relative destination and paths containing spaces work' pass '' 'relative corpus'
field TESTSUITE_ROOT "$RUNNER_TEMP/relative corpus"
cd "$previous_directory"
run_case 'line breaks cannot spoof provenance fields' fail 'no line breaks' "$RUNNER_TEMP/line
break"

write_pin short
run_case 'short pin is rejected before acquisition' fail 'full lowercase 40-hex commit' "$RUNNER_TEMP/invalid short pin"
[[ ! -e "$RUNNER_TEMP/invalid short pin" ]]
write_pin 0000000000000000000000000000000000000000
run_case 'missing pinned commit fails and retains only its claimed checkout' fail 'retained incomplete testsuite checkout' "$RUNNER_TEMP/missing commit"
[[ -d "$RUNNER_TEMP/missing commit/.git" && ! -e "$RUNNER_TEMP/missing commit/corpus.txt" ]]
write_pin "$PIN"

# Inherited repository pointers must not turn -C into writes to another repo.
GIT_DIR="$ORIGIN/.git" GIT_WORK_TREE="$ORIGIN" GIT_INDEX_FILE="$ORIGIN/foreign-index" \
  run_case 'inherited Git repository pointers cannot redirect acquisition' pass '' "$RUNNER_TEMP/isolated checkout"
field TESTSUITE_COMMIT "$PIN"
[[ "$(git -C "$ORIGIN" rev-parse HEAD)" == "$THIRD" && ! -e "$ORIGIN/foreign-index" ]]

run_case 'unknown option is rejected' fail 'usage:' "$RUNNER_TEMP/unknown option" --bad
run_case 'missing destination is rejected' fail 'usage:'
run_case 'extra positional argument is rejected' fail 'usage:' "$RUNNER_TEMP/extra args" --upstream extra
printf 'prepare-testsuite tests passed: %s cases\n' "$case_count"
