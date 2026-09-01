#!/usr/bin/env bash
# Remove only Weave's known disposable local artifacts.
#
# This command deliberately has no Git-based cleanup mode. In particular, it
# never runs git clean, git restore, or reset: tracked edits and unrelated
# untracked files are outside its scope.

set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

usage() {
  cat <<'EOF'
usage: .github/ci/cleanup.sh [--dry-run] [--temp] [--builds] [--all]

With no options, remove only generated demo artifacts in this checkout:
  target/demo-artifacts
  counter.woven.wasm
  demos/browser-wamr/counter.woven.wasm

Options:
  --dry-run  print the exact paths that would be removed
  --temp     also remove owned, direct children of TMPDIR whose names match
             the exact temporary-directory prefixes used by Weave harnesses
  --builds   also remove this checkout's target and wamr/target build trees
  --all      equivalent to --temp --builds
  -h, --help show this help

The command never changes tracked source, arbitrary untracked files, or Git
state. Symlinks and paths escaping their expected roots are rejected.
EOF
}

dry_run=0
include_temp=0
include_builds=0
while (($#)); do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --temp) include_temp=1 ;;
    --builds) include_builds=1 ;;
    --all) include_temp=1; include_builds=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

# Tests can substitute an entirely isolated checkout and temporary root. Both
# overrides are intentionally gated and must be supplied together, preventing
# a stray environment variable from widening a real cleanup operation.
if [[ -n "${WEAVE_CLEANUP_TEST_ROOT:-}" || -n "${WEAVE_CLEANUP_TEST_TMPDIR:-}" ]]; then
  if [[ "${WEAVE_CLEANUP_TESTING:-0}" != 1 ]]; then
    printf '%s\n' 'cleanup test-root overrides require WEAVE_CLEANUP_TESTING=1' >&2
    exit 2
  fi
  if [[ -z "${WEAVE_CLEANUP_TEST_ROOT:-}" || -z "${WEAVE_CLEANUP_TEST_TMPDIR:-}" ]]; then
    printf '%s\n' 'cleanup tests must provide both test-root overrides' >&2
    exit 2
  fi
fi

ROOT="${WEAVE_CLEANUP_TEST_ROOT:-$SOURCE_ROOT}"
TEMP_ROOT="${WEAVE_CLEANUP_TEST_TMPDIR:-${TMPDIR:-/tmp}}"

canonical_directory() {
  local directory="$1"
  [[ -d "$directory" ]] || return 1
  (cd -P -- "$directory" && pwd -P)
}

ROOT="$(canonical_directory "$ROOT")" || {
  printf 'cleanup root is not a directory: %s\n' "$ROOT" >&2
  exit 1
}
TEMP_ROOT="$(canonical_directory "$TEMP_ROOT")" || {
  printf 'temporary root is not a directory: %s\n' "$TEMP_ROOT" >&2
  exit 1
}
if [[ "$ROOT" == / || "$TEMP_ROOT" == / ]]; then
  printf 'refusing unsafe cleanup roots (repo=%s, temp=%s)\n' "$ROOT" "$TEMP_ROOT" >&2
  exit 1
fi

failures=0
action_count=0

reject() {
  printf 'refusing unsafe cleanup target (%s): %s\n' "$1" "$2" >&2
  failures=1
}

# Return success when any component below root is a symlink. The cleanup roots
# themselves have already been physically canonicalized.
has_symlink_component() {
  local root="$1" path="$2" relative component cursor
  case "$path" in
    "$root"/*) relative="${path#"$root"/}" ;;
    *) return 2 ;;
  esac
  cursor="$root"
  while [[ -n "$relative" ]]; do
    if [[ "$relative" == */* ]]; then
      component="${relative%%/*}"
      relative="${relative#*/}"
    else
      component="$relative"
      relative=''
    fi
    cursor="$cursor/$component"
    [[ -L "$cursor" ]] && return 0
  done
  return 1
}

canonical_existing_path() {
  local path="$1" parent basename physical_parent
  if [[ -d "$path" ]]; then
    canonical_directory "$path"
    return
  fi
  parent="${path%/*}"
  basename="${path##*/}"
  physical_parent="$(canonical_directory "$parent")" || return 1
  printf '%s/%s\n' "$physical_parent" "$basename"
}

owner_uid() {
  local path="$1" value
  if value="$(stat -f '%u' "$path" 2>/dev/null)"; then
    printf '%s\n' "$value"
  else
    stat -c '%u' -- "$path" 2>/dev/null
  fi
}

remove_validated() {
  local category="$1" path="$2" allowed_root="$3" require_owner="$4" expected_type="$5"
  local resolved actual_owner symlink_status

  [[ -e "$path" || -L "$path" ]] || return 0
  if [[ "$expected_type" == directory && ! -d "$path" && ! -L "$path" ]]; then
    reject "$category" "$path (expected a directory)"
    return 0
  fi
  if [[ "$expected_type" == file && ! -f "$path" && ! -L "$path" ]]; then
    reject "$category" "$path (expected a regular file)"
    return 0
  fi
  if has_symlink_component "$allowed_root" "$path"; then
    reject "$category" "$path (symlink component)"
    return 0
  else
    symlink_status=$?
    if [[ "$symlink_status" == 2 ]]; then
      reject "$category" "$path (outside $allowed_root)"
      return 0
    fi
  fi

  resolved="$(canonical_existing_path "$path")" || {
    reject "$category" "$path (cannot canonicalize)"
    return 0
  }
  case "$resolved" in
    "$allowed_root"/*) ;;
    *)
      reject "$category" "$path (resolves outside $allowed_root)"
      return 0
      ;;
  esac

  if [[ "$require_owner" == 1 ]]; then
    actual_owner="$(owner_uid "$path")" || {
      reject "$category" "$path (cannot determine owner)"
      return 0
    }
    if [[ "$actual_owner" != "$(id -u)" ]]; then
      reject "$category" "$path (owned by uid $actual_owner)"
      return 0
    fi
  fi

  action_count=$((action_count + 1))
  if ((dry_run)); then
    printf 'would remove %-13s %s\n' "$category" "$path"
    return 0
  fi
  if ! rm -rf -- "$path"; then
    reject "$category" "$path (removal failed)"
    return 0
  fi
  printf 'removed      %-13s %s\n' "$category" "$path"
}

is_allowlisted_temp_name() {
  case "$1" in
    weave-conformance.?* | \
    weave-browser-peer.?* | \
    weave-browser-peer-?* | \
    weave-browser-sidecar.?* | \
    weave-browser-smoke.?* | \
    weave-checkpoint.?* | \
    weave-native-e2e.?* | \
    weave-rust-guest.?* | \
    weave-spec-corpus.?* | \
    weave-adversity | weave-adversity.?* | \
    weave-qualification | weave-qualification.?* | \
    weave-go-build.?* | \
    weave-wamr-prepare.?* | \
    weave-wasm-tools-prepare.?* | \
    weave-artifact-lifecycle-test.?* | \
    weave-cleanup-test.?* | \
    weave-chrome-smoke-?* | \
    weave-sidecar-chrome-?* | \
    weave-sidecar-controller-test-?* | \
    weave-webrtc-server-test-?*) return 0 ;;
    *) return 1 ;;
  esac
}

# Always-cleanable, repo-local demo output. These are exact paths rather than
# a generic ignored-file sweep.
remove_validated 'demo artifact' "$ROOT/target/demo-artifacts" "$ROOT" 0 directory
remove_validated 'demo artifact' "$ROOT/counter.woven.wasm" "$ROOT" 0 file
remove_validated 'demo artifact' "$ROOT/demos/browser-wamr/counter.woven.wasm" "$ROOT" 0 file

if ((include_temp)); then
  # Every historical harness directory starts with "weave-". nullglob keeps a
  # root with no candidates from turning the pattern into a literal path.
  shopt -s nullglob
  temp_children=("$TEMP_ROOT"/weave-*)
  shopt -u nullglob
  for candidate in "${temp_children[@]}"; do
    name="${candidate##*/}"
    is_allowlisted_temp_name "$name" || continue
    # Historical temporary artifacts are directories. A coincidentally named
    # regular file is not one of ours and remains untouched. Symlinks continue
    # to validation below so they cause a visible refusal rather than a skip.
    [[ -d "$candidate" || -L "$candidate" ]] || continue
    # The glob above enumerates direct children only. Keep the explicit check
    # so future refactors cannot silently broaden the operation.
    if [[ "${candidate%/*}" != "$TEMP_ROOT" ]]; then
      reject 'temporary' "$candidate (not a direct child of $TEMP_ROOT)"
      continue
    fi
    remove_validated 'temporary' "$candidate" "$TEMP_ROOT" 1 directory
  done
fi

if ((include_builds)); then
  remove_validated 'build cache' "$ROOT/target" "$ROOT" 0 directory
  remove_validated 'build cache' "$ROOT/wamr/target" "$ROOT" 0 directory
fi

if ((action_count == 0)); then
  printf '%s\n' 'cleanup: no matching artifacts'
fi
((failures == 0))
