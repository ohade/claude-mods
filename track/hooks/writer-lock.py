#!/usr/bin/env python3
"""Track reliability release gate: one live writer per session, serialized store writes.

Only lock files live here. Ledger access stays in supported $.store operations.
The process stream owns each flock; closing/unloading the stream releases it.
"""
import fcntl
import json
import os
from pathlib import Path
import re
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
    if mode not in ("lease", "write") or not re.fullmatch(r"[0-9a-fA-F-]{36}", session) or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", token):
        return fail("invalid lock identity")
    os.umask(0o077)
    config = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude")))
    directory = Path(os.environ.get("TRACK_LOCK_DIR", str(config / "state" / "track" / "locks")))
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    lease = os.open(directory / f"{session}.lock", flags, 0o600)
    parent = os.getppid()
    with os.fdopen(lease, "r+") as session_file:
        if mode == "lease":
            try:
                fcntl.flock(session_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return fail("another loaded Track instance owns this session")
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


if __name__ == "__main__":
    try:
        sys.exit(main())
    except OSError as error:
        sys.exit(fail(str(error)))
