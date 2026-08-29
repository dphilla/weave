#!/usr/bin/env bash
# Verify checkpoint-to-file and restore in a fresh process against an
# uninterrupted golden event stream.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.github/ci/artifact-lifecycle.sh"
cd "$ROOT"

weave_ci_artifacts_init weave-checkpoint ARTIFACT_DIR
TIMEOUT_SECONDS="${WEAVE_CI_TIMEOUT_SECONDS:-180}"
ITERATIONS="${WEAVE_CI_CHECKPOINT_ITERATIONS:-3000000}"
TIMEOUT_RUN="$ROOT/.github/ci/with-timeout.sh"
ROOT_CARGO_TARGET="${CARGO_TARGET_DIR:-$ROOT/target}"
WEAVE_BIN="${WEAVE_BIN:-$ROOT_CARGO_TARGET/release/weave}"
printf 'checkpoint artifacts: %s\n' "$ARTIFACT_DIR"

"$TIMEOUT_RUN" "$TIMEOUT_SECONDS" cargo build --locked --release -p weave-cli
"$TIMEOUT_RUN" "$TIMEOUT_SECONDS" "$WEAVE_BIN" transform guests/counter.wat \
  -o "$ARTIFACT_DIR/counter.woven.wasm" --period 64
"$TIMEOUT_RUN" "$TIMEOUT_SECONDS" "$WEAVE_BIN" run "$ARTIFACT_DIR/counter.woven.wasm" \
  --pre-woven --invoke run --arg "$ITERATIONS" > "$ARTIFACT_DIR/golden.raw"
awk '/^(EMIT|WEAVE_DONE)/' "$ARTIFACT_DIR/golden.raw" > "$ARTIFACT_DIR/golden.events"

"$TIMEOUT_RUN" "$TIMEOUT_SECONDS" "$WEAVE_BIN" checkpoint "$ARTIFACT_DIR/counter.woven.wasm" \
  --pre-woven --invoke run --arg "$ITERATIONS" --after-polls 2 \
  -o "$ARTIFACT_DIR/counter.snap" > "$ARTIFACT_DIR/before.raw" \
  2> "$ARTIFACT_DIR/checkpoint.stderr"
"$TIMEOUT_RUN" "$TIMEOUT_SECONDS" "$WEAVE_BIN" restore "$ARTIFACT_DIR/counter.woven.wasm" \
  "$ARTIFACT_DIR/counter.snap" --pre-woven > "$ARTIFACT_DIR/after.raw" \
  2> "$ARTIFACT_DIR/restore.stderr"
awk '/^(EMIT|WEAVE_DONE)/' "$ARTIFACT_DIR/before.raw" "$ARTIFACT_DIR/after.raw" \
  > "$ARTIFACT_DIR/restored.events"

if ! diff -u "$ARTIFACT_DIR/golden.events" "$ARTIFACT_DIR/restored.events" \
  > "$ARTIFACT_DIR/events.diff"; then
  printf '%s\n' 'checkpoint/restore event stream diverged' >&2
  sed -n '1,240p' "$ARTIFACT_DIR/events.diff" >&2
  exit 1
fi
rm -f "$ARTIFACT_DIR/events.diff"

{
  printf 'git_sha=%s\n' "$(git rev-parse HEAD)"
  printf 'iterations=%s\n' "$ITERATIONS"
  printf 'after_polls=2\n'
  rustc --version
  cargo --version
} > "$ARTIFACT_DIR/manifest.txt"
printf 'PASS checkpoint -> fresh-process restore (%s events)\n' \
  "$(wc -l < "$ARTIFACT_DIR/restored.events" | tr -d ' ')"
