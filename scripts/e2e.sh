#!/usr/bin/env bash
# Backward-compatible developer entry point. CI dependencies and process
# orchestration live in .github/ci; keep this source-tree shim intentionally
# dependency-free.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT/.github/ci/native-e2e.sh" "$@"
