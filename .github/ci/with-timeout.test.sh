#!/usr/bin/env bash
# Real-process regressions for both deadline helpers. Fixtures do not launch
# browsers, bind sockets, or signal any process not created by this test.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec python3 - "$ROOT" "$BASH" <<'PY'
import contextlib
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time

root = pathlib.Path(sys.argv[1])
bash = sys.argv[2]
helpers = {name: [bash, str(root / '.github/ci' / (name + '.sh'))]
           for name in ('with-timeout', 'wait-for')}
cases = 0


def passed(label):
    global cases
    cases += 1
    print(f'ok {cases} - {label}', flush=True)


def run(name, timeout, command):
    arguments = helpers[name] + [timeout]
    if name == 'wait-for':
        arguments += ['output-contains', 'ready']
    return subprocess.run(arguments + command, capture_output=True, text=True, timeout=10)


with tempfile.TemporaryDirectory(prefix='weave-deadline-test.') as temporary:
    folder = pathlib.Path(temporary)
    marker = folder / 'invalid-started'
    command = [sys.executable, '-c', 'import pathlib,sys; pathlib.Path(sys.argv[1]).touch()', str(marker)]
    for name in helpers:
        for value in ('nan', 'NaN', 'inf', '-inf', '1e309', '0', '-1', 'nope'):
            result = run(name, value, command)
            assert result.returncode == 2, (name, value, result)
            assert not marker.exists(), (name, value, 'launched command with invalid deadline')
            passed(f'{name} rejects {value} before launching a child')

    for status in (0, 7, 124):
        result = run('with-timeout', '2', [sys.executable, '-c', f'import sys; print("kept output"); sys.exit({status})'])
        assert result.returncode == status and result.stdout == 'kept output\n', result
        passed(f'command exit {status} and stdout are preserved')

    result = run('with-timeout', '2', [sys.executable, '-c', 'import os,signal; os.kill(os.getpid(), signal.SIGTERM)'])
    assert result.returncode == 143, result
    passed('signal-terminated command reports conventional exit 143')

    result = run('wait-for', '2', [sys.executable, '-c', 'print("ready")'])
    assert result.returncode == 0 and result.stdout == 'ready\n', result
    passed('successful output check preserves matching output')

    result = run('wait-for', '.1', [sys.executable, '-c', 'import sys; print("ready"); sys.exit(7)'])
    assert result.returncode == 124, result
    passed('matching text from a failing command is not a false pass')

    result = run('wait-for', '.2', [sys.executable, '-c', 'import time; print("partial progress", flush=True); time.sleep(60)'])
    assert result.returncode == 124 and result.stdout == 'partial progress\n', result
    passed('hung output check times out and preserves partial progress')

    for name in helpers:
        result = run(name, '2', [str(folder / 'missing-command')])
        assert result.returncode != 0, result
        passed(f'{name} does not turn a missing command into success')

    # This witness is outside all tested command groups. Cleanup must leave it
    # untouched, including when a child in the target group ignores SIGTERM.
    witness = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
    try:
        for name in helpers:
            for interruption in (None, signal.SIGTERM, signal.SIGINT):
                label = f'{name}-{interruption or "deadline"}'
                heartbeat = folder / (label + '.heartbeat')
                child_pid = folder / (label + '.pid')
                child_program = '''
import os,pathlib,signal,sys,time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
heartbeat, pid = map(pathlib.Path, sys.argv[1:])
pid.write_text(str(os.getpid()))
while True:
    heartbeat.write_text(str(time.monotonic_ns()))
    time.sleep(.02)
'''
                parent_program = '''
import subprocess,sys,time
subprocess.Popen([sys.executable, '-c', sys.argv[1], *sys.argv[2:]])
time.sleep(60)
'''
                arguments = helpers[name] + [('2' if interruption is None else '30')]
                if name == 'wait-for':
                    arguments += ['output-contains', 'ready']
                arguments += [sys.executable, '-c', parent_program, child_program, str(heartbeat), str(child_pid)]
                started = time.monotonic()
                # File streams avoid an orphan inheriting the test's pipe and
                # preventing our independent watchdog from observing exit.
                with (folder / (label + '.out')).open('w+') as output:
                    process = subprocess.Popen(arguments, stdout=output, stderr=output)
                    try:
                        ready_deadline = time.monotonic() + 1.5
                        while not heartbeat.exists() and time.monotonic() < ready_deadline:
                            assert process.poll() is None, (label, 'wrapper exited before child readiness')
                            time.sleep(.01)
                        assert heartbeat.exists(), (label, 'fixture child never became ready')
                        if interruption is not None:
                            process.send_signal(interruption)
                            time.sleep(.1)
                            # A second cancellation cannot interrupt cleanup.
                            if process.poll() is None:
                                process.send_signal(interruption)
                        status = process.wait(timeout=7)
                        expected = 124 if interruption is None else 128 + interruption
                        assert status == expected, (label, status, expected)
                        assert time.monotonic() - started < 9, (label, 'cleanup exceeded bounded grace')
                        before = heartbeat.read_bytes()
                        time.sleep(.15)
                        assert heartbeat.read_bytes() == before, (label, 'descendant still running after wrapper exit')
                        assert witness.poll() is None, (label, 'cleanup killed unrelated process')
                        passed(f'{label}: kills TERM-ignoring descendant after leader exit, leaves unrelated process alive')
                    finally:
                        if process.poll() is None:
                            process.kill()
                            process.wait(timeout=5)
                        if child_pid.exists():
                            with contextlib.suppress(ProcessLookupError):
                                os.kill(int(child_pid.read_text()), signal.SIGKILL)
    finally:
        witness.terminate()
        witness.wait(timeout=5)

print(f'PASS process-group deadlines ({cases} real-process cases)')
PY
