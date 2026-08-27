#!/usr/bin/env bash
# Fetch and verify the WAMR source tree used by CI. The product tag lives in
# wamr/WAMR_VERSION; versions.env adds the immutable commit verification.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.github/ci/versions.env"

usage() {
  printf 'usage: .github/ci/prepare-wamr.sh DESTINATION\n'
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  '') usage >&2; exit 2 ;;
esac
[[ $# -eq 1 ]] || { usage >&2; exit 2; }

destination="$1"
tag="$(tr -d '[:space:]' < "$ROOT/wamr/WAMR_VERSION")"
[[ -n "$tag" ]] || { printf '%s\n' 'wamr/WAMR_VERSION is empty' >&2; exit 1; }

destination="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$destination")"
allowed_root="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "${RUNNER_TEMP:-${TMPDIR:-/tmp}}")"
[[ "$allowed_root" != / ]] || { printf '%s\n' 'refusing to use / as the CI temporary root' >&2; exit 1; }
case "$destination" in
  "$allowed_root"/*) ;;
  *)
    printf 'refusing WAMR checkout outside CI temporary root %s: %s\n' "$allowed_root" "$destination" >&2
    exit 1
    ;;
esac
case "$destination" in
  /|"$ROOT"|"$ROOT"/*)
    printf 'refusing unsafe WAMR checkout destination: %s\n' "$destination" >&2
    exit 1
    ;;
esac

if [[ -e "$destination" && ! -d "$destination/.git" ]]; then
  printf 'destination exists but is not a Git checkout: %s\n' "$destination" >&2
  exit 1
fi

if [[ -d "$destination/.git" ]]; then
  if [[ -n "$(git -C "$destination" status --porcelain --untracked-files=normal)" ]]; then
    printf 'refusing to modify a dirty WAMR checkout: %s\n' "$destination" >&2
    exit 1
  fi
  origin="$(git -C "$destination" remote get-url origin 2>/dev/null || true)"
  if [[ "$origin" != "$WAMR_REPOSITORY" ]]; then
    printf 'WAMR checkout origin mismatch: got %s, expected %s\n' "$origin" "$WAMR_REPOSITORY" >&2
    exit 1
  fi
else
  git clone --filter=blob:none --no-checkout "$WAMR_REPOSITORY" "$destination"
fi

git -C "$destination" fetch --force --depth 1 origin "refs/tags/$tag:refs/tags/$tag"
actual_tag_commit="$(git -C "$destination" rev-list -n 1 "$tag")"
if [[ "$actual_tag_commit" != "$WAMR_COMMIT" ]]; then
  printf 'WAMR tag verification failed: %s resolved to %s, expected %s\n' \
    "$tag" "$actual_tag_commit" "$WAMR_COMMIT" >&2
  exit 1
fi

git -C "$destination" checkout --detach "$WAMR_COMMIT"
if [[ -n "$(git -C "$destination" status --porcelain --untracked-files=normal)" ]]; then
  printf 'verified WAMR checkout is unexpectedly dirty: %s\n' "$destination" >&2
  exit 1
fi

printf 'WAMR_ROOT=%s\n' "$(cd "$destination" && pwd)"
printf 'WAMR_TAG=%s\n' "$tag"
printf 'WAMR_COMMIT=%s\n' "$WAMR_COMMIT"
