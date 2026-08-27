#!/usr/bin/env bash
# Portable process-group timeout used by the central harnesses. Unlike the
# GNU timeout utility, this is also available on the stock macOS environment.

set -euo pipefail

[[ $# -ge 2 ]] || {
  printf 'usage: .github/ci/with-timeout.sh SECONDS COMMAND [ARG ...]\n' >&2
  exit 2
}

exec python3 - "$@" <<'PY'
import os
import signal
import subprocess
import sys

try:
    timeout = float(sys.argv[1])
except ValueError:
    print(f"invalid timeout: {sys.argv[1]}", file=sys.stderr)
    raise SystemExit(2)
if timeout <= 0:
    print("timeout must be positive", file=sys.stderr)
    raise SystemExit(2)

command = sys.argv[2:]
process = subprocess.Popen(command, start_new_session=True)

def stop_process_group():
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()

def interrupted(signum, _frame):
    stop_process_group()
    raise SystemExit(128 + signum)

signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)
try:
    raise SystemExit(process.wait(timeout=timeout))
except subprocess.TimeoutExpired:
    print(f"timed out after {timeout:g}s: {command[0]}", file=sys.stderr)
    stop_process_group()
    raise SystemExit(124)
PY
