#!/usr/bin/env python3
"""TRACK-52 bug-report helper: build a scrubbed debug bundle for a Track session, then file it.

Tier C internal helper with a fixed protocol. Track's pane calls it; a person presses the button.

  bug-report.py preview   stdin: request JSON v1   stdout: preview JSON
  bug-report.py file      stdin: {"v":1,"draft_id":...}   stdout: file JSON

Request v1 (from the Track runtime, never from model text):
  {"v": 1, "session_id": <uuid>, "transcript_path": <path or absent>, "cwd": <path>,
   "cc_version": <str>, "track_build": {"loaded": <str|null>, "disk": <str|null>},
   "diagnose": <Track diagnose bundle object>, "note": <the person's text>}

preview collects metadata only (no prompt, answer or tool bodies), scrubs secrets, and writes a
private draft under $CLAUDE_CONFIG_DIR/state/track-reports/<draft_id>/: note.local.txt (the raw
note, never sent) and outbound.json (what file sends). It posts nothing.

file creates exactly one Plane ticket (workspace dv, project TRACK) from an owned draft. A draft is
filed at most once; a timeout after the create was sent is reported as ambiguous and never retried.

Exit codes: 0 success, 1 runtime failure (JSON {"ok": false, ...} on stdout), 2 usage error.
Environment: CLAUDE_CONFIG_DIR (default ~/.claude) roots every path read or written.
"""

import argparse
import json
import sys

MAX_STDIN_BYTES = 256 * 1024


def parse_args(argv):
    parser = argparse.ArgumentParser(prog="bug-report.py", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", metavar="{preview,file}")
    commands.add_parser("preview", help="collect and scrub context into a private draft; posts nothing")
    filing = commands.add_parser("file", help="create one Plane ticket from a draft made by preview")
    filing.add_argument("--timeout-seconds", type=int, default=20,
                        help="bound on the Plane create call, 1..60 (default 20)")
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_usage(sys.stderr)
        sys.exit(2)
    return args


def main(argv=None):
    parse_args(sys.argv[1:] if argv is None else argv)
    # Stage A scaffold (2026-11-06): the protocol exists, the behaviour does not yet.
    print(json.dumps({"ok": False, "error": "not implemented"}))
    print("bug-report: not implemented", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
