"""TRACK-52 bug-report helper: a quoted multi-word credential is removed whole.

Codex's independent review 2026-11-06: password="alpha beta gamma" left 'beta gamma' in the
outbound text, because the assignment pattern stopped at the first space. Checked through preview
(stdout, outbound.json) and the fake Plane CLI's title and description. The raw local note may
keep it; it is never sent.

Run: python3 -m unittest discover -s track/tests/helpers -p 'test_bug_report_shell_quotes.py' -v
"""

import json
import unittest

from test_bug_report import BugReportTest, record, transcript_records

WORDS = ("QWORD_one", "QWORD_two", "QWORD_three", "SWORD_four", "SWORD_five", "SWORD_six",
         "KWORD_seven", "KWORD_eight")
NOTE = 'it failed: password="QWORD_one QWORD_two QWORD_three" and token=\'SWORD_four SWORD_five SWORD_six\''
STDERR = 'export API_KEY="KWORD_seven KWORD_eight" then exit 1'


class QuotedAssignmentTest(BugReportTest):
    # Reuse the fixture only; the base tests run in their own module.
    for _name in [n for n in dir(BugReportTest) if n.startswith("test_")]:
        locals()[_name] = None
    del _name

    def test_quoted_multiword_values_never_leave_the_machine(self):
        rows = transcript_records() + [record("attachment", attachment={
            "type": "hook_non_blocking_error", "hookName": "Stop", "hookEvent": "Stop",
            "command": "bash gate.sh", "exitCode": 1, "stderr": STDERR})]
        self.write_transcript(self.transcript, rows)
        result, out = self.preview(note=NOTE)
        self.assertEqual(result.returncode, 0, result.stderr)
        draft = self.report_root() / out["draft_id"]
        filed = self.run_helper(["file"], {"v": 1, "draft_id": out["draft_id"]})
        self.assertEqual(filed.returncode, 0, filed.stderr)
        sent = " ".join(self.plane_calls()[0])
        outbound = (draft / "outbound.json").read_text()
        for word in WORDS:
            for where, text in (("stdout", result.stdout), ("outbound", outbound), ("plane", sent),
                                ("note_out", out["note_out"])):
                self.assertNotIn(word, text, f"{word} leaked in {where}")
        self.assertIn("QWORD_two", (draft / "note.local.txt").read_text())
        self.assertIn("password", json.loads(outbound)["note_out"])


if __name__ == "__main__":
    unittest.main()
