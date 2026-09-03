#!/usr/bin/env bash
# Isolated selection, argv, and bypass checks for the local awake guard.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD="$ROOT/.github/ci/awake-guard.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/weave-awake-guard-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT INT TERM
mkdir -p "$TEST_ROOT/bin"

cat > "$TEST_ROOT/bin/uname" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${WEAVE_TEST_UNAME:-Linux}"
EOF
cat > "$TEST_ROOT/bin/caffeinate" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$WEAVE_TEST_CAFFEINATE_LOG"
[[ "${1:-}" == -i && "${2:-}" == -s ]] || exit 91
shift 2
exec "$@"
EOF
chmod +x "$TEST_ROOT/bin/uname" "$TEST_ROOT/bin/caffeinate"

test_path="$TEST_ROOT/bin:$PATH"
log="$TEST_ROOT/caffeinate.log"

output="$(
  PATH="$test_path" WEAVE_TEST_UNAME=Darwin WEAVE_TEST_CAFFEINATE_LOG="$log" \
    bash -c 'source "$1"; shift; weave_ci_reexec_awake "$@"' \
    bash "$GUARD" bash -c 'printf "%s|%s|%s\n" "$WEAVE_CI_AWAKE_WRAPPED" "$WEAVE_CI_AWAKE_MODE" "$1"' bash 'argument with spaces'
)"
[[ "$output" == '1|caffeinate-is|argument with spaces' ]]
[[ "$(sed -n '1p' "$log")" == -i ]]
[[ "$(sed -n '2p' "$log")" == -s ]]
[[ "$(sed -n '3p' "$log")" == bash ]]

rm -f "$log"
output="$(
  PATH="$test_path" WEAVE_TEST_UNAME=Darwin WEAVE_TEST_CAFFEINATE_LOG="$log" \
    WEAVE_CI_PREVENT_SLEEP=0 \
    bash -c 'source "$1"; weave_ci_reexec_awake true; printf "%s\n" "$WEAVE_CI_AWAKE_MODE"' bash "$GUARD"
)"
[[ "$output" == disabled ]]
[[ ! -e "$log" ]]

output="$(
  PATH="$test_path" WEAVE_TEST_UNAME=Linux WEAVE_TEST_CAFFEINATE_LOG="$log" \
    bash -c 'source "$1"; weave_ci_reexec_awake true; printf "%s\n" "$WEAVE_CI_AWAKE_MODE"' bash "$GUARD"
)"
[[ "$output" == not-needed ]]
[[ ! -e "$log" ]]

output="$(
  PATH="$test_path" WEAVE_TEST_UNAME=Darwin WEAVE_TEST_CAFFEINATE_LOG="$log" \
    WEAVE_CI_AWAKE_WRAPPED=1 \
    bash -c 'source "$1"; weave_ci_reexec_awake true; printf guarded\n' bash "$GUARD"
)"
[[ "$output" == guarded ]]
[[ ! -e "$log" ]]

status=0
PATH="$test_path" WEAVE_TEST_UNAME=Darwin WEAVE_TEST_CAFFEINATE_LOG="$log" \
  bash -c 'source "$1"; shift; weave_ci_reexec_awake "$@"' \
  bash "$GUARD" bash -c 'exit 23' || status=$?
[[ "$status" == 23 ]]

printf '%s\n' 'PASS awake guard selection, argv, bypass, and status propagation'
