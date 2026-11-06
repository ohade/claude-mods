"""TRACK-52 bug-report helper: credentials written as JSON key/value pairs never leave the machine.

Codex review 2026-11-06: scrub left {"password":"PRIVACY_CANARY_6e2f"} intact. Hook stderr and the
person's note often carry JSON. Checked through the real preview path and outbound.json.

Run: python3 -m unittest discover -s track/tests/helpers -p 'test_bug_report_privacy.py' -v
"""

import json
import unittest

from test_bug_report import SID, BugReportTest, record, transcript_records

QUOTED = {
    "password": "PRIVACY_CANARY_6e2f",
    "token": "PRIVACY_CANARY_tok1",
    "api_key": "PRIVACY_CANARY_key2",
    "apiKey": "PRIVACY_CANARY_key3",
    "secret": "PRIVACY_CANARY_sec4",
}


class QuotedSecretTest(BugReportTest):
    # Reuse the fixture only; the base tests run in their own module.
    for _name in [n for n in dir(BugReportTest) if n.startswith("test_")]:
        locals()[_name] = None
    del _name

    def test_json_quoted_credentials_are_scrubbed_from_stderr_command_and_note(self):
        blob = json.dumps(QUOTED)
        compact = json.dumps(QUOTED, separators=(",", ":"))
        rows = transcript_records() + [record("attachment", attachment={
            "type": "hook_blocking_error", "hookName": "PreToolUse:Bash", "hookEvent": "PreToolUse",
            "command": "curl -d '" + compact + "' https://example.invalid", "exitCode": 2,
            "stderr": "request failed: " + blob})]
        self.write_transcript(self.transcript, rows)
        result, out = self.preview(note="it failed with " + compact)
        self.assertEqual(result.returncode, 0, result.stderr)
        outbound_text = (self.report_root() / out["draft_id"] / "outbound.json").read_text()
        for key, canary in QUOTED.items():
            for text in (outbound_text, result.stdout, result.stderr, out["note_out"]):
                self.assertNotIn(canary, text, key)
        self.assertTrue(out["note_changed"])
        # The key names stay, so the reader still sees what kind of value was removed.
        self.assertIn('"password"', outbound_text.replace('\\"', '"'))
        self.assertEqual(json.loads(outbound_text)["session_id"], SID)


if __name__ == "__main__":
    unittest.main()
