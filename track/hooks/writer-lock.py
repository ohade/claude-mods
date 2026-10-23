#!/usr/bin/env python3
"""Track reliability release gate: one live writer per session, serialized store writes.

Only lock files live here. Ledger access stays in supported $.store operations.
The process stream owns each flock; closing/unloading the stream releases it.
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import sys
import time


def emit(value):
    print(json.dumps(value), flush=True)


def fail(reason):
    emit({"ok": False, "reason": reason})
    return 1


def lease_failure(session_file, token):
    try:
        fcntl.flock(session_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        try:
            session_file.seek(0)
            owner = json.load(session_file)
        except (ValueError, OSError):
            return "session writer identity is unknown"
        if not isinstance(owner, dict) or owner.get("token") != token:
            return "session writer identity does not match"
        return None
    else:
        fcntl.flock(session_file, fcntl.LOCK_UN)
        return "session writer lease is not alive"


def main():
    if len(sys.argv) != 4:
        return fail("invalid lock arguments")
    mode, session, token = sys.argv[1:]
    if mode not in ("lease", "write", "guard") or not re.fullmatch(r"[0-9a-fA-F-]{36}", session) or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", token):
        return fail("invalid lock identity")
    os.umask(0o077)
    config = Path(os.environ.get("CLAUDE_CONFIG_DIR") or str(Path.home() / ".claude"))
    directory = Path(os.environ.get("TRACK_LOCK_DIR", str(config / "state" / "track" / "locks")))
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    lease = os.open(directory / f"{session}.lock", flags, 0o600)
    parent = os.getppid()
    with os.fdopen(lease, "r+") as session_file:
        if mode == "guard":
            # TRACK-21: keep the acquired target lease until the caller finishes
            # expiry/read-back/rollback. A released probe cannot fence a reopen.
            try:
                fcntl.flock(session_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                state = "closed"
            except BlockingIOError:
                state = "live"
            emit({"ok": True, "mode": mode, "token": token, "state": state})
            # EOF on stdin is immediate in the engine. Watch stdout instead:
            # a disconnected reader releases an orphan without a time limit
            # that could cut off an in-flight rollback.
            disconnected = select.poll()
            disconnected.register(sys.stdout.fileno(), select.POLLERR | select.POLLHUP | select.POLLNVAL)
            while os.getppid() == parent:
                if disconnected.poll(500):
                    break
            return 0
        if mode == "lease":
            # A cleaner can hold this same lease briefly while it expires a
            # closed record. Never read the record before ownership is granted.
            deadline = time.monotonic() + 3
            while True:
                try:
                    fcntl.flock(session_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        return fail("another loaded Track instance owns this session")
                    time.sleep(0.01)
            session_file.seek(0)
            session_file.truncate()
            json.dump({"token": token}, session_file)
            session_file.flush()
            emit({"ok": True, "mode": mode, "token": token})
            while os.getppid() == parent:
                time.sleep(0.5)
            return 0
        failure = lease_failure(session_file, token)
        if failure is not None:
            return fail(failure)
        store = os.open(directory / "store.lock", flags, 0o600)
        with os.fdopen(store, "r+") as store_file:
            deadline = time.monotonic() + 3
            while True:
                try:
                    fcntl.flock(store_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        return fail("store writer is busy")
                    time.sleep(0.01)
            # Ownership can change while waiting for a different session's save.
            # A global store lock does not authorize the old session token.
            failure = lease_failure(session_file, token)
            if failure is not None:
                return fail(failure)
            emit({"ok": True, "mode": mode, "token": token})
            while os.getppid() == parent:
                time.sleep(0.5)
    return 0


def report_error(error):
    """Keep bounded cause identity without exposing paths or process arguments."""
    causes = []
    current = error
    for _ in range(3):
        if current is None:
            break
        number = getattr(current, "errno", None)
        causes.append({"type": type(current).__name__[:64],
                       "errno": number if isinstance(number, int) and 0 <= number <= 65535 else None})
        current = current.__cause__ or current.__context__
    print(json.dumps({"event": "writer_lock_failure", "causes": causes},
                     separators=(",", ":")), file=sys.stderr, flush=True)


def dispatch():
    """Validate the public interface before choosing a namespace or protocol."""
    arguments = sys.argv[1:]
    if arguments in (["-h"], ["--help"]):
        print("usage: writer-lock.py lease|write|guard <session> <module-token>")
        return 0
    if len(arguments) != 3:
        fail("invalid lock arguments")
        return 2
    mode, session, token = arguments
    if (mode not in ("lease", "write", "guard")
            or not re.fullmatch(r"[0-9a-fA-F-]{36}", session)
            or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", token)):
        fail("invalid lock identity")
        return 2
    if "TRACK_LOCK_PROTOCOL" not in os.environ:
        return main()
    if os.environ["TRACK_LOCK_PROTOCOL"] != "2":
        return fail("unsupported lock protocol")
    # Import by adjacent absolute path, including under Python safe-path mode.
    sys.dont_write_bytecode = True
    library = Path(__file__).resolve().parent / "write_transactions.py"
    spec = importlib.util.spec_from_file_location("track_write_transactions", library)
    if spec is None or spec.loader is None:
        return fail("transaction library is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.main(mode, session, token)


if __name__ == "__main__":
    try:
        sys.exit(dispatch())
    except KeyboardInterrupt:
        sys.exit(130)
    except BrokenPipeError:
        # A disconnected owner cannot receive diagnostics. Avoid a second flush
        # of the broken stdout during interpreter shutdown.
        os._exit(1)
    except (OSError, ImportError, RuntimeError, ValueError) as error:
        try:
            report_error(error)
            sys.exit(fail("lock operation failed"))
        except BrokenPipeError:
            os._exit(1)
