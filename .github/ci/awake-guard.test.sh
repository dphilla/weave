#!/usr/bin/env bash
# Isolated selection, argv, and bypass checks for the local awake guard.

set -euo pipefail

# A parent qualification run may already be wrapped or explicitly opt out.
# Each isolated scenario below must control its own awake-guard settings.
unset WEAVE_CI_AWAKE_WRAPPED WEAVE_CI_AWAKE_MODE WEAVE_CI_PREVENT_SLEEP

# Bash 3.2 can continue after a failed bare [[ ... ]] despite set -e.
# Exit explicitly so these checks fail consistently on macOS and Linux.
assert_equal() {
  local actual="$1" expected="$2" description="$3"
  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL awake guard: %s; expected <%s>, got <%s>\n' \
      "$description" "$expected" "$actual" >&2
    exit 1
  fi
}

assert_missing() {
  local file="$1" description="$2"
  if [[ -e "$file" ]]; then
    printf 'FAIL awake guard: %s; unexpected file <%s>\n' \
      "$description" "$file" >&2
    exit 1
  fi
}

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
[[ "${1:-}" == -i && "${2:-}" == -s ]] || {
  printf '%s\n' 'FAIL awake guard: caffeinate must receive -i -s' >&2
  exit 91
}
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
assert_equal "$output" '1|caffeinate-is|argument with spaces' 'wrapper environment and argument preservation'
assert_equal "$(sed -n '1p' "$log")" -i 'idle-sleep inhibitor argument'
assert_equal "$(sed -n '2p' "$log")" -s 'system-sleep inhibitor argument'
assert_equal "$(sed -n '3p' "$log")" bash 'wrapped command'

rm -f "$log"
output="$(
  PATH="$test_path" WEAVE_TEST_UNAME=Darwin WEAVE_TEST_CAFFEINATE_LOG="$log" \
    WEAVE_CI_PREVENT_SLEEP=0 \
    bash -c 'source "$1"; weave_ci_reexec_awake true; printf "%s\n" "$WEAVE_CI_AWAKE_MODE"' bash "$GUARD"
)"
assert_equal "$output" disabled 'explicit opt-out mode'
assert_missing "$log" 'explicit opt-out must not invoke caffeinate'

output="$(
  PATH="$test_path" WEAVE_TEST_UNAME=Linux WEAVE_TEST_CAFFEINATE_LOG="$log" \
    bash -c 'source "$1"; weave_ci_reexec_awake true; printf "%s\n" "$WEAVE_CI_AWAKE_MODE"' bash "$GUARD"
)"
assert_equal "$output" not-needed 'non-macOS mode'
assert_missing "$log" 'non-macOS hosts must not invoke caffeinate'

output="$(
  PATH="$test_path" WEAVE_TEST_UNAME=Darwin WEAVE_TEST_CAFFEINATE_LOG="$log" \
    WEAVE_CI_AWAKE_WRAPPED=1 \
    bash -c 'source "$1"; weave_ci_reexec_awake true; printf "%s\n" guarded' bash "$GUARD"
)"
assert_equal "$output" guarded 'already-wrapped bypass output'
assert_missing "$log" 'already-wrapped commands must not invoke caffeinate again'

status=0
PATH="$test_path" WEAVE_TEST_UNAME=Darwin WEAVE_TEST_CAFFEINATE_LOG="$log" \
  bash -c 'source "$1"; shift; weave_ci_reexec_awake "$@"' \
  bash "$GUARD" bash -c 'exit 23' || status=$?
assert_equal "$status" 23 'wrapped command exit-status propagation'

printf '%s\n' 'PASS awake guard selection, argv, bypass, and status propagation'
