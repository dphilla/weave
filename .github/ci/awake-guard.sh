#!/usr/bin/env bash
# Shared macOS power assertion for long local CI entry points. Source this file
# and call weave_ci_reexec_awake with the entry point and its original argv.

weave_ci_reexec_awake() {
  [[ $# -ge 1 ]] || {
    printf '%s\n' 'weave_ci_reexec_awake requires COMMAND [ARG ...]' >&2
    return 2
  }

  if [[ "${WEAVE_CI_AWAKE_WRAPPED:-0}" == 1 ]]; then
    return 0
  fi
  if [[ "${WEAVE_CI_PREVENT_SLEEP:-1}" == 0 ]]; then
    export WEAVE_CI_AWAKE_MODE=disabled
    return 0
  fi
  if [[ "$(uname -s)" != Darwin ]]; then
    export WEAVE_CI_AWAKE_MODE=not-needed
    return 0
  fi
  if ! command -v caffeinate >/dev/null 2>&1; then
    export WEAVE_CI_AWAKE_MODE=unavailable
    printf '%s\n' 'warning: caffeinate is unavailable; suspend-safe deadlines remain active' >&2
    return 0
  fi

  export WEAVE_CI_AWAKE_WRAPPED=1
  export WEAVE_CI_AWAKE_MODE=caffeinate-is
  printf '%s\n' 'awake guard: preventing idle/system sleep while local CI runs' >&2
  exec caffeinate -i -s "$@"
}
