#!/usr/bin/env python3
"""Track reliability release gate: one live writer per session, serialized store writes.

Only lock files live here. Ledger access stays in supported $.store operations.
The process stream owns each flock; closing/unloading the stream releases it.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys


def emit(value):
    print(json.dumps(value), flush=True)


def fail(reason):
    emit({"ok": False, "reason": reason})
    return 1


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
    if os.environ.get("TRACK_LOCK_PROTOCOL") != "2":
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
