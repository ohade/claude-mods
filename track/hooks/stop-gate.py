#!/usr/bin/env python3
"""Track release gate: ordinary Stop remains available when classic hooks are bypassed.

Consumes only Track's small current-turn snapshot. No transcript or ledger storage reads.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time


# TRACK-27 (approved 2026-10-17): the ordinary hook and plugin share these
# messages and exclusive claims. Missing facts never authorize a hard block.
KINDS = ("premature_completion", "stale_in_progress", "missing_waiting_request", "untracked_edit")
HOLD_OWNER = "track-stop-hold-v1"
TTL_SECONDS = 7 * 24 * 60 * 60


def unavailable(what):
    print(f"track: {what} unavailable; reconcile the step before finishing", file=sys.stderr)


def claim_name(session, turn, kind):
    identity = json.dumps([session, turn, kind], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def expire_holds(directory):
    cutoff = time.time() - TTL_SECONDS
    # Bounded maintenance. Only records with the helper's marker AND matching
    # identity/hash are ours. A name or timestamp alone grants no deletion.
    for index, path in enumerate(directory.iterdir()):
        if index >= 512:
            break
        if re.fullmatch(r"[0-9a-f]{64}", path.name) is None:
            continue
        try:
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(fd, "r") as handle:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_mtime >= cutoff:
                    continue
                row = json.loads(handle.read(4097))
                if not isinstance(row, dict) or row.get("owner") != HOLD_OWNER or row.get("kind") not in KINDS:
                    continue
                if not all(isinstance(row.get(field), str) and row[field] for field in ("session_id", "turn_id")):
                    continue
                if claim_name(row["session_id"], row["turn_id"], row["kind"]) != path.name:
                    continue
                current = path.lstat()
                if (current.st_dev, current.st_ino) == (info.st_dev, info.st_ino):
                    path.unlink()
        except (OSError, ValueError):
            # A foreign, busy, malformed or disappearing record is preserved.
            continue


def claim_once(session, turn, kind):
    config = os.environ.get("CLAUDE_CONFIG_DIR")
    if not config or not Path(config).is_absolute():
        raise ValueError("claim configuration")
    directory = Path(config) / "state" / "track" / "stop-holds"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink():
        raise ValueError("claim directory")
    directory.chmod(0o700)
    expire_holds(directory)
    path = directory / claim_name(session, turn, kind)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w") as handle:
        os.fchmod(handle.fileno(), 0o600)
        json.dump({"owner": HOLD_OWNER, "session_id": session, "turn_id": turn, "kind": kind}, handle)
        handle.flush()
    return True


def freshness_reason(candidate, payload):
    kind = candidate.get("kind")
    step = candidate.get("id")
    if kind != "untracked_edit" and (not isinstance(step, str) or not step.strip()):
        return None
    if kind in ("premature_completion", "stale_in_progress"):
        tasks, owners = payload.get("background_tasks"), candidate.get("owner_task_ids")
        if not isinstance(tasks, list):
            unavailable("background task list")
            return None
        if not isinstance(owners, list) or not all(isinstance(owner, str) and owner for owner in owners):
            unavailable("owner receipt")
            return None
        if not all(isinstance(task, dict) and isinstance(task.get("id"), str) for task in tasks):
            unavailable("background task identity")
            return None
        running = {task["id"] for task in tasks}
        owner = next((owner for owner in owners if owner in running), None)
        if kind == "premature_completion":
            return None if owner is None else (
                f"track: {step} is completed while its owned task {owner} is still running. "
                "Reopen or pause the step, or wait for that task, then finish."
            )
        if owner is not None:
            return None
        return (f"track: {step} is still in_progress, but no work owns it. "
                "Call mark_step with completed, paused, or waiting and the true result, then finish.")
    if kind == "missing_waiting_request":
        return (f"track: {step} is waiting, but the final reply has no 👉 {step}: request line. "
                "Ask the user visibly, then finish.")
    if kind == "untracked_edit":
        return ("track: this turn changed files but no step was created or marked. "
                "Reuse a step with mark_step or register one with track_steps, then finish.")
    return None


def freshness_decision(payload, snapshot):
    session, turn = snapshot.get("session_id"), snapshot.get("turn_id")
    if not isinstance(session, str) or not session.strip() or not isinstance(turn, str) or not turn.strip():
        unavailable("snapshot identity")
        return {}
    rows, held, response = snapshot.get("candidates"), snapshot.get("held"), snapshot.get("response")
    if not isinstance(rows, list) or not isinstance(held, list) or snapshot.get("truncated") is True:
        unavailable("bounded freshness snapshot")
        return {}
    if not rows:
        return {}
    if not isinstance(response, dict) or response.get("turn_id") != turn or not isinstance(response.get("request_id"), str) or not response["request_id"].strip():
        unavailable("main response receipt")
        return {}
    spent = set(kind for kind in held if isinstance(kind, str))
    for kind in KINDS:
        if kind in spent:
            continue
        for row in rows:
            if not isinstance(row, dict) or row.get("kind") != kind:
                continue
            reason = freshness_reason(row, payload)
            if reason is None:
                continue
            try:
                if claim_once(session, turn, kind):
                    return {"decision": "block", "reason": reason}
            except (OSError, ValueError):
                unavailable("shared hold claim")
                return {}
            break  # the shared claim already consumed this kind, not the next kind
    return {}


def decision(payload, snapshot, plugin=False):
    if not isinstance(payload, dict) or not isinstance(snapshot, dict):
        return {}
    if payload.get("agent_id") is not None or payload.get("stop_hook_active") is True:
        return {}
    if snapshot.get("v") not in (1, 2) or snapshot.get("session_id") != payload.get("session_id"):
        return {}
    if not isinstance(snapshot.get("turn_id"), str):
        return {}
    rows = snapshot.get("open")
    if not isinstance(rows, list) or not rows or plugin:
        return freshness_decision(payload, snapshot) if snapshot.get("v") == 2 else {}
    first = rows[0]
    if not isinstance(first, dict) or not isinstance(first.get("id"), int) or not isinstance(first.get("head"), str):
        return {}
    return {"decision": "block", "reason": (
        f'track: Q{first["id"]} "{first["head"]}" from this turn is still open. '
        f'Write the formatted answer once between standalone <!-- A{first["id"]}:start --> '
        f'and <!-- A{first["id"]}:end --> lines; Track captures it automatically. '
        'Do not also send answer_text. For a tool/file-only answer, call '
        'mcp__track__mark_answered with the completed answer_text. '
        'If it must wait, use status "deferred" with a note. Then finish.'
    )}


def main():
    try:
        raw = sys.stdin.read(1024 * 1024 + 1)
        snapshot = os.environ.get("TRACK_GATE_SNAPSHOT", "{}")
        if len(raw) > 1024 * 1024 or len(snapshot.encode("utf-8")) > 16 * 1024:
            raise ValueError("bounded input exceeded")
        answer = decision(json.loads(raw), json.loads(snapshot), plugin=sys.argv[1:] == ["--claim"])
    except (ValueError, TypeError) as error:
        print(f"track: Stop snapshot unavailable ({type(error).__name__})", file=sys.stderr)
        answer = {}
    print(json.dumps(answer, ensure_ascii=False))


if __name__ == "__main__":
    main()
