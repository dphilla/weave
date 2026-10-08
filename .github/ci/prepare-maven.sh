#!/usr/bin/env bash
# Download and checksum-verify the pinned Apache Maven into a caller-owned CI temporary directory.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.github/ci/versions.env"

[[ $# -eq 1 ]] || {
  printf 'usage: .github/ci/prepare-maven.sh DESTINATION_DIRECTORY\n' >&2
  exit 2
}

destination="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1")"
allowed_root="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "${RUNNER_TEMP:-${TMPDIR:-/tmp}}")"
[[ "$allowed_root" != / ]] || { printf '%s\n' 'refusing to use / as the CI temporary root' >&2; exit 1; }
case "$destination" in
  "$allowed_root"/*) ;;
  *) printf 'refusing Maven destination outside CI temporary root %s: %s\n' "$allowed_root" "$destination" >&2; exit 1 ;;
esac
case "$destination" in /|"$ROOT"|"$ROOT"/*) printf 'refusing unsafe destination: %s\n' "$destination" >&2; exit 1 ;; esac

mkdir -p "$destination"
archive="apache-maven-$MAVEN_VERSION-bin.tar.gz"
url="https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/$MAVEN_VERSION/$archive"
curl -L --fail --retry 3 -o "$destination/$archive" "$url"
if command -v sha512sum >/dev/null 2>&1; then
  actual="$(sha512sum "$destination/$archive" | awk '{print $1}')"
else
  actual="$(shasum -a 512 "$destination/$archive" | awk '{print $1}')"
fi
if [[ "$actual" != "$MAVEN_SHA512" ]]; then
  printf 'Maven checksum mismatch: got %s, expected %s\n' "$actual" "$MAVEN_SHA512" >&2
  exit 1
fi
tar -xzf "$destination/$archive" -C "$destination"
bin="$destination/apache-maven-$MAVEN_VERSION/bin"
[[ -x "$bin/mvn" ]] || { printf 'Maven archive did not contain %s\n' "$bin/mvn" >&2; exit 1; }
printf 'MAVEN_BIN_DIR=%s\n' "$bin"
