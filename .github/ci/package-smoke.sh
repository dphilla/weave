#!/usr/bin/env bash
# Prove every public JavaScript workspace can be packed, installed, and
# imported from a clean consumer without relying on repository-relative files.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
NPM_BIN="${NPM_BIN:-npm}"
if [[ "$NODE_BIN" == */* ]]; then
  PATH="$(dirname "$NODE_BIN"):$PATH"
  export PATH
fi
PACKAGE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/weave-package-smoke.XXXXXX")"
trap 'rm -rf -- "$PACKAGE_TMP"' EXIT

PACK_DIR="$PACKAGE_TMP/packs"
CONSUMER_DIR="$PACKAGE_TMP/consumer"
NPM_CACHE_DIR="$PACKAGE_TMP/npm-cache"
mkdir -p "$PACK_DIR" "$CONSUMER_DIR" "$NPM_CACHE_DIR"
export npm_config_cache="$NPM_CACHE_DIR"

cd "$ROOT"
"$NPM_BIN" pack --workspaces --pack-destination "$PACK_DIR" >/dev/null

mapfile_command=(find "$PACK_DIR" -maxdepth 1 -type f -name '*.tgz' -print)
if [[ "$(uname -s)" == "Darwin" ]]; then
  packages=()
  while IFS= read -r archive; do packages+=("$archive"); done < <("${mapfile_command[@]}" | sort)
else
  mapfile -t packages < <("${mapfile_command[@]}" | sort)
fi
if [[ "${#packages[@]}" -eq 0 ]]; then
  printf 'package smoke: npm pack produced no archives\n' >&2
  exit 1
fi

for archive in "${packages[@]}"; do
  contents="$(tar -tzf "$archive")"
  if ! grep -qx 'package/LICENSE' <<<"$contents"; then
    printf 'package smoke: %s does not contain LICENSE\n' "$archive" >&2
    exit 1
  fi
  if grep -Eq '^package/(test|tests)/' <<<"$contents"; then
    printf 'package smoke: %s contains non-distributable tests\n' "$archive" >&2
    exit 1
  fi
done

cd "$CONSUMER_DIR"
"$NPM_BIN" init --yes >/dev/null
"$NPM_BIN" install --ignore-scripts --no-audit --no-fund "${packages[@]}" >/dev/null

"$NODE_BIN" --input-type=module -e '
  const browser = await import("@weave-net/browser-transports");
  const node = await import("@weave-net/node-transports");
  const gateway = await import("@weave-net/ws-tcp-gateway");
  for (const [name, value] of [
    ["WebSocketByteStream", browser.WebSocketByteStream],
    ["RTCDataChannelByteStream", browser.RTCDataChannelByteStream],
    ["TcpTransport", node.TcpTransport],
    ["bridgeWebSocketToDuplex", gateway.bridgeWebSocketToDuplex],
  ]) {
    if (typeof value !== "function") throw new Error(`missing package export ${name}`);
  }
'

printf 'package smoke: installed and imported %s clean archives\n' "${#packages[@]}"
