#!/usr/bin/env bash
# Suspend-safe condition waits for the central conformance harness. Python's
# monotonic clock maps to an uptime clock on supported macOS/Linux hosts, so a
# sleeping machine does not consume a runtime's active execution allowance.

set -euo pipefail

[[ $# -ge 3 ]] || {
  cat >&2 <<'EOF'
usage: .github/ci/wait-for.sh SECONDS process PID
       .github/ci/wait-for.sh SECONDS matching-lines FILE MINIMUM REGEX
       .github/ci/wait-for.sh SECONDS output-contains NEEDLE COMMAND [ARG ...]
EOF
  exit 2
}

exec python3 - "$@" <<'PY'
import errno
import os
import re
import subprocess
import sys
import time


def usage(message=None):
    if message:
        print(message, file=sys.stderr)
    print(
        "usage: wait-for.sh SECONDS "
        "{process PID|matching-lines FILE MINIMUM REGEX|"
        "output-contains NEEDLE COMMAND [ARG ...]}",
        file=sys.stderr,
    )
    raise SystemExit(2)


try:
    timeout = float(sys.argv[1])
except (IndexError, ValueError):
    usage("timeout must be a number")
if timeout <= 0:
    usage("timeout must be positive")

mode = sys.argv[2]
arguments = sys.argv[3:]
interval = 0.05

if mode == "process":
    if len(arguments) != 1:
        usage("process mode requires one PID")
    try:
        pid = int(arguments[0])
    except ValueError:
        usage("PID must be an integer")
    if pid <= 0:
        usage("PID must be positive")
    interval = 0.1

    def check():
        try:
            os.kill(pid, 0)
        except OSError as error:
            if error.errno == errno.ESRCH:
                return True, ""
            if error.errno != errno.EPERM:
                raise
        return False, ""

elif mode == "matching-lines":
    if len(arguments) != 3:
        usage("matching-lines mode requires FILE, MINIMUM, and REGEX")
    path, minimum_text, pattern_text = arguments
    try:
        minimum = int(minimum_text)
    except ValueError:
        usage("MINIMUM must be an integer")
    if minimum < 0:
        usage("MINIMUM must not be negative")
    try:
        pattern = re.compile(pattern_text)
    except re.error as error:
        usage(f"invalid regular expression: {error}")
    interval = 0.02

    def check():
        count = 0
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as stream:
                count = sum(1 for line in stream if pattern.search(line))
        except FileNotFoundError:
            pass
        return count >= minimum, str(count)

elif mode == "output-contains":
    if len(arguments) < 2:
        usage("output-contains mode requires NEEDLE and COMMAND")
    needle = arguments[0]
    command = arguments[1:]

    def check():
        completed = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            errors="replace",
            check=False,
        )
        return completed.returncode == 0 and needle in completed.stdout, completed.stdout

else:
    usage(f"unknown mode: {mode}")

active_started = time.monotonic()
wall_started = time.time()
deadline = active_started + timeout
result = ""
status = 124

while True:
    matched, result = check()
    if matched:
        status = 0
        break
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        break
    time.sleep(min(interval, remaining))

active_elapsed = time.monotonic() - active_started
wall_elapsed = time.time() - wall_started
suspended = wall_elapsed - active_elapsed
if suspended >= 2:
    print(
        f"notice: host suspend or wall-clock jump added approximately {suspended:.0f}s "
        "while waiting; it did not consume the active timeout",
        file=sys.stderr,
    )

if result:
    sys.stdout.write(result)
    if not result.endswith("\n"):
        sys.stdout.write("\n")
raise SystemExit(status)
PY
