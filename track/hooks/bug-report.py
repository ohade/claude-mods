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
filed at most once; any failure after the create call was started is reported as ambiguous and the
draft stays locked, so it is never retried. Only a failure before the call releases the draft.

Exit codes: 0 success, 1 runtime failure (JSON {"ok": false, ...} on stdout), 2 usage error.
Environment: CLAUDE_CONFIG_DIR (default ~/.claude) roots every path read or written.
"""

import argparse
from collections import deque
from datetime import datetime, timezone
import html
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys

MAX_STDIN_BYTES = 256 * 1024
MAX_NOTE_CHARS = 4000
MAX_RECORD_BYTES = 8 * 1024 * 1024
EVENT_LIMIT = 200
FAILURE_LIMIT = 50
STDERR_LIMIT = 2048
COMMAND_LIMIT = 500
WORKSPACE, PROJECT = "dv", "TRACK"
DRAFT_ID = re.compile(r"^\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{8}$")
SESSION_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
HOOK_FAILURES = {"hook_non_blocking_error", "hook_blocking_error", "hook_error"}
HANDOFF_FIELDS = ("phase", "cycleId", "failedCycles", "unclearedRuns", "autoChain", "backoffTokens")
SECRET_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bsk-ant-[A-Za-z0-9_-]{10,}"),
    re.compile(r"\bsk-[A-Za-z0-9]{20,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{10,}"),
)
SECRET_ASSIGNMENT = re.compile(r"(?i)\b(password|passwd|secret|token|api[_-]?key)(\s*[=:]\s*)\S+")
# JSON pairs such as {"password": "..."}: the key stays so the reader sees what was removed.
SECRET_JSON = re.compile(r'(?i)("(?:password|passwd|secret|token|api[_-]?key)"\s*:\s*)"(?:[^"\\]|\\.)*"')


class UsageError(Exception):
    pass


class Failure(Exception):
    def __init__(self, message, **fields):
        super().__init__(message)
        self.fields = fields


def scrub(text):
    for pattern in SECRET_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    text = SECRET_JSON.sub(lambda m: m.group(1) + '"[REDACTED]"', text)
    return SECRET_ASSIGNMENT.sub(lambda m: m.group(1) + m.group(2) + "[REDACTED]", text)


def scrub_value(value):
    if isinstance(value, str):
        return scrub(value)
    if isinstance(value, list):
        return [scrub_value(item) for item in value]
    if isinstance(value, dict):
        return {key: scrub_value(item) for key, item in value.items()}
    return value


def config_dir():
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")


def report_root():
    return config_dir() / "state" / "track-reports"


def read_request():
    raw = sys.stdin.read(MAX_STDIN_BYTES + 1)
    if len(raw) > MAX_STDIN_BYTES:
        raise UsageError("request exceeds 256 KiB")
    try:
        request = json.loads(raw)
    except ValueError:
        raise UsageError("request is not valid JSON") from None
    if not isinstance(request, dict) or request.get("v") != 1:
        raise UsageError("request must be a v1 JSON object")
    return request


def session_of(record):
    return record.get("sessionId") if isinstance(record, dict) else None


def resolve_transcript(session_id, given):
    """The bound transcript path, or None when no unique session file exists (never invented)."""
    if given is not None:
        path = Path(given)
        if path.name != f"{session_id}.jsonl" or not path.is_file():
            raise Failure("transcript_path is not this session's transcript")
        return path
    matches = [p for p in (config_dir() / "projects").glob(f"*/{session_id}.jsonl") if p.is_file()]
    return matches[0] if len(matches) == 1 else None


def scan_transcript(path, session_id):
    """Hook failures and event metadata; message, answer and tool bodies are never read out."""
    failures = deque(maxlen=FAILURE_LIMIT)
    events = deque(maxlen=EVENT_LIMIT)
    bound = False
    with path.open("rb") as stream:
        for line in stream:
            if len(line) > MAX_RECORD_BYTES:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            owner = session_of(record)
            if owner is not None and not bound:
                if owner != session_id:
                    raise Failure("transcript belongs to another session")
                bound = True
            attachment = record.get("attachment") if isinstance(record.get("attachment"), dict) else {}
            event = {"type": record.get("type")}
            if attachment:
                event["attachment_type"] = attachment.get("type")
                if attachment.get("hookName"):
                    event["hookName"] = attachment.get("hookName")
            if record.get("timestamp"):
                event["timestamp"] = record.get("timestamp")
            events.append(event)
            if attachment.get("type") in HOOK_FAILURES:
                failures.append({
                    "hookName": attachment.get("hookName"), "hookEvent": attachment.get("hookEvent"),
                    "exitCode": attachment.get("exitCode"), "timestamp": record.get("timestamp"),
                    "command": scrub(str(attachment.get("command") or ""))[:COMMAND_LIMIT],
                    "stderr": scrub(str(attachment.get("stderr") or ""))[:STDERR_LIMIT]})
    if not bound:
        raise Failure("transcript has no record bound to this session")
    return list(failures), list(events)


def handoff_state(session_id):
    path = config_dir() / "state" / "context-handoff" / "sessions" / f"{session_id}.json"
    try:
        state = json.loads(path.read_text())
    except (OSError, ValueError):
        return "unavailable"
    picked = {field: state.get(field) for field in HANDOFF_FIELDS if field in state}
    nudge = state.get("nudge")
    picked["nudge_turnEnds"] = nudge.get("turnEnds") if isinstance(nudge, dict) else None
    return picked


def peer_identity(request):
    track = request.get("track_build") if isinstance(request.get("track_build"), dict) else {}
    peers = {"track": {"loaded": track.get("loaded"), "disk": track.get("disk")}}
    try:
        installed = json.loads((config_dir() / "plugins" / "installed_plugins.json").read_text())
        entry = next((entries[0] for key, entries in installed.get("plugins", {}).items()
                      if key.startswith("prismantis@") and entries), None)
    except (OSError, ValueError, AttributeError):
        entry = None
    peers["prismantis"] = ({"version": entry.get("version"), "commit": entry.get("gitCommitSha")}
                           if isinstance(entry, dict) else "unknown")
    try:
        manifest = json.loads((config_dir() / "mods" / "context-handoff" / ".claude-plugin" / "plugin.json").read_text())
        peers["context-handoff"] = {"version": manifest.get("version")}
    except (OSError, ValueError, AttributeError):
        peers["context-handoff"] = "unknown"
    return peers


def private_file(path, text):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(text)


def preview(request):
    session_id = request.get("session_id")
    note = request.get("note")
    if not isinstance(session_id, str) or not SESSION_ID.match(session_id):
        raise UsageError("session_id must be a session UUID")
    if not isinstance(note, str) or len(note) > MAX_NOTE_CHARS:
        raise UsageError(f"note must be text of at most {MAX_NOTE_CHARS} characters")
    given = request.get("transcript_path")
    if given is not None and not isinstance(given, str):
        raise UsageError("transcript_path must be a string when present")
    transcript = resolve_transcript(session_id, given)
    failures, events = scan_transcript(transcript, session_id) if transcript else ("unavailable", "unavailable")
    note_out = scrub(note)
    outbound = {
        "v": 1, "session_id": session_id, "transcript_path": str(transcript) if transcript else None,
        "cwd": scrub(str(request.get("cwd") or "")), "cc_version": request.get("cc_version"),
        "peers": scrub_value(peer_identity(request)), "context_handoff": handoff_state(session_id),
        "hook_failures": failures, "events": events,
        "diagnose": scrub_value(request.get("diagnose")), "note_out": note_out}
    root = report_root()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    draft_id = f"{stamp}-{session_id[:8]}-{secrets.token_hex(4)}"
    draft = root / draft_id
    draft.mkdir(mode=0o700)
    os.chmod(draft, 0o700)
    private_file(draft / "note.local.txt", note)
    private_file(draft / "outbound.json", json.dumps(outbound, indent=1))
    scope = ["note" + (" (secrets removed)" if note_out != note else ""),
             "session id, Claude Code version, Track/prismantis/context-handoff versions",
             "Track diagnose bundle (ids and counts)"]
    if transcript is None:
        scope.append("transcript unavailable: no unique session file, so no hook failures or events")
    else:
        scope.append(f"{len(failures)} hook failure(s): hook, exit code, command and stderr (secrets removed, stderr at most 2 KiB)")
        scope.append(f"{len(events)} transcript events: type, hook name and time only")
    scope.append("context-handoff state: phase and counters" if outbound["context_handoff"] != "unavailable"
                 else "context-handoff state unavailable")
    return {"ok": True, "draft_id": draft_id, "draft_dir": str(draft), "scope": scope,
            "note_out": note_out, "note_changed": note_out != note}


def owned_draft(draft_id):
    if not isinstance(draft_id, str) or not DRAFT_ID.match(draft_id):
        raise UsageError("draft_id is not a draft made by preview")
    draft = report_root() / draft_id
    info = os.lstat(draft) if os.path.lexists(draft) else None
    if info is None or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise Failure("no such draft", ambiguous=False)
    if not (draft / "outbound.json").is_file():
        raise Failure("draft has no outbound.json", ambiguous=False)
    return draft


def ticket_text(outbound, draft):
    note = outbound.get("note_out") or ""
    first = " ".join(note.split())[:60] or "no note"
    lines = [note, "", "---", f"Session: {outbound.get('session_id')}",
             f"Transcript: {outbound.get('transcript_path') or 'unavailable'}",
             f"Report draft (local): {draft}", f"Claude Code: {outbound.get('cc_version')}",
             f"Versions: {json.dumps(outbound.get('peers'), sort_keys=True)}",
             f"context-handoff: {json.dumps(outbound.get('context_handoff'), sort_keys=True)}"]
    failures = outbound.get("hook_failures")
    if isinstance(failures, list):
        lines.append(f"Hook failures: {len(failures)}")
        for failure in failures[-10:]:
            lines.append(f"- {failure.get('timestamp')} {failure.get('hookName')} exit {failure.get('exitCode')}: "
                         f"{failure.get('command')} | {failure.get('stderr')[:300]}")
    else:
        lines.append("Hook failures: unavailable (no unique transcript)")
    lines.append(f"Diagnose: {json.dumps(outbound.get('diagnose'), sort_keys=True)[:4000]}")
    # plane-cli sends --description as raw HTML (<p>{description}</p>): escape it so notes and logs show literally.
    return f"🐞 Report: {first}", html.escape(scrub("\n".join(lines))).replace("\n", "<br>")


def file_ticket(request, timeout):
    draft = owned_draft(request.get("draft_id"))
    marker = draft / "filing"
    try:
        private_file(marker, "in flight\n")
    except FileExistsError:
        raise Failure("this draft was already filed or its filing is in flight or ambiguous", ambiguous=False) from None
    cli = config_dir() / "skills" / "plane-tasks" / "scripts" / "plane-cli.py"
    try:
        outbound = json.loads((draft / "outbound.json").read_text())
        if not cli.is_file():
            raise Failure(f"Plane CLI not found at {cli}", ambiguous=False)
        title, description = ticket_text(outbound, draft)
    except (Failure, OSError, ValueError) as error:
        marker.unlink()  # nothing was sent: the person may file this draft again
        if isinstance(error, Failure):
            raise
        raise Failure("could not read the draft", ambiguous=False) from None
    argv = [sys.executable, str(cli), "create", WORKSPACE, PROJECT, title, "--state-name", "Backlog",
            "--priority", "medium", "--label-names", "🐞 Bug", "--description", description]
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        marker.write_text("ambiguous: timeout\n")
        raise Failure("Plane did not answer in time; check Plane before filing again", ambiguous=True) from None
    created = re.search(r"Created #(\d+):", result.stdout or "")
    if result.returncode != 0 or created is None:
        marker.write_text(f"ambiguous: exit {result.returncode}\n")
        raise Failure("Plane returned an error after the create call; check Plane before filing again", ambiguous=True)
    ticket = f"{PROJECT}-{created.group(1)}"
    marker.write_text(ticket + "\n")
    return {"ok": True, "ticket": ticket}


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
    if args.command == "file" and not 1 <= args.timeout_seconds <= 60:
        parser.error("--timeout-seconds must be between 1 and 60")
    return args


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        request = read_request()
        result = preview(request) if args.command == "preview" else file_ticket(request, args.timeout_seconds)
    except UsageError as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        print(f"bug-report: {error}", file=sys.stderr)
        return 2
    except Failure as error:
        print(json.dumps(dict({"ok": False, "error": str(error)}, **error.fields)))
        print(f"bug-report: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    except Exception as error:  # noqa: BLE001 - the protocol promises JSON, never a traceback
        print(json.dumps({"ok": False, "error": type(error).__name__}))
        print(f"bug-report: unexpected {type(error).__name__}", file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
