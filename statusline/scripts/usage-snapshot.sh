#!/usr/bin/env python3
"""
usage-snapshot.sh — LOCAL, no-API Opus usage snapshot for the status line.

Reports the CURRENT billing week's Opus burn as a PERCENT of your own busiest
Opus week ever (a self-raising personal ceiling), plus days-to-the-real-reset.
NOT the server limit (that's only in the live /usage API, which the status line
must never call) — it's "% of your peak week", and if this week beats the record
it can read >100% and then becomes the new ceiling automatically next week.

How: bucket every Opus token (from ~/.claude/projects/**/*.jsonl assistant turns,
message.usage) into reset-anchored 7-day billing weeks (the CLI's own token cache
is dead/frozen 2026-03, so we read transcripts directly). current = this week's
bucket; ceiling = max over all OTHER (completed) weeks; pct = current/ceiling.
Excludes subagent transcripts. Atomic write. NEVER calls any API/claude CLI.
Fails silent. ~1.3s over ~500 files.

Reset anchor: weekly limit resets on a fixed 7-day cadence. ANCHOR is one known
reset instant (from /usage); override via ~/.claude/usage-reset-anchor.conf.
"""
import datetime as dt
import glob
import json
import math
import os
import sys
from collections import defaultdict

HOME = os.path.expanduser("~")
PROJECTS = os.path.join(HOME, ".claude", "projects")
OUT = os.path.join(HOME, ".claude", "usage-snapshot.json")
ANCHOR_CONF = os.path.join(HOME, ".claude", "usage-reset-anchor.conf")

DEFAULT_ANCHOR_LOCAL = "2026-06-25T11:59:00"   # Wed, from /usage
ANCHOR_TZ = "Asia/Jerusalem"
WEEK = dt.timedelta(days=7)
WEEK_S = WEEK.total_seconds()


def anchor_utc():
    raw = DEFAULT_ANCHOR_LOCAL
    if os.path.exists(ANCHOR_CONF):
        try:
            raw = open(ANCHOR_CONF).read().strip() or raw
        except Exception:
            pass
    try:
        from zoneinfo import ZoneInfo
        return dt.datetime.fromisoformat(raw).replace(tzinfo=ZoneInfo(ANCHOR_TZ)).astimezone(dt.timezone.utc)
    except Exception:
        return dt.datetime.fromisoformat(raw).replace(tzinfo=dt.timezone(dt.timedelta(hours=3))).astimezone(dt.timezone.utc)


def parse_ts(ts):
    try:
        return dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except Exception:
        return None


def main():
    now = dt.datetime.now(dt.timezone.utc)
    a = anchor_utc()

    def bucket(d):
        return math.floor((d - a).total_seconds() / WEEK_S)

    cur_b = bucket(now)
    next_reset = a + WEEK * (cur_b + 1)
    days_to_reset = round((next_reset - now).total_seconds() / 86400.0, 1)

    files = [f for f in glob.glob(os.path.join(PROJECTS, "**", "*.jsonl"), recursive=True)
             if "/subagents/" not in f and not os.path.basename(f).startswith("agent-")]
    if not files:
        print("no session files", file=sys.stderr)
        return 1

    weeks = defaultdict(int)   # bucket index -> opus tokens
    for path in files:
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if '"assistant"' not in line or "opus" not in line:
                        continue
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue
                    if r.get("type") != "assistant":
                        continue
                    msg = r.get("message") or {}
                    if "opus" not in (msg.get("model") or "").lower():
                        continue
                    u = msg.get("usage") or {}
                    tok = (u.get("input_tokens") or 0) + (u.get("output_tokens") or 0)
                    if not tok:
                        continue
                    d = parse_ts(r.get("timestamp"))
                    if d is None:
                        continue
                    weeks[bucket(d)] += tok
        except Exception:
            continue

    current = weeks.get(cur_b, 0)
    prior = [v for k, v in weeks.items() if k != cur_b]
    ceiling = max(prior) if prior else (current or 1)
    pct = round(100 * current / ceiling) if ceiling else 0
    is_new_high = bool(prior) and current > ceiling

    snap = {
        "generated_at": now.isoformat(timespec="seconds"),
        "pct": pct,
        "opus_week_tokens": current,
        "ceiling_tokens": ceiling,          # busiest prior week (self-raising)
        "is_new_high": is_new_high,
        "days_to_reset": days_to_reset,
        "reset_at_utc": next_reset.isoformat(timespec="minutes"),
        "weeks_observed": len(weeks),
    }
    tmp = OUT + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(snap, fh)
    os.replace(tmp, OUT)
    print(json.dumps(snap))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"snapshot failed: {e}", file=sys.stderr)
        sys.exit(1)
