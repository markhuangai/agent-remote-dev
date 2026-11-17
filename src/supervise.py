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


def descendants():
    found = []
    pending = children()
    while pending:
        pid = pending.pop()
        if pid in found:
            continue
        found.append(pid)
        try:
            pending.extend(int(value) for value in Path(f"/proc/{pid}/task/{pid}/children").read_text().split())
        except FileNotFoundError:
            pass
    return found


def signal_children(kind):
    for pid in descendants():
        try:
            stat = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
            os.kill(pid, kind)
        except ProcessLookupError:
            pass
        except FileNotFoundError:
            pass


def freeze_children():
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        before = set(descendants())
        signal_children(signal.SIGSTOP)
        time.sleep(0.001)
        after = set(descendants())
        stopped = True
        for pid in after:
            try:
                state = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[0]
                stopped = stopped and state in ("T", "t", "Z")
            except FileNotFoundError:
                pass
        if before == after and stopped:
            return
    raise RuntimeError("Managed writers did not pause for snapshot")


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
    control = Path(receipt).parent
    paused = False
    worker = subprocess.Popen(command, start_new_session=True)
    while worker.poll() is None:
        if stopping_at is not None:
            signal_children(signal.SIGCONT)
            signal_children(signal.SIGKILL if time.monotonic() - stopping_at >= 1 else signal.SIGTERM)
        elif (control / "pause").exists():
            if not paused:
                freeze_children()
                temporary = control / "paused.tmp"
                temporary.write_text(json.dumps({"nonce": nonce}))
                temporary.replace(control / "paused.json")
                paused = True
        elif paused:
            (control / "paused.json").unlink(missing_ok=True)
            signal_children(signal.SIGCONT)
            paused = False
        time.sleep(0.02)
    signal_children(signal.SIGCONT)
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
        signal_children(signal.SIGCONT)
        signal_children(signal.SIGKILL)
        print(f"Worker supervision failed: {error}", file=sys.stderr)
        sys.exit(70)
