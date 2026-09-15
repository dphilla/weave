"""Bounded termination of a subprocess's isolated POSIX process group."""

import os
import signal
import time


def stop_process_group(process, grace_seconds=2.0):
    # The caller must have used start_new_session=True. Never discover or kill
    # descendants globally: unrelated processes and escaped sessions are out of
    # scope. Ignore repeated cancellation while this bounded cleanup runs.
    previous_handlers = {
        sig: signal.signal(sig, signal.SIG_IGN)
        for sig in (signal.SIGINT, signal.SIGTERM)
    }
    try:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            process.wait()
            return

        deadline = time.monotonic() + grace_seconds
        while True:
            # Reap the leader, but do not mistake its exit for group completion:
            # a TERM-ignoring child can outlive a TERM-responsive parent.
            process.poll()
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                break
            except PermissionError:
                # A group probe can transiently return EPERM while macOS is
                # retiring a signaled process. It does not prove absence;
                # retain the bounded wait and any eventual real kill error.
                pass
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                break
            time.sleep(min(0.05, remaining))
        process.wait()
    finally:
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)
