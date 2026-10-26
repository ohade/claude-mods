"""FIXTURE: pending input claims survive aging and report partial storage success."""
import importlib.util
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import test_stop_inputs as inputs_fixture


SPEC = importlib.util.spec_from_file_location("input_claim_stop", inputs_fixture.SCRIPT)
stop = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stop)


class InputClaimFailureTests(unittest.TestCase):
    def test_seven_day_turn_cleanup_does_not_regrant_an_input_hold(self):
        fixture = inputs_fixture.StopInputTests()
        with tempfile.TemporaryDirectory() as config:
            rows = [fixture.question()]
            self.assertEqual(fixture.invoke(config, rows).get("decision"), "block")
            directory = Path(config) / "state" / "track" / "stop-holds"
            old = time.time() - 8 * 24 * 60 * 60
            for path in directory.iterdir():
                os.utime(path, (old, old))
            self.assertEqual(fixture.invoke(config, rows, turn="t2"), {})

    def test_later_claim_failure_still_returns_earlier_successful_hold(self):
        first = {"id": 1, "reason": inputs_fixture.REASON}
        second = {"id": 2, "reason": "track: the second input needs its own Track row."}
        snapshot = {"v": 2, "session_id": inputs_fixture.SESSION, "turn_id": "t1",
                    "open": [], "candidates": [], "held": [], "inputs": [first, second]}
        payload = {"session_id": inputs_fixture.SESSION}
        denied = stop.claim_name(inputs_fixture.SESSION, "input:2", "uncovered_input")
        original_open = os.open

        def fail_second_claim(path, flags, *args, **kwargs):
            if Path(path).name == denied:
                raise PermissionError("FIXTURE: second input claim denied")
            return original_open(path, flags, *args, **kwargs)

        with tempfile.TemporaryDirectory() as config, patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": config}):
            with patch.object(stop.os, "open", side_effect=fail_second_claim):
                self.assertEqual(stop.decision(payload, snapshot),
                                 {"decision": "block", "reason": first["reason"]})
            # The first claim persists; after storage recovers only the second input blocks.
            self.assertEqual(stop.decision(payload, snapshot),
                             {"decision": "block", "reason": second["reason"]})
            self.assertEqual(stop.decision(payload, snapshot), {})


if __name__ == "__main__":
    unittest.main()
