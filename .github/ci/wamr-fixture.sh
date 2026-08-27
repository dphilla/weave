#!/usr/bin/env bash
# Focused Wasmtime -> WAMR -> Wasmtime route for the multiple-memory fixture.
# The fixture clears an active data-segment byte, so the route also verifies
# the all-zero restore baseline used by sparse page transfer.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

WEAVE_CI_FIXTURE=wamr/tests/fixtures/multi-memory.wat \
WEAVE_CI_ENTRY=run \
WEAVE_CI_ARG="${WEAVE_CI_ARG:-100000000}" \
WEAVE_CI_ITERATIONS="${WEAVE_CI_ITERATIONS:-100000000}" \
WEAVE_CI_MIGRATE_AFTER_EVENTS=1 \
WEAVE_CI_MIGRATE_AFTER_EVENTS_BY_HOP=1,0 \
  .github/ci/conformance.sh --route wasmtime:wamr:wasmtime "$@"
