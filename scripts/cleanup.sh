#!/usr/bin/env bash
# Convenient developer entry point; cleanup policy stays in .github/ci.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec "$ROOT/.github/ci/cleanup.sh" "$@"
