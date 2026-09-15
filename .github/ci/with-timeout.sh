#!/usr/bin/env bash
# Portable process-group timeout used by the central harnesses. Unlike the
# GNU timeout utility, this is also available on the stock macOS environment.

set -euo pipefail

[[ $# -ge 2 ]] || {
  printf 'usage: .github/ci/with-timeout.sh SECONDS COMMAND [ARG ...]\n' >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 - "$SCRIPT_DIR" "$@" <<'PY'
import math
import signal
import subprocess
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv.pop(1))
from process_group import stop_process_group

try:
    timeout = float(sys.argv[1])
except ValueError:
    print(f"invalid timeout: {sys.argv[1]}", file=sys.stderr)
    raise SystemExit(2)
if not math.isfinite(timeout) or timeout <= 0:
    print("timeout must be finite and positive", file=sys.stderr)
    raise SystemExit(2)

command = sys.argv[2:]
process = subprocess.Popen(command, start_new_session=True)

def interrupted(signum, _frame):
    stop_process_group(process)
    raise SystemExit(128 + signum)

signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)
try:
    status = process.wait(timeout=timeout)
    raise SystemExit(status if status >= 0 else 128 - status)
except subprocess.TimeoutExpired:
    print(f"timed out after {timeout:g}s: {command[0]}", file=sys.stderr)
    stop_process_group(process)
    raise SystemExit(124)
PY
