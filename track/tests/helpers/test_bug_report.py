"""TRACK-52 bug-report helper: protocol, privacy, binding and single-filing checks.

Every run uses a temporary CLAUDE_CONFIG_DIR and HOME. The Plane CLI is a fake placed at the fixed
path inside that temporary config, so nothing here can post to a real Plane.

Run: python3 -m unittest discover -s track/tests/helpers -p 'test_bug_report.py' -v
"""

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

HELPER = Path(__file__).resolve().parents[2] / "hooks" / "bug-report.py"
SID = "0b52aa52-1111-4222-8333-444455556666"
OTHER_SID = "0b52aa52-9999-4222-8333-444455556666"
# Canaries: none may appear in anything the helper prints or puts in outbound.json.
PROMPT_CANARY = "PROMPT_BODY_CANARY_7f3a"
ANSWER_CANARY = "ANSWER_BODY_CANARY_91c2"
TOOL_CANARY = "TOOL_BODY_CANARY_55e0"
LAST_RESPONSE_CANARY = "LAST_RESPONSE_CANARY_c41d"
API_KEY = "sk-ant-api03-" + "Q" * 40
GH_TOKEN = "ghp_" + "Z" * 36

FAKE_PLANE = r'''#!/usr/bin/env python3
import json, os, sys, time
log = os.path.join(os.environ["CLAUDE_CONFIG_DIR"], "fake-plane-calls.jsonl")
with open(log, "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\n")
mode = open(os.path.join(os.environ["CLAUDE_CONFIG_DIR"], "fake-plane-mode")).read().strip()
if mode == "sleep":
    time.sleep(5)
if mode == "fail":
    print("Error: 500 from Plane", file=sys.stderr)
    sys.exit(1)
print("Created #77: report (id: 0000-fake)")
'''


def record(kind, **fields):
    return dict({"type": kind, "sessionId": SID, "timestamp": "2026-11-06T00:00:00Z"}, **fields)


def transcript_records(session_id=SID):
    rows = [
        {"type": "file-history-snapshot", "messageId": "m0", "snapshot": {}},  # no sessionId
        record("user", message={"role": "user", "content": PROMPT_CANARY}),
        record("assistant", message={"role": "assistant", "content": [{"type": "text", "text": ANSWER_CANARY}]}),
        record("user", message={"role": "user", "content": [{"type": "tool_result", "content": TOOL_CANARY}]}),
        record("attachment", attachment={
            "type": "hook_non_blocking_error", "hookName": "SessionStart:compact", "hookEvent": "SessionStart",
            "command": f"bash session-context.sh --key {API_KEY}", "exitCode": 1,
            "stderr": f"failed: token={GH_TOKEN}"}),
        record("attachment", attachment={"type": "hook_success", "hookName": "Stop", "content": ANSWER_CANARY}),
    ]
    for row in rows:
        if "sessionId" in row:
            row["sessionId"] = session_id
    return rows


class BugReportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = self.root / "config"
        project = self.config / "projects" / "-Users-x-git"
        project.mkdir(parents=True)
        self.transcript = project / f"{SID}.jsonl"
        self.write_transcript(self.transcript, transcript_records())
        sessions = self.config / "state" / "context-handoff" / "sessions"
        sessions.mkdir(parents=True)
        (sessions / f"{SID}.json").write_text(json.dumps({
            "version": 9, "sessionId": SID, "phase": "IDLE", "cycleId": "c-7", "failedCycles": 1,
            "unclearedRuns": 0, "autoChain": 0, "backoffTokens": None, "nudge": {"at": 1, "turnEnds": 2},
            "lastResponse": LAST_RESPONSE_CANARY, "briefPath": "/secret/brief.md"}))
        plane = self.config / "skills" / "plane-tasks" / "scripts"
        plane.mkdir(parents=True)
        (plane / "plane-cli.py").write_text(FAKE_PLANE)
        self.set_plane_mode("ok")
        cache = self.config / "plugins" / "cache" / "prismantis" / "prismantis" / "0.42.0"
        cache.mkdir(parents=True)
        (self.config / "plugins" / "installed_plugins.json").write_text(json.dumps({"version": 2, "plugins": {
            "prismantis@prismantis": [{"installPath": str(cache), "version": "0.42.0", "gitCommitSha": "6dba97df" + "0" * 32}]}}))
        # The config dir is itself a git repo, like ~/.claude: a cache path must not inherit its HEAD.
        subprocess.run(["git", "init", "-q", str(self.config)], check=True)
        subprocess.run(["git", "-C", str(self.config), "-c", "user.email=t@t", "-c", "user.name=t",
                        "commit", "-q", "--allow-empty", "-m", "config"], check=True)
        self.config_head = subprocess.run(["git", "-C", str(self.config), "rev-parse", "HEAD"],
                                          capture_output=True, text=True, check=True).stdout.strip()

    def tearDown(self):
        self.temp.cleanup()

    def write_transcript(self, path, rows):
        path.write_text("".join(json.dumps(row) + "\n" for row in rows))

    def set_plane_mode(self, mode):
        (self.config / "fake-plane-mode").write_text(mode)

    def plane_calls(self):
        log = self.config / "fake-plane-calls.jsonl"
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def report_root(self):
        return self.config / "state" / "track-reports"

    def drafts(self):
        root = self.report_root()
        return sorted(p for p in root.iterdir() if p.is_dir()) if root.exists() else []

    def request(self, **over):
        body = {"v": 1, "session_id": SID, "transcript_path": str(self.transcript), "cwd": "/Users/x/git",
                "cc_version": "2.1.318", "track_build": {"loaded": "6f201d7", "disk": "6f201d7"},
                "diagnose": {"session_id": SID, "ring": [], "truncated": False},
                "note": "the tracker said waiting on you while it was working"}
        body.update(over)
        return body

    def run_helper(self, args, payload=None, raw=None):
        stdin = raw if raw is not None else (json.dumps(payload) if payload is not None else "")
        env = dict(os.environ, CLAUDE_CONFIG_DIR=str(self.config), HOME=str(self.root / "home"))
        return subprocess.run([sys.executable, str(HELPER), *args], input=stdin, capture_output=True,
                              text=True, env=env, timeout=30)

    def preview(self, **over):
        result = self.run_helper(["preview"], self.request(**over))
        return result, (json.loads(result.stdout) if result.stdout.strip() else None)

    def assert_no_leak(self, *texts):
        for text in texts:
            for canary in (PROMPT_CANARY, ANSWER_CANARY, TOOL_CANARY, LAST_RESPONSE_CANARY, API_KEY, GH_TOKEN):
                self.assertNotIn(canary, text)

    # --- protocol -------------------------------------------------------------------------------

    def test_help_and_no_args_change_nothing(self):
        self.assertEqual(self.run_helper(["-h"]).returncode, 0)
        self.assertEqual(self.run_helper([]).returncode, 2)
        self.assertEqual(self.run_helper(["bogus"]).returncode, 2)
        self.assertFalse(self.report_root().exists())
        self.assertEqual(self.plane_calls(), [])

    def test_malformed_request_is_usage_error_without_echo(self):
        result = self.run_helper(["preview"], raw="{not json " + API_KEY)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("Traceback", result.stderr)
        self.assert_no_leak(result.stdout, result.stderr)
        self.assertFalse(self.report_root().exists())

    # --- preview: content -----------------------------------------------------------------------

    def test_preview_writes_private_scrubbed_draft_with_metadata_only(self):
        result, out = self.preview()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(out["ok"])
        draft = self.report_root() / out["draft_id"]
        self.assertNotIn("/", out["draft_id"])
        self.assertEqual(stat.S_IMODE(draft.stat().st_mode), 0o700)
        for name in ("note.local.txt", "outbound.json"):
            self.assertEqual(stat.S_IMODE((draft / name).stat().st_mode), 0o600, name)
        outbound_text = (draft / "outbound.json").read_text()
        outbound = json.loads(outbound_text)
        self.assert_no_leak(outbound_text, result.stdout, result.stderr)
        failure = outbound["hook_failures"][0]
        self.assertEqual([failure["hookName"], failure["exitCode"]], ["SessionStart:compact", 1])
        self.assertIn("session-context.sh", failure["command"])
        self.assertEqual(outbound["session_id"], SID)
        events = outbound["events"]
        self.assertTrue(events)
        self.assertTrue(all(set(event) <= {"type", "attachment_type", "hookName", "timestamp"} for event in events))
        handoff = outbound["context_handoff"]
        self.assertEqual([handoff["phase"], handoff["failedCycles"], handoff["nudge_turnEnds"]], ["IDLE", 1, 2])
        self.assertNotIn("lastResponse", handoff)
        self.assertNotIn("briefPath", handoff)
        self.assertTrue(any("hook failure" in line for line in out["scope"]))

    def test_note_with_secret_is_scrubbed_outbound_but_kept_locally(self):
        result, out = self.preview(note=f"it broke, my key is {API_KEY}")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(out["note_changed"])
        self.assertNotIn(API_KEY, out["note_out"])
        draft = self.report_root() / out["draft_id"]
        self.assertIn(API_KEY, (draft / "note.local.txt").read_text())
        self.assertNotIn(API_KEY, (draft / "outbound.json").read_text())

    # --- preview: session binding ---------------------------------------------------------------

    def test_transcript_of_another_session_is_refused(self):
        foreign = self.transcript.with_name(f"{SID}.jsonl")
        self.write_transcript(foreign, transcript_records(OTHER_SID))
        result, out = self.preview()
        self.assertEqual(result.returncode, 1)
        self.assertFalse(out["ok"])
        self.assertEqual(self.drafts(), [])

    def test_missing_transcript_path_resolves_the_unique_session_file(self):
        request = self.request()
        del request["transcript_path"]
        result = self.run_helper(["preview"], request)
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        outbound = json.loads((self.report_root() / out["draft_id"] / "outbound.json").read_text())
        self.assertEqual(outbound["transcript_path"], str(self.transcript))
        self.assertEqual(outbound["hook_failures"][0]["hookName"], "SessionStart:compact")

    def test_no_or_ambiguous_transcript_says_unavailable(self):
        second = self.config / "projects" / "-Users-x-other"
        second.mkdir()
        self.write_transcript(second / f"{SID}.jsonl", transcript_records())
        request = self.request()
        del request["transcript_path"]
        result = self.run_helper(["preview"], request)
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        outbound = json.loads((self.report_root() / out["draft_id"] / "outbound.json").read_text())
        self.assertIsNone(outbound["transcript_path"])
        self.assertEqual(outbound["hook_failures"], "unavailable")
        self.assertTrue(any("transcript unavailable" in line for line in out["scope"]))

    # --- peer identity --------------------------------------------------------------------------

    def test_peer_identity_never_borrows_the_config_repo_head(self):
        result, out = self.preview()
        self.assertEqual(result.returncode, 0, result.stderr)
        text = (self.report_root() / out["draft_id"] / "outbound.json").read_text()
        peers = json.loads(text)["peers"]
        self.assertEqual(peers["prismantis"]["version"], "0.42.0")
        self.assertTrue(peers["prismantis"]["commit"].startswith("6dba97df"))
        self.assertEqual(peers["track"], {"loaded": "6f201d7", "disk": "6f201d7"})
        self.assertNotIn(self.config_head, text)

    # --- file -----------------------------------------------------------------------------------

    def test_file_creates_one_ticket_and_refuses_a_second(self):
        _, out = self.preview(note="pane froze after compact")
        first = self.run_helper(["file"], {"v": 1, "draft_id": out["draft_id"]})
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(json.loads(first.stdout), {"ok": True, "ticket": "TRACK-77"})
        calls = self.plane_calls()
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][:3], ["create", "dv", "TRACK"])
        description = calls[0][calls[0].index("--description") + 1]
        self.assertIn("pane froze after compact", description)
        self.assertIn(SID, description)
        self.assert_no_leak(" ".join(calls[0]))
        second = self.run_helper(["file"], {"v": 1, "draft_id": out["draft_id"]})
        self.assertEqual(second.returncode, 1)
        self.assertEqual(len(self.plane_calls()), 1)

    def test_file_rejects_a_draft_id_that_is_not_an_owned_draft(self):
        self.preview()
        for draft_id in ("../outside", "/tmp/x", "", "no-such-draft"):
            result = self.run_helper(["file"], {"v": 1, "draft_id": draft_id})
            self.assertIn(result.returncode, (1, 2), draft_id)
        self.assertEqual(self.plane_calls(), [])

    def test_timeout_after_send_is_ambiguous_and_never_retried(self):
        _, out = self.preview()
        self.set_plane_mode("sleep")
        first = self.run_helper(["file", "--timeout-seconds", "1"], {"v": 1, "draft_id": out["draft_id"]})
        self.assertEqual(first.returncode, 1)
        self.assertEqual(json.loads(first.stdout)["ambiguous"], True)
        self.set_plane_mode("ok")
        again = self.run_helper(["file"], {"v": 1, "draft_id": out["draft_id"]})
        self.assertEqual(again.returncode, 1)
        self.assertEqual(len(self.plane_calls()), 1)
        self.assertTrue((self.report_root() / out["draft_id"] / "note.local.txt").exists())

    def test_plane_error_after_create_was_sent_is_ambiguous(self):
        # Codex review 2026-11-06: an error printed after create was invoked cannot prove nothing was created.
        _, out = self.preview()
        self.set_plane_mode("fail")
        failed = self.run_helper(["file"], {"v": 1, "draft_id": out["draft_id"]})
        self.assertEqual(failed.returncode, 1)
        body = json.loads(failed.stdout)
        self.assertEqual([body["ok"], body["ambiguous"]], [False, True])
        self.set_plane_mode("ok")
        again = self.run_helper(["file"], {"v": 1, "draft_id": out["draft_id"]})
        self.assertEqual(again.returncode, 1)
        self.assertEqual(len(self.plane_calls()), 1)

    def test_failure_before_create_is_definite_and_retryable(self):
        _, out = self.preview()
        cli = self.config / "skills" / "plane-tasks" / "scripts" / "plane-cli.py"
        parked = cli.with_name("parked.py")
        cli.rename(parked)
        failed = self.run_helper(["file"], {"v": 1, "draft_id": out["draft_id"]})
        self.assertEqual(failed.returncode, 1)
        body = json.loads(failed.stdout)
        self.assertEqual([body["ok"], body["ambiguous"]], [False, False])
        self.assertEqual(self.plane_calls(), [])
        parked.rename(cli)
        retried = self.run_helper(["file"], {"v": 1, "draft_id": out["draft_id"]})
        self.assertEqual(retried.returncode, 0, retried.stderr)
        self.assertEqual(len(self.plane_calls()), 1)

if __name__ == "__main__":
    unittest.main()
