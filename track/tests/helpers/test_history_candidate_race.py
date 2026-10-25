"""FIXTURE regression for a candidate-open race; product remains unchanged."""
import os
from pathlib import Path
import subprocess
import sys
import unittest

from test_history import HISTORY, INLINE_FILE, HistoryFixture, compact


RUNNER = Path(__file__).resolve().with_name("history_candidate_race_runner.py")


class CandidateOpenRaceTests(HistoryFixture):
    """Exercise the actual bind helper with one process-local injected failure."""

    def setUp(self):
        super().setUp()
        self.environment["PYTHONDONTWRITEBYTECODE"] = "1"

    def candidate_inventory(self):
        parent = self.config / "plugins"
        inventory = []
        for path in [parent, *sorted(parent.rglob("*"))]:
            info = path.lstat()
            inventory.append((
                str(path.relative_to(self.config)), info.st_mode, info.st_uid,
                info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
                info.st_ctime_ns, path.read_bytes() if path.is_file() else None,
            ))
        return inventory

    def test_bind_without_injection_accepts_matching_candidate(self):
        self.engine_file()
        before = self.candidate_inventory()
        request = self.bind_request()
        completed, response = self.invoke(request, "candidate-open positive control")
        self.assert_ok(completed, response, "candidate-open positive control")
        self.assertEqual(response["store"], "plugins--" + INLINE_FILE[:-5])
        self.assertTrue((self.config / "state" / "track" / "v3" / response["store"]).is_dir())
        self.assertEqual(self.candidate_inventory(), before,
                         "ordinary bind must leave candidate files unchanged")

    def test_candidate_open_failure_refuses_with_one_json_line(self):
        self.engine_file()
        before = self.candidate_inventory()
        request = self.bind_request()
        injection_receipt = self.scratch / "candidate-open.receipt"
        completed = subprocess.run(
            [sys.executable, str(RUNNER), str(HISTORY), str(injection_receipt)],
            input=compact(request), capture_output=True, env=self.environment,
            cwd=self.scratch, timeout=20,
        )
        self.assertEqual(injection_receipt.read_text(encoding="utf-8"),
                         "candidate-open-error plugins\n",
                         "the first plugins open must reach the injected failure")
        self.assertFalse(os.path.lexists(self.config / "state" / "track" / "v3"),
                         "candidate-open failure must not authorize a v3 namespace")
        self.assertFalse(os.path.lexists(self.config / "cowork_plugins"),
                         "the other candidate must remain absent")
        self.assertEqual(self.candidate_inventory(), before,
                         "candidate-open failure must leave candidate files unchanged")
        self.assertEqual(completed.returncode, 1, "candidate-open refusal must exit 1")
        response = self.parse_response(completed, request, "candidate-open refusal")
        self.assert_refusal(completed, response, "candidate-open refusal")
        self.assertRegex(response.get("reason", ""), r"store identity (?:unproven|changed)",
                         "refusal must name the unproven or changed store identity")


if __name__ == "__main__":
    unittest.main()
