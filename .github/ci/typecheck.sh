#!/usr/bin/env bash
# Compile real consumers of the freshly packed public declarations, then run
# the emitted Node ESM consumer against native Web Crypto. Tools are CI-only.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
# shellcheck disable=SC1091
source "$ROOT/.github/ci/artifact-lifecycle.sh"
NODE_BIN="${NODE_BIN:-node}"
NPM_BIN="${NPM_BIN:-npm}"
if [[ "$NODE_BIN" == */* ]]; then
  PATH="$(dirname "$NODE_BIN"):$PATH"
  export PATH
fi
command -v "$NODE_BIN" >/dev/null || { printf '%s\n' 'Node.js is required for type checks' >&2; exit 1; }
command -v "$NPM_BIN" >/dev/null || { printf '%s\n' 'npm is required for type checks' >&2; exit 1; }

weave_ci_artifacts_init weave-typecheck ARTIFACT_DIR
ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd -P)"
case "$ARTIFACT_DIR/" in
  "$ROOT/"*) printf '%s\n' 'Type-check artifacts must be outside the checkout' >&2; exit 1 ;;
esac
CONSUMER="$ARTIFACT_DIR/consumer"
PACKS="$ARTIFACT_DIR/packs"
for directory in "$CONSUMER" "$PACKS"; do
  [[ ! -e "$directory" && ! -L "$directory" ]] || {
    printf 'Type-check output already exists; use a fresh artifact directory: %s\n' "$directory" >&2
    exit 1
  }
done
mkdir -p "$CONSUMER/types" "$PACKS"
printf 'Type-check artifacts: %s\n' "$ARTIFACT_DIR"
cp "$ROOT/.github/ci/typecheck/package.json" "$ROOT/.github/ci/typecheck/package-lock.json" "$CONSUMER/"
cp "$ROOT/packages/authenticated-rendezvous/test/types/"*.mts \
  "$ROOT/packages/authenticated-rendezvous/test/types/"*.json "$CONSUMER/types/"

{
  printf 'node_bin=%s\n' "$NODE_BIN"
  "$NODE_BIN" --version
  printf 'npm_bin=%s\n' "$NPM_BIN"
  "$NPM_BIN" --version
} > "$ARTIFACT_DIR/versions.txt"

cd "$CONSUMER"
"$NPM_BIN" ci --ignore-scripts --no-audit --no-fund 2>&1 | tee "$ARTIFACT_DIR/npm-ci.log"
cd "$ROOT"
"$NPM_BIN" pack --workspace @weave-net/authenticated-rendezvous --ignore-scripts \
  --json --pack-destination "$PACKS" > "$ARTIFACT_DIR/pack.json"
ARCHIVE="$("$NODE_BIN" --input-type=module - "$ARTIFACT_DIR/pack.json" <<'NODE'
import fs from "node:fs";
const result = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (result.length !== 1 || result[0].name !== "@weave-net/authenticated-rendezvous"
  || !/^[a-zA-Z0-9._-]+\.tgz$/.test(result[0].filename)) {
  throw new Error("npm pack must produce exactly the authenticated-rendezvous archive");
}
if (result[0].files.some(({ path }) => /^(?:test|tests)\//.test(path))) {
  throw new Error("Consumer fixtures must not be included in the published package");
}
process.stdout.write(result[0].filename);
NODE
)"
cd "$CONSUMER"
"$NPM_BIN" install --ignore-scripts --no-audit --no-fund --no-save --package-lock=false \
  "$PACKS/$ARCHIVE" 2>&1 | tee "$ARTIFACT_DIR/npm-install.log"
"$NODE_BIN" --input-type=module - "$CONSUMER" "$PACKS/$ARCHIVE" <<'NODE' | tee -a "$ARTIFACT_DIR/versions.txt"
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const [consumer, archive] = process.argv.slice(2);
const expected = JSON.parse(fs.readFileSync(path.join(consumer, "package.json"), "utf8")).devDependencies;
for (const name of ["typescript", "@types/node"]) {
  const actual = JSON.parse(fs.readFileSync(path.join(consumer, "node_modules", name, "package.json"), "utf8")).version;
  if (actual !== expected[name]) throw new Error(`${name} differs from its exact CI pin`);
  console.log(`${name}=${actual}`);
}
console.log(`archive=${archive}`);
console.log(`archive_sha256=${createHash("sha256").update(fs.readFileSync(archive)).digest("hex")}`);
NODE

status=0
for environment in browser node custom; do
  if "$NODE_BIN" node_modules/typescript/bin/tsc --project "types/tsconfig.$environment.json" \
    --pretty false 2>&1 | tee "$ARTIFACT_DIR/tsc-$environment.log"; then
    printf 'PASS strict installed-package %s declarations\n' "$environment"
  else
    status=1
  fi
done
((status == 0)) || exit 1
"$NODE_BIN" compiled-node/node.mjs 2>&1 | tee "$ARTIFACT_DIR/node-runtime.log"
printf '%s\n' 'PASS packed declarations in browser, DOM-free Node, and ES-only custom-provider consumers'
