#!/usr/bin/env bash
# Behavioral checks for suspend-safe conformance condition waits.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WAIT_FOR="$ROOT/.github/ci/wait-for.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/weave-wait-for-test.XXXXXX")"
declare -a active_pids=()

cleanup() {
  local pid
  for pid in "${active_pids[@]:-}"; do
    [[ -n "$pid" ]] || continue
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT INT TERM

sleep 0.05 &
pid=$!
active_pids+=("$pid")
"$WAIT_FOR" 1 process "$pid"
wait "$pid"
active_pids=()

sleep 2 &
pid=$!
active_pids+=("$pid")
status=0
"$WAIT_FOR" 0.05 process "$pid" || status=$?
[[ "$status" == 124 ]]
kill -0 "$pid" 2>/dev/null
kill "$pid"
wait "$pid" 2>/dev/null || true
active_pids=()

events="$TEST_ROOT/events.log"
: > "$events"
(
  sleep 0.05
  printf '%s\n' noise 'EMIT 0 1' 'EMIT64 1 2' >> "$events"
) &
pid=$!
active_pids+=("$pid")
count="$("$WAIT_FOR" 1 matching-lines "$events" 2 '^EMIT(32|64)? ')"
[[ "$count" == 2 ]]
wait "$pid"
active_pids=()

status=0
count="$("$WAIT_FOR" 0.05 matching-lines "$events" 3 '^EMIT(32|64)? ')" || status=$?
[[ "$status" == 124 ]]
[[ "$count" == 2 ]]

output="$("$WAIT_FOR" 1 output-contains ready bash -c 'printf ready')"
[[ "$output" == ready ]]
status=0
output="$("$WAIT_FOR" 0.05 output-contains ready bash -c 'printf waiting')" || status=$?
[[ "$status" == 124 ]]
[[ "$output" == waiting ]]

if "$WAIT_FOR" nope process 1 >/dev/null 2>&1; then
  printf '%s\n' 'wait-for accepted an invalid timeout' >&2
  exit 1
fi

grep -Fq 'time.monotonic()' "$WAIT_FOR"
printf '%s\n' 'PASS suspend-safe condition waits'
