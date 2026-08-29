#!/usr/bin/env bash
# Shared lifecycle for CI commands that create a default temporary artifact
# directory. Caller-provided artifact directories are always persistent.
# Default directories disappear after success and remain available on failure.

# This file is sourced by other scripts. Do not change the caller's shell
# options and do not install traps until weave_ci_artifacts_init is called.

weave_ci_artifacts_init() {
  if (($# != 2)); then
    printf '%s\n' 'weave_ci_artifacts_init requires PREFIX OUTPUT_VARIABLE' >&2
    return 2
  fi

  local prefix="$1"
  local output_variable="$2"
  case "$prefix" in
    ''|*[!A-Za-z0-9._-]*)
      printf 'invalid artifact prefix: %s\n' "$prefix" >&2
      return 2
      ;;
  esac
  if [[ ! "$output_variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    printf 'invalid artifact output variable: %s\n' "$output_variable" >&2
    return 2
  fi

  WEAVE_CI_ARTIFACTS_CREATED=0
  WEAVE_CI_ARTIFACTS_PREFIX="$prefix"
  WEAVE_CI_ARTIFACTS_CLEANED=0

  if [[ -n "${WEAVE_CI_ARTIFACT_DIR:-}" ]]; then
    WEAVE_CI_ARTIFACTS_PATH="$WEAVE_CI_ARTIFACT_DIR"
    mkdir -p -- "$WEAVE_CI_ARTIFACTS_PATH"
  else
    local temporary_root="${TMPDIR:-/tmp}"
    mkdir -p -- "$temporary_root"
    temporary_root="$(cd "$temporary_root" && pwd -P)"
    [[ "$temporary_root" != / ]] || {
      printf '%s\n' 'refusing to create CI artifacts directly beneath /' >&2
      return 1
    }
    WEAVE_CI_ARTIFACTS_TMP_ROOT="$temporary_root"
    WEAVE_CI_ARTIFACTS_PATH="$(mktemp -d "$temporary_root/$prefix.XXXXXX")"
    WEAVE_CI_ARTIFACTS_CREATED=1
  fi

  printf -v "$output_variable" '%s' "$WEAVE_CI_ARTIFACTS_PATH"
  trap weave_ci_artifacts_on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

weave_ci_artifacts_remove_created() {
  ((WEAVE_CI_ARTIFACTS_CREATED == 1)) || return 0
  ((WEAVE_CI_ARTIFACTS_CLEANED == 0)) || return 0

  local artifact_path="$WEAVE_CI_ARTIFACTS_PATH"
  if [[ ! -e "$artifact_path" && ! -L "$artifact_path" ]]; then
    WEAVE_CI_ARTIFACTS_CLEANED=1
    return 0
  fi
  local artifact_parent
  artifact_parent="$(cd "$(dirname "$artifact_path")" && pwd -P)" || return 1
  if [[ "$artifact_parent" != "$WEAVE_CI_ARTIFACTS_TMP_ROOT" ]]; then
    printf 'refusing artifact cleanup outside temporary root: %s\n' "$artifact_path" >&2
    return 1
  fi
  case "$(basename "$artifact_path")" in
    "$WEAVE_CI_ARTIFACTS_PREFIX".??????) ;;
    *)
      printf 'refusing unexpected artifact directory name: %s\n' "$artifact_path" >&2
      return 1
      ;;
  esac
  if [[ -L "$artifact_path" ]]; then
    printf 'refusing symlink artifact cleanup: %s\n' "$artifact_path" >&2
    return 1
  fi

  rm -rf -- "$artifact_path"
  WEAVE_CI_ARTIFACTS_CLEANED=1
  printf 'removed temporary artifacts: %s\n' "$artifact_path" >&2
}

weave_ci_artifacts_on_exit() {
  local status=$?
  trap - EXIT INT TERM

  if ((WEAVE_CI_ARTIFACTS_CREATED == 1)); then
    if ((status == 0)) && [[ "${WEAVE_CI_KEEP_TEMP:-0}" != 1 ]]; then
      if ! weave_ci_artifacts_remove_created; then
        printf 'warning: could not remove temporary artifacts: %s\n' \
          "$WEAVE_CI_ARTIFACTS_PATH" >&2
        status=1
      fi
    else
      printf 'retained artifacts: %s\n' "$WEAVE_CI_ARTIFACTS_PATH" >&2
    fi
  fi

  exit "$status"
}
