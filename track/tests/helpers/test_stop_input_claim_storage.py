"""FIXTURE: claim storage failures and input volume cannot lose Stop holds."""
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import test_stop_input_claim_failures as claim_fixture
import test_stop_inputs as inputs_fixture


stop = claim_fixture.stop


class InputClaimStorageTests(unittest.TestCase):
    def test_post_create_failure_leaves_the_input_available_for_retry(self):
        snapshot = {"v": 2, "session_id": inputs_fixture.SESSION, "turn_id": "t1",
                    "open": [], "candidates": [], "held": [],
                    "inputs": [{"id": 1, "reason": inputs_fixture.REASON}]}
        payload = {"session_id": inputs_fixture.SESSION}
        with tempfile.TemporaryDirectory() as config, patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": config}):
            with patch.object(stop.os, "fchmod", side_effect=PermissionError("FIXTURE: claim mode denied")):
                self.assertEqual(stop.decision(payload, snapshot), {})
            self.assertEqual(stop.decision(payload, snapshot),
                             {"decision": "block", "reason": inputs_fixture.REASON})
            self.assertEqual(stop.decision(payload, snapshot), {})

    def test_more_than_512_inputs_do_not_starve_expired_freshness_cleanup(self):
        with tempfile.TemporaryDirectory() as config, patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": config}):
            for identity in range(1, 514):
                self.assertTrue(stop.claim_once(inputs_fixture.SESSION, f"input:{identity}", "uncovered_input"))
            self.assertTrue(stop.claim_once(inputs_fixture.SESSION, "old-turn", "untracked_edit"))
            directory = Path(config) / "state" / "track" / "stop-holds"
            stale = directory / stop.claim_name(inputs_fixture.SESSION, "old-turn", "untracked_edit")
            old = time.time() - 8 * 24 * 60 * 60
            os.utime(stale, (old, old))
            original_iterdir = Path.iterdir

            def stale_last(path):
                # Directory order is unspecified: exercise the valid worst ordering.
                return iter(sorted(original_iterdir(path), key=lambda row: row == stale))

            with patch.object(Path, "iterdir", stale_last):
                stop.expire_holds(directory)
            self.assertFalse(stale.exists(), "permanent input claims starved the bounded freshness scan")

    def test_backdated_input_files_stay_consumed_in_any_storage_namespace(self):
        fixture = inputs_fixture.StopInputTests()
        with tempfile.TemporaryDirectory() as config:
            rows = [fixture.question()]
            self.assertEqual(fixture.invoke(config, rows).get("decision"), "block")
            files = [path for path in Path(config).rglob("*") if path.is_file()]
            self.assertTrue(files)
            old = time.time() - 8 * 24 * 60 * 60
            for path in files:
                os.utime(path, (old, old))
            self.assertEqual(fixture.invoke(config, rows, turn="later-turn"), {})


if __name__ == "__main__":
    unittest.main()
