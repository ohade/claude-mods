#!/usr/bin/env python3
"""Track release gate: ordinary Stop remains available when classic hooks are bypassed.

Consumes only Track's small current-turn snapshot. No transcript or ledger storage reads.
"""
import json
import os
import sys


def decision(payload, snapshot):
    if not isinstance(payload, dict) or not isinstance(snapshot, dict):
        return {}
    if payload.get("agent_id") is not None or payload.get("stop_hook_active") is True:
        return {}
    if snapshot.get("v") != 1 or snapshot.get("session_id") != payload.get("session_id"):
        return {}
    if not isinstance(snapshot.get("turn_id"), str):
        return {}
    rows = snapshot.get("open")
    if not isinstance(rows, list) or not rows:
        return {}
    first = rows[0]
    if not isinstance(first, dict) or not isinstance(first.get("id"), int) or not isinstance(first.get("head"), str):
        return {}
    return {"decision": "block", "reason": (
        f'track: Q{first["id"]} "{first["head"]}" from this turn is still open. '
        f'Call mcp__track__mark_answered({{ id: {first["id"]}, status: "answered" }}) '
        'after answering, or status "deferred" with a note if it must wait. Then finish.'
    )}


def main():
    try:
        raw = sys.stdin.read(1024 * 1024 + 1)
        snapshot = os.environ.get("TRACK_GATE_SNAPSHOT", "{}")
        if len(raw) > 1024 * 1024 or len(snapshot.encode("utf-8")) > 16 * 1024:
            raise ValueError("bounded input exceeded")
        answer = decision(json.loads(raw), json.loads(snapshot))
    except (ValueError, TypeError) as error:
        print(f"track: Stop snapshot unavailable ({type(error).__name__})", file=sys.stderr)
        answer = {}
    print(json.dumps(answer, ensure_ascii=False))


if __name__ == "__main__":
    main()
