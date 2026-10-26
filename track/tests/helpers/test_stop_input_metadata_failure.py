"""FIXTURE: post-create metadata errors must not consume an input or another inode."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import test_stop_input_claim_failures as claim_fixture
import test_stop_inputs as inputs_fixture


stop = claim_fixture.stop


class InputMetadataFailureTests(unittest.TestCase):
    def snapshot(self):
        return {"v": 2, "session_id": inputs_fixture.SESSION, "turn_id": "t1",
                "open": [], "candidates": [], "held": [],
                "inputs": [{"id": 1, "reason": inputs_fixture.REASON}]}

    def test_fstat_failure_removes_the_claim_and_allows_the_same_input_to_retry(self):
        with tempfile.TemporaryDirectory() as config, patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": config}):
            with patch.object(stop.os, "fstat", side_effect=PermissionError("FIXTURE: fstat denied")):
                self.assertEqual(stop.decision({"session_id": inputs_fixture.SESSION}, self.snapshot()), {})
            self.assertEqual([path for path in Path(config).rglob("*") if path.is_file()], [],
                             "failed metadata lookup left a permanent input claim")
            self.assertEqual(stop.decision({"session_id": inputs_fixture.SESSION}, self.snapshot()),
                             {"decision": "block", "reason": inputs_fixture.REASON})

    def test_fstat_failure_closes_the_exclusively_created_descriptor(self):
        original_open, original_fstat = os.open, os.fstat
        descriptors = []

        def capture_open(path, flags, *args, **kwargs):
            descriptor = original_open(path, flags, *args, **kwargs)
            descriptors.append(descriptor)
            return descriptor

        with tempfile.TemporaryDirectory() as config, patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": config}):
            with patch.object(stop.os, "open", side_effect=capture_open), \
                 patch.object(stop.os, "fstat", side_effect=PermissionError("FIXTURE: fstat denied")):
                self.assertEqual(stop.decision({"session_id": inputs_fixture.SESSION}, self.snapshot()), {})
            self.assertEqual(len(descriptors), 1)
            try:
                with self.assertRaises(OSError, msg="failed metadata lookup leaked the claim descriptor"):
                    original_fstat(descriptors[0])
            finally:
                try:
                    os.close(descriptors[0])
                except OSError:
                    pass  # Expected when the helper already closed the descriptor.

    def test_recovery_preserves_a_replacement_at_the_claim_path(self):
        with tempfile.TemporaryDirectory() as config, patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": config}):
            name = stop.claim_name(inputs_fixture.SESSION, "input:1", "uncovered_input")
            claim = Path(config) / "state" / "track" / "stop-holds" / "inputs" / name

            def replace_then_deny(_descriptor):
                claim.rename(claim.with_suffix(".original"))
                claim.write_text("foreign replacement", encoding="utf-8")
                raise PermissionError("FIXTURE: metadata failed after replacement")

            with patch.object(stop.os, "fstat", side_effect=replace_then_deny):
                self.assertEqual(stop.decision({"session_id": inputs_fixture.SESSION}, self.snapshot()), {})
            self.assertEqual(claim.read_text(encoding="utf-8"), "foreign replacement")


if __name__ == "__main__":
    unittest.main()
