#!/usr/bin/env bash
# Download and checksum-verify the pinned official wasm-tools binary into a
# caller-owned CI temporary directory.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.github/ci/versions.env"

[[ $# -eq 1 ]] || {
  printf 'usage: .github/ci/prepare-wasm-tools.sh DESTINATION_DIRECTORY\n' >&2
  exit 2
}

destination="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1")"
allowed_root="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "${RUNNER_TEMP:-${TMPDIR:-/tmp}}")"
[[ "$allowed_root" != / ]] || { printf '%s\n' 'refusing to use / as the CI temporary root' >&2; exit 1; }
case "$destination" in
  "$allowed_root"/*) ;;
  *) printf 'refusing wasm-tools destination outside CI temporary root %s: %s\n' "$allowed_root" "$destination" >&2; exit 1 ;;
esac
case "$destination" in /|"$ROOT"|"$ROOT"/*) printf 'refusing unsafe destination: %s\n' "$destination" >&2; exit 1 ;; esac

case "$(uname -s)-$(uname -m)" in
  Linux-aarch64|Linux-arm64)
    target=aarch64-linux
    expected="$WASM_TOOLS_SHA256_AARCH64_LINUX"
    ;;
  Linux-x86_64)
    target=x86_64-linux
    expected="$WASM_TOOLS_SHA256_X86_64_LINUX"
    ;;
  Darwin-arm64|Darwin-aarch64)
    target=aarch64-macos
    expected="$WASM_TOOLS_SHA256_AARCH64_MACOS"
    ;;
  Darwin-x86_64)
    target=x86_64-macos
    expected="$WASM_TOOLS_SHA256_X86_64_MACOS"
    ;;
  *) printf 'no pinned wasm-tools binary for %s-%s\n' "$(uname -s)" "$(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$destination"
archive="wasm-tools-$WASM_TOOLS_VERSION-$target.tar.gz"
url="https://github.com/bytecodealliance/wasm-tools/releases/download/v$WASM_TOOLS_VERSION/$archive"
curl -L --fail --retry 3 -o "$destination/$archive" "$url"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$destination/$archive" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$destination/$archive" | awk '{print $1}')"
fi
if [[ "$actual" != "$expected" ]]; then
  printf 'wasm-tools checksum mismatch: got %s, expected %s\n' "$actual" "$expected" >&2
  exit 1
fi
tar -xzf "$destination/$archive" -C "$destination"
binary="$destination/wasm-tools-$WASM_TOOLS_VERSION-$target/wasm-tools"
[[ -x "$binary" ]] || { printf 'wasm-tools archive did not contain %s\n' "$binary" >&2; exit 1; }
printf 'WASM_TOOLS_BIN=%s\n' "$binary"
