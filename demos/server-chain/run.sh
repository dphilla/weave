#!/usr/bin/env bash
# User-facing wrapper around the single centralized conformance orchestrator.
# It adds no runtime or CI logic of its own.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

has_selector=0
read_only=0
for argument in "$@"; do
  case "$argument" in --route|--edge|--suite) has_selector=1 ;; esac
  case "$argument" in --list|--help|-h) read_only=1 ;; esac
done

declare -a selector=()
if ((has_selector)); then
  selector=("$@")
else
  selector=(--route wasmtime:node:wazero "$@")
fi

if ((read_only)); then
  exec .github/ci/conformance.sh "${selector[@]}"
fi

ARTIFACT_ROOT="${WEAVE_DEMO_ARTIFACT_ROOT:-$ROOT/target/demo-artifacts/server-chain}"
if [[ "$ARTIFACT_ROOT" != /* ]]; then ARTIFACT_ROOT="$ROOT/$ARTIFACT_ROOT"; fi
ARTIFACT_DIR="$ARTIFACT_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
printf 'server-chain artifacts: %s\n' "$ARTIFACT_DIR"
WEAVE_CI_ARTIFACT_DIR="$ARTIFACT_DIR" exec .github/ci/conformance.sh "${selector[@]}"
