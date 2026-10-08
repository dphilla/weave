#!/usr/bin/env bash
# Compare fixed guest semantics across runtimes and real migration routes.
# Expected events are independent of the transformer's Wasmtime golden run.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.github/ci/artifact-lifecycle.sh"
# shellcheck disable=SC1091
source "$ROOT/.github/ci/awake-guard.sh"
cd "$ROOT"

usage() {
  cat <<'EOF'
usage: .github/ci/semantic-conformance.sh [native|wamr|endive|all] [--skip-build]

  native  Three fixed-trace fixtures on Wasmtime, Node, and wazero, followed
          by a Wasmtime -> Node -> wazero -> Wasmtime migration route.
  wamr    The same fixtures on Wasmtime/WAMR, plus scalar and SIMD/multiple-
          memory Wasmtime -> WAMR -> Wasmtime migration routes.
  endive  The same fixtures on Wasmtime/Endive, scalar and multiple-memory
          Wasmtime -> Endive -> Wasmtime routes, and Endive's compile-time
          refusal of the SIMD fixture.
  all     Every lane, sharing builds and standalone Wasmtime checks.

The default lane is native. --skip-build requires existing release binaries.
Explicit WEAVE_BIN, WEAVE_WAZERO_BIN, WEAVE_WAMR_BIN, and WEAVE_ENDIVE_BIN
overrides are used without rebuilding or overwriting them. NODE_BIN selects Node.

Environment:
  WAMR_ROOT                        Required for wamr/all.
  WEAVE_CI_ARTIFACT_DIR             Retained logs, fixtures, and expected traces.
  WEAVE_CI_KEEP_TEMP=1              Retain successful default temp artifacts.
  WEAVE_CI_SEMANTIC_ITERATIONS       Main route iterations (default: 80000000;
                                   also honors WEAVE_CI_ITERATIONS).
  WEAVE_CI_SIMD_ITERATIONS           SIMD route iterations (default: 100000000).
  WEAVE_CI_ENDIVE_ITERATIONS         Endive routes' iterations (default: 400000000).
  WEAVE_CI_TIMEOUT_SECONDS          Per-process timeout (default: 180).
  WEAVE_CI_PREVENT_SLEEP=0           Disable the shared macOS awake guard.

Small iteration counts can finish before migration; retain the defaults for CI.
EOF
}

suite=native
suite_set=0
skip_build=0
for argument in "$@"; do
  case "$argument" in
    native|wamr|endive|all)
      ((suite_set == 0)) || { printf '%s\n' 'select only one semantic lane' >&2; exit 2; }
      suite="$argument"
      suite_set=1
      ;;
    --skip-build) skip_build=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$argument" >&2; usage >&2; exit 2 ;;
  esac
done

needs_native=0
needs_wamr=0
needs_endive=0
case "$suite" in
  native) needs_native=1 ;;
  wamr) needs_wamr=1 ;;
  endive) needs_endive=1 ;;
  all) needs_native=1; needs_wamr=1; needs_endive=1 ;;
esac
if ((needs_wamr)) && [[ -z "${WAMR_ROOT:-}" ]]; then
  printf '%s\n' 'WAMR_ROOT is required for the selected semantic lane' >&2
  exit 2
fi

readonly ITERATIONS="${WEAVE_CI_SEMANTIC_ITERATIONS:-${WEAVE_CI_ITERATIONS:-80000000}}"
readonly SIMD_ITERATIONS="${WEAVE_CI_SIMD_ITERATIONS:-100000000}"
readonly ENDIVE_ITERATIONS="${WEAVE_CI_ENDIVE_ITERATIONS:-400000000}"
for count in "$ITERATIONS" "$SIMD_ITERATIONS" "$ENDIVE_ITERATIONS"; do
  # The SIMD result adds 198 to a signed i32; keep expected arithmetic exact.
  if [[ ! "$count" =~ ^[1-9][0-9]{0,9}$ ]] || ((count > 2147483449)); then
    printf 'semantic iteration count must be 1..2147483449: %s\n' "$count" >&2
    exit 2
  fi
done

weave_ci_reexec_awake "$ROOT/.github/ci/semantic-conformance.sh" "$@"
weave_ci_artifacts_init weave-semantic-conformance ARTIFACT_ROOT
ARTIFACT_ROOT="$(cd "$ARTIFACT_ROOT" && pwd)"
mkdir -p "$ARTIFACT_ROOT/bin" "$ARTIFACT_ROOT/standalone"

readonly ROOT_CARGO_TARGET="${CARGO_TARGET_DIR:-$ROOT/target}"
readonly WAMR_CARGO_TARGET="${CARGO_TARGET_DIR:-$ROOT/wamr/target}"
readonly CLI="${WEAVE_BIN:-$ROOT_CARGO_TARGET/release/weave}"
readonly NODE="${NODE_BIN:-node}"
readonly WAZERO="${WEAVE_WAZERO_BIN:-$ARTIFACT_ROOT/bin/weave-wazero}"
readonly WAMR="${WEAVE_WAMR_BIN:-$WAMR_CARGO_TARGET/release/weave-wamr}"
readonly ENDIVE="${WEAVE_ENDIVE_BIN:-$ROOT/java/weave-endive/weave-endive}"
readonly TIMEOUT_RUN="$ROOT/.github/ci/with-timeout.sh"
readonly TIMEOUT_SECONDS="${WEAVE_CI_TIMEOUT_SECONDS:-180}"
readonly FIXTURE_ROOT="$ROOT/tests/fixtures/p1"

if ((!skip_build)); then
  if [[ -z "${WEAVE_BIN:-}" ]]; then cargo build --locked --release -p weave-cli; fi
  if ((needs_native)) && [[ -z "${WEAVE_WAZERO_BIN:-}" ]]; then
    (cd go/weave-wazero && go build -mod=readonly -o "$WAZERO" .)
  fi
  if ((needs_wamr)) && [[ -z "${WEAVE_WAMR_BIN:-}" ]]; then
    cargo build --locked --release --manifest-path wamr/Cargo.toml
  fi
  if ((needs_endive)) && [[ -z "${WEAVE_ENDIVE_BIN:-}" ]]; then
    mvn -B -q -f java/weave-endive/pom.xml package -DskipTests
  fi
fi

require_executable() {
  [[ -x "$1" ]] || { printf 'missing executable: %s\n' "$1" >&2; exit 1; }
}
require_executable "$CLI"
if ((needs_native)); then
  command -v "$NODE" >/dev/null || { printf 'Node is unavailable: %s\n' "$NODE" >&2; exit 1; }
  require_executable "$WAZERO"
fi
if ((needs_wamr)); then require_executable "$WAMR"; fi
if ((needs_endive)); then
  command -v java >/dev/null || { printf '%s\n' 'Java is unavailable' >&2; exit 1; }
  require_executable "$ENDIVE"
  [[ -n "${WEAVE_ENDIVE_BIN:-}" || -f java/weave-endive/target/weave-endive.jar ]] || {
    printf '%s\n' 'missing java/weave-endive/target/weave-endive.jar; build it or set WEAVE_ENDIVE_BIN' >&2
    exit 1
  }
fi

{
  printf 'suite=%s\niterations=%s\nsimd_iterations=%s\nendive_iterations=%s\n' \
    "$suite" "$ITERATIONS" "$SIMD_ITERATIONS" "$ENDIVE_ITERATIONS"
  printf 'weave=%s\nwazero=%s\nwamr=%s\nendive=%s\nnode=%s\n' "$CLI" "$WAZERO" "$WAMR" "$ENDIVE" "$NODE"
  printf 'guest_fixture_period=64\nstandalone_argument=1000\n'
} > "$ARTIFACT_ROOT/manifest.txt"

compare_events() {
  local expected="$1" actual="$2"
  if ! diff -u "$expected" "$actual" > "$actual.diff"; then
    printf 'guest semantics differ: %s\n' "$actual" >&2
    cat "$actual.diff" >&2
    return 1
  fi
}

run_standalone() {
  local fixture="$1" runtime="$2" wasm="$3" expected="$4"
  local output="$ARTIFACT_ROOT/standalone/$fixture.$runtime"
  local -a command=()
  case "$runtime" in
    wasmtime) command=("$CLI" run "$wasm" --pre-woven --invoke run --arg 1000) ;;
    node) command=("$NODE" "$ROOT/js/weave-node.mjs" run --module "$wasm" --invoke run --arg 1000) ;;
    wazero) command=("$WAZERO" run --module "$wasm" --invoke run --arg 1000) ;;
    wamr) command=("$WAMR" run "$wasm" --invoke run --arg 1000) ;;
    endive) command=("$ENDIVE" run --module "$wasm" --invoke run --arg 1000) ;;
  esac
  if ! "$TIMEOUT_RUN" "$TIMEOUT_SECONDS" "${command[@]}" > "$output.stdout" 2> "$output.stderr"; then
    printf 'standalone failed: %s/%s\n' "$fixture" "$runtime" >&2
    cat "$output.stderr" >&2
    return 1
  fi
  awk '/^(EMIT|WEAVE_DONE)/' "$output.stdout" > "$output.events"
  compare_events "$expected" "$output.events"
  printf 'PASS fixed guest trace: %s/%s\n' "$fixture" "$runtime"
}

runtimes=(wasmtime)
if ((needs_native)); then runtimes+=(node wazero); fi
if ((needs_wamr)); then runtimes+=(wamr); fi
if ((needs_endive)); then runtimes+=(endive); fi
for fixture in memory-start-tailcall fixed-zero-memory explicit-start; do
  wasm="$ARTIFACT_ROOT/standalone/$fixture.woven.wasm"
  "$CLI" transform "$FIXTURE_ROOT/$fixture.wat" -o "$wasm" --period 64
  for runtime in "${runtimes[@]}"; do
    run_standalone "$fixture" "$runtime" "$wasm" "$FIXTURE_ROOT/$fixture.events"
  done
done

run_route() {
  local label="$1" fixture="$2" expected="$3" iterations="$4" thresholds="$5" route="$6"
  local artifacts="$ARTIFACT_ROOT/$label"
  WEAVE_BIN="$CLI" WEAVE_WAZERO_BIN="$WAZERO" WEAVE_WAMR_BIN="$WAMR" WEAVE_ENDIVE_BIN="$ENDIVE" NODE_BIN="$NODE" \
  WEAVE_CI_ARTIFACT_DIR="$artifacts" WEAVE_CI_FIXTURE="$fixture" \
  WEAVE_CI_ENTRY=run WEAVE_CI_ARG="$iterations" WEAVE_CI_ITERATIONS="$iterations" \
  WEAVE_CI_POLL_PERIOD=64 WEAVE_CI_MIGRATE_AFTER_EVENTS=2 \
  WEAVE_CI_MIGRATE_AFTER_EVENTS_BY_HOP="$thresholds" \
    "$ROOT/.github/ci/conformance.sh" --skip-build --route "$route"
  # Ordinary conformance compares against woven Wasmtime. Also require the
  # independent expected trace so a shared transformer bug cannot pass.
  compare_events "$expected" "$artifacts/golden.events"
  for combined in "$artifacts"/cases/*/combined.events; do
    compare_events "$expected" "$combined"
  done
  printf 'PASS fixed guest trace after migration: %s\n' "$route"
}

if ((needs_native)); then
  run_route native "$FIXTURE_ROOT/memory-start-tailcall.wat" \
    "$FIXTURE_ROOT/memory-start-tailcall.events" "$ITERATIONS" 2,2,2 wasmtime:node:wazero:wasmtime
fi
simd_fixture="$ROOT/wamr/tests/fixtures/simd-multi-memory.wat"
simd_wasm="$ARTIFACT_ROOT/standalone/simd-multi-memory.woven.wasm"
if ((needs_wamr || needs_endive)); then
  "$CLI" transform "$simd_fixture" -o "$simd_wasm" --period 64
fi

if ((needs_wamr)); then
  run_route wamr "$FIXTURE_ROOT/memory-start-tailcall.wat" \
    "$FIXTURE_ROOT/memory-start-tailcall.events" "$ITERATIONS" 2,2 wasmtime:wamr:wasmtime

  simd_expected="$ARTIFACT_ROOT/standalone/simd-multi-memory.expected.events"
  printf 'EMIT32 0\nEMIT32 1000\nWEAVE_DONE [1198]\n' > "$simd_expected"
  run_standalone simd-multi-memory wasmtime "$simd_wasm" "$simd_expected"
  run_standalone simd-multi-memory wamr "$simd_wasm" "$simd_expected"
  simd_route_expected="$ARTIFACT_ROOT/simd.expected.events"
  printf 'EMIT32 0\nEMIT32 %s\nWEAVE_DONE [%s]\n' "$SIMD_ITERATIONS" "$((SIMD_ITERATIONS + 198))" \
    > "$simd_route_expected"
  run_route simd "$simd_fixture" "$simd_route_expected" "$SIMD_ITERATIONS" 1,0 wasmtime:wamr:wasmtime
fi

if ((needs_endive)); then
  # Endive receives the loop after Wasmtime has run part of it; a longer loop leaves it work.
  run_route endive "$FIXTURE_ROOT/memory-start-tailcall.wat" \
    "$FIXTURE_ROOT/memory-start-tailcall.events" "$ENDIVE_ITERATIONS" 2,2 wasmtime:endive:wasmtime
  multi_memory_expected="$ARTIFACT_ROOT/multi-memory.expected.events"
  printf 'EMIT32 0\nEMIT32 %s\nWEAVE_DONE [%s]\n' "$ENDIVE_ITERATIONS" "$ENDIVE_ITERATIONS" \
    > "$multi_memory_expected"
  run_route endive-multi-memory "$ROOT/wamr/tests/fixtures/multi-memory.wat" \
    "$multi_memory_expected" "$ENDIVE_ITERATIONS" 1,0 wasmtime:endive:wasmtime

  # Endive's compiler has no v128: the module must be refused before any guest code runs.
  refusal="$ARTIFACT_ROOT/standalone/simd-multi-memory.endive"
  if "$TIMEOUT_RUN" "$TIMEOUT_SECONDS" "$ENDIVE" run --module "$simd_wasm" --invoke run --arg 1000 \
    > "$refusal.stdout" 2> "$refusal.stderr" || grep -q '^EMIT' "$refusal.stdout" \
    || ! grep -q 'Endive cannot compile this module' "$refusal.stderr"; then
    printf '%s\n' 'Endive did not refuse the SIMD fixture at compile time; review the documented SIMD gap' >&2
    cat "$refusal.stdout" "$refusal.stderr" >&2
    exit 1
  fi
  printf 'PASS known gap asserted: Endive refuses SIMD before executing guest code\n'
fi

printf '\nPASS: %s semantic conformance; artifacts: %s\n' "$suite" "$ARTIFACT_ROOT"
