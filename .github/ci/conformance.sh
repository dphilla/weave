#!/usr/bin/env bash
# Cross-runtime black-box migration conformance driver.
#
# CI-specific orchestration lives here, not in runtime implementations. Each
# case launches real node processes, migrates over TCP, and compares the full
# host-visible event stream with one uninterrupted Wasmtime golden run.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
readonly -a ORIGINAL_ARGS=("$@")
# shellcheck disable=SC1091
source "$ROOT/.github/ci/awake-guard.sh"

usage() {
  cat <<'EOF'
usage: .github/ci/conformance.sh [--suite pr|native|wamr|all]
                                  [--edge SRC:DST]... [--route A:B:C]...

Runtime names: wasmtime, node, wazero, wamr

Suites:
  pr      representative directed cycle through Wasmtime, Node, and wazero
  native  all nine directed pairs among Wasmtime, Node, and wazero
  wamr    WAMR self-migration and both directions with every native adapter
  all     native + wamr

Options:
  --list             print the selected edges/routes without running them
  --skip-build       use already-built binaries
  --edge SRC:DST     run an explicit edge; may be repeated and overrides suite
  --route A:B:C      run a multi-hop route; may be repeated and overrides suite
  -h, --help         show this help

  Environment:
  WAMR_ROOT                    required when an edge contains WAMR
  WEAVE_CI_ARTIFACT_DIR        persistent log/output directory (default: temp)
  WEAVE_CI_ITERATIONS          counter iterations (default: 200000000)
    WEAVE_CI_MIGRATE_AFTER_EVENTS source events before migration (default: 2)
    WEAVE_CI_MIGRATE_AFTER_EVENTS_BY_HOP comma-separated per-hop overrides
  WEAVE_CI_FIXTURE             input .wat/.wasm (default: guests/counter.wat)
  WEAVE_CI_ENTRY               invoked export (default: run)
    WEAVE_CI_TIMEOUT_SECONDS     per-process/status timeout (default: 180)
    WEAVE_CI_STATUS_TIMEOUT_SECONDS timeout for one status request (default: 5)
  WEAVE_CI_KEEP_TEMP           retain a default temporary artifact directory
  WEAVE_CI_PREVENT_SLEEP=0     disable the automatic macOS awake guard
  WEAVE_BIN, WEAVE_WAZERO_BIN, WEAVE_WAMR_BIN, NODE_BIN
EOF
}

suite=pr
list_only=0
skip_build=0
declare -a explicit_edges=()
declare -a explicit_routes=()
while (($#)); do
  case "$1" in
    --suite)
      [[ $# -ge 2 ]] || { printf '%s\n' '--suite requires a value' >&2; exit 2; }
      suite="$2"
      shift 2
      ;;
    --edge)
      [[ $# -ge 2 ]] || { printf '%s\n' '--edge requires a value' >&2; exit 2; }
      explicit_edges+=("$2")
      shift 2
      ;;
    --route)
      [[ $# -ge 2 ]] || { printf '%s\n' '--route requires a value' >&2; exit 2; }
      explicit_routes+=("$2")
      shift 2
      ;;
    --list) list_only=1; shift ;;
    --skip-build) skip_build=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

readonly -a PR_EDGES=(
  'wasmtime:wasmtime'
  'wasmtime:node'
  'node:wazero'
  'wazero:wasmtime'
)
readonly -a NATIVE_EDGES=(
  'wasmtime:wasmtime' 'wasmtime:node' 'wasmtime:wazero'
  'node:wasmtime'     'node:node'     'node:wazero'
  'wazero:wasmtime'   'wazero:node'   'wazero:wazero'
)
readonly -a WAMR_EDGES=(
  'wamr:wamr'
  'wasmtime:wamr' 'wamr:wasmtime'
  'node:wamr'     'wamr:node'
  'wazero:wamr'   'wamr:wazero'
)
readonly -a NATIVE_ROUTES=('wasmtime:node:wazero')
readonly -a PR_ROUTES=(
  'wasmtime:node:wasmtime'
  "${NATIVE_ROUTES[@]}"
)

declare -a edges=()
declare -a routes=()
edge_count=0
route_count=0
if ((${#explicit_edges[@]} + ${#explicit_routes[@]})); then
  if ((${#explicit_edges[@]})); then
    edges=("${explicit_edges[@]}")
    edge_count=${#explicit_edges[@]}
  fi
  if ((${#explicit_routes[@]})); then
    routes=("${explicit_routes[@]}")
    route_count=${#explicit_routes[@]}
  fi
else
  case "$suite" in
    pr) edges=("${PR_EDGES[@]}"); edge_count=${#PR_EDGES[@]}; routes=("${PR_ROUTES[@]}"); route_count=${#PR_ROUTES[@]} ;;
    native) edges=("${NATIVE_EDGES[@]}"); edge_count=${#NATIVE_EDGES[@]}; routes=("${NATIVE_ROUTES[@]}"); route_count=${#NATIVE_ROUTES[@]} ;;
    wamr) edges=("${WAMR_EDGES[@]}"); edge_count=${#WAMR_EDGES[@]} ;;
    all) edges=("${NATIVE_EDGES[@]}" "${WAMR_EDGES[@]}"); edge_count=$(( ${#NATIVE_EDGES[@]} + ${#WAMR_EDGES[@]} )); routes=("${NATIVE_ROUTES[@]}"); route_count=${#NATIVE_ROUTES[@]} ;;
    *) printf 'unknown suite: %s\n' "$suite" >&2; usage >&2; exit 2 ;;
  esac
fi

valid_runtime() {
  case "$1" in wasmtime|node|wazero|wamr) return 0 ;; *) return 1 ;; esac
}

mark_runtime_needed() {
  case "$1" in
    node) needs_node=1 ;;
    wazero) needs_wazero=1 ;;
    wamr) needs_wamr=1 ;;
  esac
}

needs_node=0
needs_wazero=0
needs_wamr=0
for ((edge_index = 0; edge_index < edge_count; edge_index++)); do
  edge="${edges[$edge_index]}"
  if [[ "$edge" != *:* ]]; then
    printf 'invalid edge (expected SRC:DST): %s\n' "$edge" >&2
    exit 2
  fi
  src="${edge%%:*}"
  dst="${edge#*:}"
  if ! valid_runtime "$src" || ! valid_runtime "$dst"; then
    printf 'unknown runtime in edge: %s\n' "$edge" >&2
    exit 2
  fi
  mark_runtime_needed "$src"
  mark_runtime_needed "$dst"
done
for ((route_index = 0; route_index < route_count; route_index++)); do
  route="${routes[$route_index]}"
  IFS=: read -r -a route_runtimes <<< "$route"
  if ((${#route_runtimes[@]} < 3)); then
    printf 'invalid route (expected at least A:B:C): %s\n' "$route" >&2
    exit 2
  fi
  for runtime in "${route_runtimes[@]}"; do
    if ! valid_runtime "$runtime"; then
      printf 'unknown runtime in route: %s\n' "$route" >&2
      exit 2
    fi
    mark_runtime_needed "$runtime"
  done
done

if ((list_only)); then
  for ((edge_index = 0; edge_index < edge_count; edge_index++)); do printf 'edge %s\n' "${edges[$edge_index]}"; done
  for ((route_index = 0; route_index < route_count; route_index++)); do printf 'route %s\n' "${routes[$route_index]}"; done
  exit 0
fi

weave_ci_reexec_awake "$ROOT/.github/ci/conformance.sh" "${ORIGINAL_ARGS[@]}"

created_artifacts=0
if [[ -n "${WEAVE_CI_ARTIFACT_DIR:-}" ]]; then
  ARTIFACT_DIR="$WEAVE_CI_ARTIFACT_DIR"
  mkdir -p "$ARTIFACT_DIR"
else
  ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/weave-conformance.XXXXXX")"
  created_artifacts=1
fi
mkdir -p "$ARTIFACT_DIR/bin" "$ARTIFACT_DIR/cases"

readonly ITERATIONS="${WEAVE_CI_ITERATIONS:-200000000}"
readonly MIGRATE_AFTER_EVENTS="${WEAVE_CI_MIGRATE_AFTER_EVENTS:-2}"
readonly TIMEOUT_SECONDS="${WEAVE_CI_TIMEOUT_SECONDS:-180}"
readonly STATUS_TIMEOUT_SECONDS="${WEAVE_CI_STATUS_TIMEOUT_SECONDS:-5}"
readonly FIXTURE="${WEAVE_CI_FIXTURE:-guests/counter.wat}"
readonly ENTRY="${WEAVE_CI_ENTRY:-run}"
readonly ENTRY_ARG="${WEAVE_CI_ARG:-$ITERATIONS}"
readonly POLL_PERIOD="${WEAVE_CI_POLL_PERIOD:-64}"
readonly ROOT_CARGO_TARGET="${CARGO_TARGET_DIR:-$ROOT/target}"
readonly WAMR_CARGO_TARGET="${CARGO_TARGET_DIR:-$ROOT/wamr/target}"
readonly WEAVE_BIN="${WEAVE_BIN:-$ROOT_CARGO_TARGET/release/weave}"
readonly NODE_BIN="${NODE_BIN:-node}"
readonly NODE_RUNNER="$ROOT/js/weave-node.mjs"
readonly WAZERO_BIN="${WEAVE_WAZERO_BIN:-$ARTIFACT_DIR/bin/weave-wazero}"
readonly WAMR_BIN="${WEAVE_WAMR_BIN:-$WAMR_CARGO_TARGET/release/weave-wamr}"
readonly WOVEN="$ARTIFACT_DIR/fixture.woven.wasm"
readonly GOLDEN="$ARTIFACT_DIR/golden.events"
readonly TIMEOUT_RUN="$ROOT/.github/ci/with-timeout.sh"
readonly WAIT_FOR="$ROOT/.github/ci/wait-for.sh"

declare -a MIGRATE_AFTER_BY_HOP=()
if [[ -n "${WEAVE_CI_MIGRATE_AFTER_EVENTS_BY_HOP:-}" ]]; then
  IFS=, read -r -a MIGRATE_AFTER_BY_HOP <<< "$WEAVE_CI_MIGRATE_AFTER_EVENTS_BY_HOP"
  for threshold in "${MIGRATE_AFTER_BY_HOP[@]}"; do
    [[ "$threshold" =~ ^[0-9]+$ ]] || {
      printf 'invalid per-hop migration threshold: %s\n' "$threshold" >&2
      exit 2
    }
  done
fi

declare -a active_pids=()
cleanup_processes() {
  local pid
  for pid in "${active_pids[@]:-}"; do
    [[ -n "$pid" ]] || continue
    terminate_pid "$pid"
  done
  active_pids=()
}

forget_pid() {
  local forgotten="$1" pid
  local -a retained=()
  for pid in "${active_pids[@]:-}"; do
    [[ "$pid" == "$forgotten" ]] || retained+=("$pid")
  done
  if ((${#retained[@]})); then
    active_pids=("${retained[@]}")
  else
    active_pids=()
  fi
}

terminate_pid() {
  local pid="$1" attempts=0
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" 2>/dev/null || true
    forget_pid "$pid"
    return
  fi
  kill "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null && ((attempts < 20)); do
    sleep 0.05
    attempts=$((attempts + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
  wait "$pid" 2>/dev/null || true
  forget_pid "$pid"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  cleanup_processes
  if ((created_artifacts)) && ((status == 0)) && [[ "${WEAVE_CI_KEEP_TEMP:-0}" != 1 ]]; then
    rm -rf -- "$ARTIFACT_DIR"
  elif ((created_artifacts)); then
    printf 'retained conformance artifacts: %s\n' "$ARTIFACT_DIR"
  fi
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'required command is unavailable: %s\n' "$1" >&2
    exit 1
  }
}

require_command cargo
require_command python3
if ((needs_wazero)); then require_command go; fi
if ((needs_node)); then require_command "$NODE_BIN"; fi
if ((needs_wamr)) && [[ -z "${WAMR_ROOT:-}" ]]; then
  printf '%s\n' 'WAMR_ROOT is required for the selected conformance edges' >&2
  exit 1
fi

if ((!skip_build)); then
  cargo build --locked --release -p weave-cli
  if ((needs_wazero)); then
    (
      cd go/weave-wazero
      go build -mod=readonly -o "$WAZERO_BIN" .
    )
  fi
  if ((needs_wamr)); then
    WAMR_ROOT="$WAMR_ROOT" cargo build --locked --release --manifest-path wamr/Cargo.toml
  fi
fi

[[ -x "$WEAVE_BIN" ]] || { printf 'missing executable: %s\n' "$WEAVE_BIN" >&2; exit 1; }
if ((needs_wazero)); then
  [[ -x "$WAZERO_BIN" ]] || { printf 'missing executable: %s\n' "$WAZERO_BIN" >&2; exit 1; }
fi
if ((needs_wamr)); then
  [[ -x "$WAMR_BIN" ]] || { printf 'missing executable: %s\n' "$WAMR_BIN" >&2; exit 1; }
fi

[[ -f "$FIXTURE" ]] || { printf 'fixture does not exist: %s\n' "$FIXTURE" >&2; exit 1; }
"$WEAVE_BIN" transform "$FIXTURE" -o "$WOVEN" --period "$POLL_PERIOD"
"$TIMEOUT_RUN" "$TIMEOUT_SECONDS" "$WEAVE_BIN" run "$WOVEN" \
  --pre-woven --invoke "$ENTRY" --arg "$ENTRY_ARG" \
  | awk '/^(EMIT|WEAVE_DONE)/' > "$GOLDEN"
[[ -s "$GOLDEN" ]] || { printf '%s\n' 'golden event stream is empty' >&2; exit 1; }

{
  printf 'git_sha=%s\n' "$(git rev-parse HEAD 2>/dev/null || printf unknown)"
  printf 'suite=%s\n' "$suite"
  printf 'iterations=%s\n' "$ITERATIONS"
  printf 'fixture=%s\n' "$FIXTURE"
  printf 'entry=%s\n' "$ENTRY"
  printf 'entry_arg=%s\n' "$ENTRY_ARG"
  printf 'migrate_after_events=%s\n' "$MIGRATE_AFTER_EVENTS"
  printf 'migrate_after_events_by_hop=%s\n' "${WEAVE_CI_MIGRATE_AFTER_EVENTS_BY_HOP:-}"
  printf 'poll_period=%s\n' "$POLL_PERIOD"
  printf 'timeout_seconds=%s\n' "$TIMEOUT_SECONDS"
  printf 'status_timeout_seconds=%s\n' "$STATUS_TIMEOUT_SECONDS"
  printf 'weave_bin=%s\n' "$WEAVE_BIN"
  if ((needs_node)); then printf 'node_bin=%s\n' "$NODE_BIN"; fi
  if ((needs_wazero)); then printf 'wazero_bin=%s\n' "$WAZERO_BIN"; fi
  if ((needs_wamr)); then printf 'wamr_bin=%s\n' "$WAMR_BIN"; fi
  printf 'runner_image_os=%s\n' "${ImageOS:-local}"
  printf 'runner_image_version=%s\n' "${ImageVersion:-local}"
  printf 'awake_guard_mode=%s\n' "${WEAVE_CI_AWAKE_MODE:-unknown}"
  printf 'uname=%s\n' "$(uname -a)"
  rustc --version
  cargo --version
  if ((needs_node)); then "$NODE_BIN" --version; fi
  if ((needs_wazero)); then go version; fi
  if ((needs_wamr)); then git -C "$WAMR_ROOT" rev-parse HEAD; fi
  printf 'edges:\n'
  for ((edge_index = 0; edge_index < edge_count; edge_index++)); do printf '  %s\n' "${edges[$edge_index]}"; done
  printf 'routes:\n'
  for ((route_index = 0; route_index < route_count; route_index++)); do printf '  %s\n' "${routes[$route_index]}"; done
} > "$ARTIFACT_DIR/manifest.txt"

start_node() {
  local runtime="$1" role="$2" address="$3" stdout="$4" stderr="$5"
  local -a common=(serve --listen "$address" --exit-on-done)
  local -a work=(--module "$WOVEN" --invoke "$ENTRY" --arg "$ENTRY_ARG")
  case "$runtime:$role" in
    wasmtime:target) "$WEAVE_BIN" "${common[@]}" >"$stdout" 2>"$stderr" & ;;
    wasmtime:source) "$WEAVE_BIN" "${common[@]}" "${work[@]}" --pre-woven >"$stdout" 2>"$stderr" & ;;
    node:target) "$NODE_BIN" "$NODE_RUNNER" "${common[@]}" >"$stdout" 2>"$stderr" & ;;
    node:source) "$NODE_BIN" "$NODE_RUNNER" "${common[@]}" "${work[@]}" >"$stdout" 2>"$stderr" & ;;
    wazero:target) "$WAZERO_BIN" "${common[@]}" >"$stdout" 2>"$stderr" & ;;
    wazero:source) "$WAZERO_BIN" "${common[@]}" "${work[@]}" >"$stdout" 2>"$stderr" & ;;
    wamr:target) "$WAMR_BIN" "${common[@]}" >"$stdout" 2>"$stderr" & ;;
    wamr:source) "$WAMR_BIN" "${common[@]}" "${work[@]}" >"$stdout" 2>"$stderr" & ;;
    *) printf 'cannot start %s as %s\n' "$runtime" "$role" >&2; return 2 ;;
  esac
  STARTED_PID=$!
  active_pids+=("$STARTED_PID")
}

wait_for_status() {
  local address="$1" expected="$2" label="$3"
  local output='' status=0
  if output="$("$WAIT_FOR" "$TIMEOUT_SECONDS" output-contains "$expected" \
    "$TIMEOUT_RUN" "$STATUS_TIMEOUT_SECONDS" "$WEAVE_BIN" status --node "$address")"; then
    return 0
  else
    status=$?
  fi
  printf 'timed out waiting for %s at %s (last status: %s)\n' "$label" "$address" "$output" >&2
  return "$status"
}

wait_for_pid() {
  local pid="$1" label="$2" status=0
  if ! "$WAIT_FOR" "$TIMEOUT_SECONDS" process "$pid"; then
    printf 'timed out waiting for %s (pid %s; active timeout %ss)\n' \
      "$label" "$pid" "$TIMEOUT_SECONDS" >&2
    terminate_pid "$pid"
    return 1
  fi
  wait "$pid" || status=$?
  forget_pid "$pid"
  return "$status"
}

wait_for_events() {
  local file="$1" minimum="$2" label="$3" count=0 status=0
  if count="$("$WAIT_FOR" "$TIMEOUT_SECONDS" matching-lines \
    "$file" "$minimum" '^EMIT(32|64)? ')"; then
    return 0
  else
    status=$?
  fi
  printf 'timed out waiting for %s to emit %s events (saw %s)\n' "$label" "$minimum" "$count" >&2
  return "$status"
}

allocate_ports() {
  python3 - "$1" <<'PY'
import socket
import sys

sockets = []
try:
    for _ in range(int(sys.argv[1])):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        sockets.append(sock)
    print(*(sock.getsockname()[1] for sock in sockets))
finally:
    for sock in sockets:
        sock.close()
PY
}

case_index=0
run_route() {
  local route="$1"
  local -a runtimes addresses pids stdout_files stderr_files ports
  local runtime name case_dir i current next control_file control_pid replay_selector threshold
  IFS=: read -r -a runtimes <<< "$route"

  case_index=$((case_index + 1))
  name="${case_index}-${route//:/-to-}"
  case_dir="$ARTIFACT_DIR/cases/$name"
  mkdir -p "$case_dir"

  read -r -a ports < <(allocate_ports "${#runtimes[@]}")
  for ((i = 0; i < ${#runtimes[@]}; i++)); do
    addresses+=("127.0.0.1:${ports[$i]}")
    stdout_files+=("$case_dir/hop-$i-${runtimes[$i]}.stdout")
    stderr_files+=("$case_dir/hop-$i-${runtimes[$i]}.stderr")
  done

  if ((${#runtimes[@]} == 2)); then replay_selector=--edge; else replay_selector=--route; fi
  {
    printf 'route=%s\n' "$route"
    printf 'fixture=%s\n' "$FIXTURE"
    printf 'entry=%s\n' "$ENTRY"
    printf 'entry_arg=%s\n' "$ENTRY_ARG"
    printf 'migrate_after_events=%s\n' "$MIGRATE_AFTER_EVENTS"
    printf 'migrate_after_events_by_hop=%s\n' "${WEAVE_CI_MIGRATE_AFTER_EVENTS_BY_HOP:-}"
    printf 'poll_period=%s\n' "$POLL_PERIOD"
    printf 'replay_command='
    printf 'WEAVE_CI_FIXTURE=%q WEAVE_CI_ENTRY=%q WEAVE_CI_ARG=%q ' "$FIXTURE" "$ENTRY" "$ENTRY_ARG"
    printf 'WEAVE_CI_MIGRATE_AFTER_EVENTS=%q ' "$MIGRATE_AFTER_EVENTS"
    if [[ -n "${WEAVE_CI_MIGRATE_AFTER_EVENTS_BY_HOP:-}" ]]; then
      printf 'WEAVE_CI_MIGRATE_AFTER_EVENTS_BY_HOP=%q ' "$WEAVE_CI_MIGRATE_AFTER_EVENTS_BY_HOP"
    fi
    printf '.github/ci/conformance.sh %s %q\n' "$replay_selector" "$route"
    for ((i = 0; i < ${#runtimes[@]}; i++)); do
      printf 'hop_%s=%s@%s\n' "$i" "${runtimes[$i]}" "${addresses[$i]}"
    done
  } > "$case_dir/manifest.txt"

  printf '\n== %s ==\n' "${route//:/ -> }"
  for ((i = 1; i < ${#runtimes[@]}; i++)); do
    runtime="${runtimes[$i]}"
    start_node "$runtime" target "${addresses[$i]}" "${stdout_files[$i]}" "${stderr_files[$i]}"
    pids[$i]="$STARTED_PID"
    wait_for_status "${addresses[$i]}" 'idle' "$runtime target" || {
      sed -n '1,160p' "${stderr_files[$i]}" >&2
      return 1
    }
  done

  start_node "${runtimes[0]}" source "${addresses[0]}" "${stdout_files[0]}" "${stderr_files[0]}"
  pids[0]="$STARTED_PID"
  wait_for_status "${addresses[0]}" 'running' "${runtimes[0]} source" || {
    sed -n '1,160p' "${stderr_files[0]}" >&2
    return 1
  }

  for ((i = 0; i < ${#runtimes[@]} - 1; i++)); do
    current="${runtimes[$i]}"
    next="${runtimes[$((i + 1))]}"
    if ((i > 0)); then
      wait_for_status "${addresses[$i]}" 'running' "$current intermediate" || {
        sed -n '1,200p' "${stderr_files[$i]}" >&2
        return 1
      }
    fi
    threshold="$MIGRATE_AFTER_EVENTS"
    if ((i < ${#MIGRATE_AFTER_BY_HOP[@]})); then threshold="${MIGRATE_AFTER_BY_HOP[$i]}"; fi
    wait_for_events "${stdout_files[$i]}" "$threshold" "$current source hop" || {
      sed -n '1,200p' "${stderr_files[$i]}" >&2
      return 1
    }

    control_file="$case_dir/control-$i-${current}-to-${next}"
    # These nodes deliberately exit on completion; use the synchronous legacy
    # reply. Recoverable structured operation polling is qualified separately
    # against persistent nodes by control-interface.mjs.
    "$WEAVE_BIN" migrate --legacy --node "${addresses[$i]}" --to "${addresses[$((i + 1))]}" \
      >"$control_file.stdout" 2>"$control_file.stderr" &
    control_pid=$!
    active_pids+=("$control_pid")
    if ! wait_for_pid "$control_pid" "$current -> $next migration control"; then
      printf 'migration control failed for %s -> %s in route %s\n' "$current" "$next" "$route" >&2
      sed -n '1,200p' "$control_file.stderr" >&2
      sed -n '1,200p' "${stderr_files[$i]}" >&2
      sed -n '1,200p' "${stderr_files[$((i + 1))]}" >&2
      return 1
    fi
    grep -q '^ok: migrated' "$control_file.stdout" || {
      printf 'migration did not report success for %s -> %s\n' "$current" "$next" >&2
      sed -n '1,200p' "$control_file.stdout" >&2
      return 1
    }
    wait_for_pid "${pids[$i]}" "$current source hop" || {
      sed -n '1,200p' "${stderr_files[$i]}" >&2
      return 1
    }
  done

  i=$((${#runtimes[@]} - 1))
  wait_for_pid "${pids[$i]}" "${runtimes[$i]} final target" || {
    sed -n '1,200p' "${stderr_files[$i]}" >&2
    return 1
  }

  awk '/^(EMIT|WEAVE_DONE)/' "${stdout_files[@]}" > "$case_dir/combined.events"
  if ! diff -u "$GOLDEN" "$case_dir/combined.events" > "$case_dir/events.diff"; then
    printf 'event stream diverged for route %s\n' "$route" >&2
    sed -n '1,240p' "$case_dir/events.diff" >&2
    return 1
  fi
  rm -f "$case_dir/events.diff"
  printf 'PASS %s (%s events)\n' "$route" "$(wc -l < "$case_dir/combined.events" | tr -d ' ')"
  }

for ((edge_index = 0; edge_index < edge_count; edge_index++)); do run_route "${edges[$edge_index]}"; done
for ((route_index = 0; route_index < route_count; route_index++)); do run_route "${routes[$route_index]}"; done

printf '\nPASS: %s conformance case(s) matched the golden event stream\n' "$((edge_count + route_count))"
if ((created_artifacts)) && [[ "${WEAVE_CI_KEEP_TEMP:-0}" != 1 ]]; then
  printf 'artifacts: %s (temporary; removed after success)\n' "$ARTIFACT_DIR"
else
  printf 'artifacts: %s\n' "$ARTIFACT_DIR"
fi
