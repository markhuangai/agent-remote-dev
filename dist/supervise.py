import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

PR_SET_CHILD_SUBREAPER = 36

def children():
    path = Path(f"/proc/self/task/{os.getpid()}/children")
    return [int(value) for value in path.read_text().split()]


def signal_children(kind):
    for pid in children():
        try:
            stat = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
            if int(stat[1]) == os.getpid():
                os.kill(pid, kind)
        except ProcessLookupError:
            pass
        except FileNotFoundError:
            pass


def main():
    receipt, nonce, *command = sys.argv[1:]
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Linux child subreaper setup failed")
    interrupted = None
    stopping_at = None

    def interrupt(kind, _frame):
        nonlocal interrupted, stopping_at
        interrupted = kind
        if stopping_at is None:
            stopping_at = time.monotonic()
        signal_children(signal.SIGTERM)

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    worker = subprocess.Popen(command, start_new_session=True)
    while worker.poll() is None:
        if stopping_at is not None:
            signal_children(signal.SIGKILL if time.monotonic() - stopping_at >= 1 else signal.SIGTERM)
        time.sleep(0.02)
    status = worker.returncode
    started = time.monotonic()
    while True:
        try:
            while os.waitpid(-1, os.WNOHANG)[0] != 0:
                pass
        except ChildProcessError:
            break
        signal_children(signal.SIGKILL if time.monotonic() - started >= 0.5 else signal.SIGTERM)
        if time.monotonic() - started >= 2:
            raise RuntimeError("Managed worker descendants did not become quiescent")
        time.sleep(0.02)
    Path(receipt).write_text(json.dumps({"nonce": nonce, "quiescent": True, "worker_pid": worker.pid, "exit_code": status}))
    return 128 + interrupted if interrupted else (status if status >= 0 else 128 - status)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"Worker supervision failed: {error}", file=sys.stderr)
        sys.exit(70)
