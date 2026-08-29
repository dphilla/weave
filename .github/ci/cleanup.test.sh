#!/usr/bin/env bash
# Isolated safety and behavior checks for cleanup.sh.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
CLEANUP="$ROOT/.github/ci/cleanup.sh"
TEST_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/weave-cleanup-test.XXXXXX")"
TEST_ROOT="$TEST_PARENT/repo with spaces"
TEST_TEMP="$TEST_PARENT/tmp with spaces"
OUTSIDE="$TEST_PARENT/outside"

cleanup_test_data() {
  rm -rf -- "$TEST_PARENT"
}
trap cleanup_test_data EXIT INT TERM

reset_fixture() {
  rm -rf -- "$TEST_ROOT" "$TEST_TEMP" "$OUTSIDE"
  mkdir -p "$TEST_ROOT/demos/browser-wamr" "$TEST_ROOT/wamr" "$TEST_TEMP" "$OUTSIDE"
}

run_cleanup() {
  WEAVE_CLEANUP_TESTING=1 \
  WEAVE_CLEANUP_TEST_ROOT="$TEST_ROOT" \
  WEAVE_CLEANUP_TEST_TMPDIR="$TEST_TEMP" \
    "$CLEANUP" "$@"
}

assert_exists() {
  [[ -e "$1" || -L "$1" ]] || { printf 'expected path to exist: %s\n' "$1" >&2; exit 1; }
}

assert_absent() {
  [[ ! -e "$1" && ! -L "$1" ]] || { printf 'expected path to be absent: %s\n' "$1" >&2; exit 1; }
}

# Default cleanup is intentionally narrower than either build or temp cleanup.
reset_fixture
mkdir -p "$TEST_ROOT/target/demo-artifacts/run" "$TEST_ROOT/target/keep" "$TEST_ROOT/wamr/target"
printf 'demo\n' > "$TEST_ROOT/target/demo-artifacts/run/result.txt"
printf 'wasm\n' > "$TEST_ROOT/counter.woven.wasm"
printf 'wasm\n' > "$TEST_ROOT/demos/browser-wamr/counter.woven.wasm"
printf 'source\n' > "$TEST_ROOT/untracked-not-an-artifact.md"
mkdir -p "$TEST_TEMP/weave-conformance.abc123"
run_cleanup >/dev/null
assert_absent "$TEST_ROOT/target/demo-artifacts"
assert_absent "$TEST_ROOT/counter.woven.wasm"
assert_absent "$TEST_ROOT/demos/browser-wamr/counter.woven.wasm"
assert_exists "$TEST_ROOT/target/keep"
assert_exists "$TEST_ROOT/wamr/target"
assert_exists "$TEST_ROOT/untracked-not-an-artifact.md"
assert_exists "$TEST_TEMP/weave-conformance.abc123"

# Dry-run reports every selected class but mutates nothing.
reset_fixture
mkdir -p "$TEST_ROOT/target/demo-artifacts" "$TEST_ROOT/wamr/target" \
  "$TEST_TEMP/weave-browser-smoke.abc123"
printf 'wasm\n' > "$TEST_ROOT/demos/browser-wamr/counter.woven.wasm"
printf 'wasm\n' > "$TEST_ROOT/counter.woven.wasm"
dry_output="$(run_cleanup --dry-run --all)"
[[ "$dry_output" == *'would remove demo artifact'* ]]
[[ "$dry_output" == *'would remove temporary'* ]]
[[ "$dry_output" == *'would remove build cache'* ]]
assert_exists "$TEST_ROOT/target/demo-artifacts"
assert_exists "$TEST_ROOT/wamr/target"
assert_exists "$TEST_ROOT/demos/browser-wamr/counter.woven.wasm"
assert_exists "$TEST_ROOT/counter.woven.wasm"
assert_exists "$TEST_TEMP/weave-browser-smoke.abc123"

# --temp accepts only the exact historical direct-child prefixes.
reset_fixture
allowed_names=(
  weave-conformance.abc123
  weave-browser-peer.abc123
  weave-browser-peer-abc123
  weave-browser-smoke.abc123
  weave-checkpoint.abc123
  weave-native-e2e.abc123
  weave-rust-guest.abc123
  weave-spec-corpus.abc123
  weave-adversity
  weave-adversity.abc123
  weave-qualification
  weave-qualification.abc123
  weave-go-build.abc123
  weave-wamr-prepare.abc123
  weave-wasm-tools-prepare.abc123
  weave-artifact-lifecycle-test.abc123
  weave-cleanup-test.abc123
  weave-chrome-smoke-abc123
  weave-webrtc-server-test-abc123
)
for name in "${allowed_names[@]}"; do mkdir -p "$TEST_TEMP/$name"; done
mkdir -p "$TEST_TEMP/weave-conformance" "$TEST_TEMP/weave-unrelated.abc123" \
  "$TEST_TEMP/container/weave-conformance.nested"
printf 'not a harness directory\n' > "$TEST_TEMP/weave-conformance.regular-file"
run_cleanup --temp >/dev/null
for name in "${allowed_names[@]}"; do assert_absent "$TEST_TEMP/$name"; done
assert_exists "$TEST_TEMP/weave-conformance"
assert_exists "$TEST_TEMP/weave-unrelated.abc123"
assert_exists "$TEST_TEMP/container/weave-conformance.nested"
assert_exists "$TEST_TEMP/weave-conformance.regular-file"

# --builds removes only the two exact cache trees, leaving other source and
# nested tracked-looking files untouched.
reset_fixture
mkdir -p "$TEST_ROOT/target/cache" "$TEST_ROOT/wamr/target/cache" \
  "$TEST_ROOT/guests/mandel/target" "$TEST_ROOT/go/weave-wazero"
printf 'tracked\n' > "$TEST_ROOT/guests/mandel/target/CACHEDIR.TAG"
printf 'tracked binary\n' > "$TEST_ROOT/go/weave-wazero/weave-wazero"
printf 'source\n' > "$TEST_ROOT/README.md"
run_cleanup --builds >/dev/null
assert_absent "$TEST_ROOT/target"
assert_absent "$TEST_ROOT/wamr/target"
assert_exists "$TEST_ROOT/guests/mandel/target/CACHEDIR.TAG"
assert_exists "$TEST_ROOT/go/weave-wazero/weave-wazero"
assert_exists "$TEST_ROOT/README.md"

# Coincidentally named regular files are not build or artifact directories.
reset_fixture
printf 'not a directory\n' > "$TEST_ROOT/target"
if run_cleanup --builds >/dev/null 2>&1; then
  printf '%s\n' 'cleanup unexpectedly accepted a regular file as a build tree' >&2
  exit 1
fi
assert_exists "$TEST_ROOT/target"

# Repo and temporary symlinks are rejected and their external targets survive.
reset_fixture
mkdir -p "$OUTSIDE/demo" "$OUTSIDE/temp"
printf 'keep\n' > "$OUTSIDE/demo/data"
printf 'keep\n' > "$OUTSIDE/temp/data"
mkdir -p "$TEST_ROOT/target"
ln -s "$OUTSIDE/demo" "$TEST_ROOT/target/demo-artifacts"
if run_cleanup >/dev/null 2>&1; then
  printf '%s\n' 'cleanup unexpectedly accepted a repo artifact symlink' >&2
  exit 1
fi
assert_exists "$TEST_ROOT/target/demo-artifacts"
assert_exists "$OUTSIDE/demo/data"
ln -s "$OUTSIDE/temp" "$TEST_TEMP/weave-conformance.symlink"
if run_cleanup --temp >/dev/null 2>&1; then
  printf '%s\n' 'cleanup unexpectedly accepted a temporary symlink' >&2
  exit 1
fi
assert_exists "$TEST_TEMP/weave-conformance.symlink"
assert_exists "$OUTSIDE/temp/data"

# Test-only root substitution cannot be activated accidentally.
if WEAVE_CLEANUP_TEST_ROOT="$TEST_ROOT" WEAVE_CLEANUP_TEST_TMPDIR="$TEST_TEMP" \
  "$CLEANUP" --dry-run >/dev/null 2>&1; then
  printf '%s\n' 'cleanup accepted ungated test-root overrides' >&2
  exit 1
fi

# The convenience shim is dependency-free and delegates argument parsing.
"$ROOT/scripts/cleanup.sh" --help >/dev/null

printf '%s\n' 'PASS cleanup command safety and scope'
