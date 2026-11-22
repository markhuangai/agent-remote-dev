import ctypes
import errno
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

PR_SET_CHILD_SUBREAPER = 36
STOPPED = {"T", "t"}
EXITED = {"Z", "X"}

def children(pid):
    try:
        tasks = list(Path(f"/proc/{pid}/task").iterdir())
    except FileNotFoundError:
        return []
    found = []
    for task in tasks:
        try:
            found.extend(int(value) for value in (task / "children").read_text().split())
        except FileNotFoundError:
            pass
    return found


def descendants():
    supervisor = os.getpid()
    found = {}
    denied = []
    pending = [supervisor]
    while pending:
        pid = pending.pop()
        if pid in found:
            continue
        found[pid] = None
        try:
            pending.extend(children(pid))
        except PermissionError as error:
            denied.append((pid, error))
    del found[supervisor]
    return found, denied


def process_status(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
    except (FileNotFoundError, ProcessLookupError):
        return None
    return fields[0], fields[19]


def signal_process(pid, started, kind):
    fd = None
    try:
        try:
            fd = os.pidfd_open(pid)
        except OSError as error:
            if error.errno != errno.ENOSYS:
                raise
        # The PID may have been reused before the descriptor was opened.
        status = process_status(pid)
        if status is None or status[1] != started or status[0] in EXITED:
            return False
        if fd is None:
            os.kill(pid, kind)
        else:
            signal.pidfd_send_signal(fd, kind)
        return True
    except ProcessLookupError:
        return False
    finally:
        if fd is not None:
            os.close(fd)


def signal_problem(reason, kind, pid=None, error=None):
    return {"reason": reason, "signal": kind.name, "pid": pid, "os_errno": error.errno if error else None}


def signal_children(kind):
    pids, denied = descendants()
    for pid in pids:
        try:
            status = process_status(pid)
            if status is not None:
                signal_process(pid, status[1], kind)
        except PermissionError as error:
            denied.append((pid, error))
    if denied:
        pid, error = denied[0]
        return signal_problem("permission_denied", kind, pid, error)


def child_statuses():
    pids, denied = descendants()
    if denied:
        pid, error = denied[0]
        return {}, signal_problem("inspection_denied", signal.SIGSTOP, pid, error)
    states = {}
    for pid in pids:
        try:
            status = process_status(pid)
        except PermissionError as error:
            return {}, signal_problem("inspection_denied", signal.SIGSTOP, pid, error)
        if status is not None:
            states[pid] = status
    return states, None


def freeze_children(paused, interrupted):
    deadline = time.monotonic() + 2
    blocking_pid = None
    while time.monotonic() < deadline:
        if interrupted():
            return signal_problem("interrupted", signal.SIGSTOP)
        before, problem = child_statuses()
        if problem:
            return problem
        for pid, (state, started) in before.items():
            if interrupted():
                return signal_problem("interrupted", signal.SIGSTOP)
            if state in STOPPED or state in EXITED:
                continue
            try:
                if signal_process(pid, started, signal.SIGSTOP):
                    paused.add((pid, started))
            except PermissionError as error:
                return signal_problem("permission_denied", signal.SIGSTOP, pid, error)
        time.sleep(0.001)
        after, problem = child_statuses()
        if problem:
            return problem
        blocking_pid = next((pid for pid, (state, _) in after.items() if state not in STOPPED and state not in EXITED), None)
        if blocking_pid is None:
            before_processes = {(pid, started) for pid, (_, started) in before.items()}
            after_processes = {(pid, started) for pid, (_, started) in after.items()}
            changes = before_processes ^ after_processes
            if not changes:
                return None
            blocking_pid = min(pid for pid, _ in changes)
    return signal_problem("pause_deadline", signal.SIGSTOP, blocking_pid)


def resume_children(paused):
    failures = {}
    for pid, started in paused:
        try:
            signal_process(pid, started, signal.SIGCONT)
        except OSError as error:
            failures[pid, started] = signal_problem("resume_signal_failed", signal.SIGCONT, pid, error)
    deadline = time.monotonic() + 2
    while paused:
        unverified = None
        for pid, started in tuple(paused):
            failure = failures.get((pid, started))
            try:
                status = process_status(pid)
            except OSError as error:
                unverified = failure or signal_problem("resume_inspection_failed", signal.SIGCONT, pid, error)
                continue
            if status is None or status[1] != started or status[0] in EXITED or (failure is None and status[0] not in STOPPED):
                paused.remove((pid, started))
            else:
                unverified = failure or signal_problem("resume_deadline", signal.SIGCONT, pid)
        if unverified is None or time.monotonic() >= deadline:
            return unverified
        time.sleep(0.01)
    return None


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

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    receipt = Path(receipt)
    control = receipt.parent
    reply = control / "paused.json"
    paused = set()
    handled = None

    def release_pause(problem=None):
        reply.unlink(missing_ok=True)
        failure = resume_children(paused)
        if failure:
            receipt.write_text(json.dumps({"nonce": nonce, "quiescent": False,
                                           "pause_recovery_failure": {"pause_failure": problem, "resume_failure": failure}}))
            raise RuntimeError("The supervisor could not verify that paused processes resumed or exited")

    worker = subprocess.Popen(command, start_new_session=True)
    while worker.poll() is None:
        try:
            request = (control / "pause").read_text()
        except FileNotFoundError:
            request = None
        if handled and (request != handled or stopping_at is not None):
            release_pause()
            handled = None
        if stopping_at is not None:
            signal_children(signal.SIGCONT)
            signal_children(signal.SIGKILL if time.monotonic() - stopping_at >= 1 else signal.SIGTERM)
        elif request and request != handled:
            problem = freeze_children(paused, lambda: stopping_at is not None)
            if problem or stopping_at is not None:
                release_pause(problem or signal_problem("interrupted", signal.SIGSTOP))
            if stopping_at is None:
                temporary = control / "paused.tmp"
                temporary.write_text(json.dumps({"nonce": nonce, "request": request, "problem": problem}))
                temporary.replace(reply)
                handled = request
        time.sleep(0.02)
    if handled:
        release_pause()
    signal_children(signal.SIGCONT)
    status = worker.returncode
    started = time.monotonic()
    while True:
        try:
            while os.waitpid(-1, os.WNOHANG)[0] != 0:
                pass
        except ChildProcessError:
            break
        problem = signal_children(signal.SIGKILL if time.monotonic() - started >= 0.5 else signal.SIGTERM)
        if time.monotonic() - started >= 2:
            raise RuntimeError(f"Managed worker descendants did not become quiescent: {problem}")
        time.sleep(0.02)
    receipt.write_text(json.dumps({"nonce": nonce, "quiescent": True, "worker_pid": worker.pid, "exit_code": status}))
    return 128 + interrupted if interrupted else (status if status >= 0 else 128 - status)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"Worker supervision failed: {type(error).__name__}: {error}", file=sys.stderr)
        for kind in (signal.SIGCONT, signal.SIGKILL):
            try:
                problem = signal_children(kind)
                if problem:
                    print(f"Worker cleanup failed: {problem}", file=sys.stderr)
            except OSError as cleanup_error:
                print(f"Worker cleanup failed: {cleanup_error}", file=sys.stderr)
        sys.exit(70)
