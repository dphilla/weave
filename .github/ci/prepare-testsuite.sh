#!/usr/bin/env bash
# Acquire the immutable CI corpus, or explicitly refresh an upstream canary.
# Existing pinned checkouts are validated without contacting their origin.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
# shellcheck disable=SC1091
source "$ROOT/.github/ci/versions.env"

usage() {
  printf 'usage: .github/ci/prepare-testsuite.sh DESTINATION [--upstream]\n'
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  '') usage >&2; exit 2 ;;
esac
mode=pinned
case $# in
  1) ;;
  2) [[ "$2" == --upstream ]] || { usage >&2; exit 2; }; mode=upstream ;;
  *) usage >&2; exit 2 ;;
esac
[[ "${WASM_TESTSUITE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
  printf '%s\n' 'WASM_TESTSUITE_COMMIT must be a full lowercase 40-hex commit' >&2
  exit 1
}
[[ -n "${WASM_TESTSUITE_REPOSITORY:-}" ]] || {
  printf '%s\n' 'WASM_TESTSUITE_REPOSITORY is empty' >&2
  exit 1
}
for prerequisite in git python3; do
  command -v "$prerequisite" >/dev/null 2>&1 || {
    printf 'required tool is unavailable: %s\n' "$prerequisite" >&2
    exit 1
  }
done

# Resolve the standard /tmp alias, but never traverse a caller-controlled
# symlink below the temporary root, including a dangling destination symlink.
# Refuse parent traversal rather than interpreting link/.. combinations.
destination="$(python3 - "$ROOT" "${RUNNER_TEMP:-${TMPDIR:-/tmp}}" "$1" <<'PY'
import os
import sys

checkout, temporary, requested = sys.argv[1:]

def refuse(message):
    sys.exit('refusing testsuite destination: ' + message)

if not requested or any(c in requested + temporary for c in '\r\n'):
    refuse('paths must be nonempty and contain no line breaks')
if '..' in requested.split(os.sep):
    refuse('parent traversal is not allowed')
allowed = os.path.realpath(temporary)
if allowed == os.sep or not os.path.isdir(allowed):
    refuse('CI temporary root must be an existing non-root directory')
logical = os.path.abspath(requested)
resolved = os.path.realpath(logical)
if not resolved.startswith(allowed + os.sep):
    refuse('path must be below CI temporary root ' + allowed)
if resolved == checkout or resolved.startswith(checkout + os.sep):
    refuse('path must be outside the project checkout')
cursor = logical
while cursor != os.path.dirname(cursor):
    if os.path.islink(cursor):
        target = os.path.realpath(cursor)
        if target != allowed and not allowed.startswith(target + os.sep):
            refuse('symlink destination or parent: ' + cursor)
    cursor = os.path.dirname(cursor)
print(resolved)
PY
)"

# Repository-pointer variables must not redirect -C away from the validated
# destination. Keep ordinary network/credential configuration available.
for variable in GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE \
  GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES; do
  unset "$variable"
done
export GIT_OPTIONAL_LOCKS=0

corpus_git() {
  git -c core.hooksPath=/dev/null -c core.fsmonitor=false \
    -c submodule.recurse=false -C "$destination" "$@"
}

verify_checkout() {
  [[ -d "$destination/.git" && ! -L "$destination/.git" \
    && ! -e "$destination/.git/commondir" ]] || {
    printf 'destination must have its own ordinary .git directory: %s\n' "$destination" >&2
    exit 1
  }
  local top_level
  top_level="$(corpus_git rev-parse --show-toplevel)"
  [[ "$top_level" == "$destination" ]] || {
    printf 'testsuite Git worktree is redirected outside its destination: %s\n' "$top_level" >&2
    exit 1
  }
  local origin
  origin="$(corpus_git remote get-url origin 2>/dev/null || true)"
  [[ "$origin" == "$WASM_TESTSUITE_REPOSITORY" ]] || {
    printf 'testsuite origin mismatch: got %s, expected %s\n' \
      "$origin" "$WASM_TESTSUITE_REPOSITORY" >&2
    exit 1
  }
  local changes
  changes="$(corpus_git status --porcelain --untracked-files=all --ignore-submodules=none)"
  [[ -z "$changes" ]] || {
    printf 'refusing a dirty testsuite checkout: %s\n' "$destination" >&2
    exit 1
  }
}

created=0
on_exit() {
  local status=$?
  trap - EXIT
  if ((status != 0 && created == 1)); then
    printf 'retained incomplete testsuite checkout for inspection: %s\n' "$destination" >&2
  fi
  exit "$status"
}
trap on_exit EXIT

if [[ -e "$destination" || -L "$destination" ]]; then
  verify_checkout
else
  mkdir -p -- "$(dirname "$destination")"
  # Atomic ownership claim: never initialize inside a pre-existing directory.
  mkdir -- "$destination"
  created=1
  corpus_git init --quiet
  corpus_git remote add origin "$WASM_TESTSUITE_REPOSITORY"
  # Check Git's worktree boundary before fetching/checking out a new tree too.
  verify_checkout
fi

expected="$WASM_TESTSUITE_COMMIT"
if [[ "$mode" == upstream ]]; then
  # FETCH_HEAD identifies this fetch, avoiding an ls-remote/checkout race.
  corpus_git fetch --quiet --depth 1 origin HEAD >&2
  selected="$(corpus_git rev-parse --verify 'FETCH_HEAD^{commit}')"
  expected=upstream-head
elif ((created == 1)); then
  corpus_git fetch --quiet --depth 1 origin "$WASM_TESTSUITE_COMMIT" >&2
  selected="$WASM_TESTSUITE_COMMIT"
else
  selected="$(corpus_git rev-parse --verify 'HEAD^{commit}')"
  [[ "$selected" == "$WASM_TESTSUITE_COMMIT" ]] || {
    printf 'testsuite commit mismatch: got %s, expected %s; use a fresh destination\n' \
      "$selected" "$WASM_TESTSUITE_COMMIT" >&2
    exit 1
  }
fi
[[ "$selected" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'testsuite did not resolve to a full commit: %s\n' "$selected" >&2
  exit 1
}
if ((created == 1)) || [[ "$mode" == upstream ]]; then
  corpus_git checkout --quiet --detach "$selected" >&2
fi
verify_checkout
actual="$(corpus_git rev-parse --verify 'HEAD^{commit}')"
[[ "$actual" == "$selected" ]] || {
  printf 'testsuite checkout verification failed: got %s, expected %s\n' "$actual" "$selected" >&2
  exit 1
}

printf 'TESTSUITE_ROOT=%s\n' "$destination"
printf 'TESTSUITE_MODE=%s\n' "$mode"
printf 'TESTSUITE_COMMIT=%s\n' "$actual"
printf 'TESTSUITE_EXPECTED_COMMIT=%s\n' "$expected"
