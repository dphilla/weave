#!/usr/bin/env bash
# Central entry point for language-level CI checks. Keep workflow YAML thin:
# every command here is intended to be runnable from a developer checkout.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
NODE_BIN="${NODE_BIN:-node}"

usage() {
  cat <<'EOF'
usage: .github/ci/run-unit.sh rust|rust-quality|js|go|all

  rust          build and test the root Rust workspace
  rust-quality  report rustfmt/clippy status (advisory until the baseline is clean)
  js            run Node and browser-transport unit tests
  go            format-check, vet, test, and build the wazero adapter
  all           run rust, js, and go sequentially
EOF
}

run_rust() {
  cargo test --workspace --all-targets --locked
  cargo build --workspace --locked --release
}

run_rust_quality() {
  local status=0
  cargo fmt --all --check || status=1
  cargo fmt --manifest-path wamr/Cargo.toml --all --check || status=1
  cargo clippy --workspace --all-targets --locked -- -D warnings || status=1
  return "$status"
}

run_js() {
  "$NODE_BIN" --test js/*.test.mjs demos/*/*.test.mjs
}

run_go() {
  local unformatted build_dir
  unformatted="$(gofmt -l go/weave-wazero/*.go)"
  if [[ -n "$unformatted" ]]; then
    printf 'gofmt is required for:\n%s\n' "$unformatted" >&2
    return 1
  fi
  (
    cd go/weave-wazero
    go vet -mod=readonly ./...
    if [[ "${WEAVE_CI_GO_RACE:-0}" == 1 ]]; then
      go test -mod=readonly -race -count=1 ./...
    else
      go test -mod=readonly -count=1 ./...
    fi
    build_dir="$(mktemp -d "${TMPDIR:-/tmp}/weave-go-build.XXXXXX")"
    trap 'rm -rf -- "$build_dir"' EXIT
    go build -mod=readonly -o "$build_dir/weave-wazero" .
  )
}

case "${1:-}" in
  rust) run_rust ;;
  rust-quality) run_rust_quality ;;
  js) run_js ;;
  go) run_go ;;
  all)
    run_rust
    run_js
    run_go
    ;;
  -h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
