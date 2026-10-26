"""FIXTURE: claim metadata errors must not consume an input, leak a descriptor or touch another inode."""
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
                "inputs": [{"id": 1, "reason": inputs_fixture.REASON}], "inputs_complete": True}

    def test_metadata_failure_before_publication_leaves_no_file_and_allows_retry(self):
        with tempfile.TemporaryDirectory() as config, patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": config}):
            with patch.object(stop.os, "fchmod", side_effect=PermissionError("FIXTURE: claim mode denied")):
                self.assertEqual(stop.decision({"session_id": inputs_fixture.SESSION}, self.snapshot()), {})
            self.assertEqual([path for path in Path(config).rglob("*") if path.is_file()], [],
                             "failed metadata write left a permanent input claim or a temp")
            self.assertEqual(stop.decision({"session_id": inputs_fixture.SESSION}, self.snapshot()),
                             {"decision": "block", "reason": inputs_fixture.REASON})

    def test_metadata_failure_closes_the_created_descriptor(self):
        original_open, original_fstat = os.open, os.fstat
        descriptors = []

        def capture_open(path, flags, *args, **kwargs):
            descriptor = original_open(path, flags, *args, **kwargs)
            descriptors.append(descriptor)
            return descriptor

        with tempfile.TemporaryDirectory() as config, patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": config}):
            with patch.object(stop.os, "open", side_effect=capture_open), \
                 patch.object(stop.os, "fchmod", side_effect=PermissionError("FIXTURE: claim mode denied")):
                self.assertEqual(stop.decision({"session_id": inputs_fixture.SESSION}, self.snapshot()), {})
            self.assertEqual(len(descriptors), 1)
            try:
                with self.assertRaises(OSError, msg="failed metadata write leaked the claim descriptor"):
                    original_fstat(descriptors[0])
            finally:
                try:
                    os.close(descriptors[0])
                except OSError:
                    pass  # Expected when the helper already closed the descriptor.

    def test_failure_after_publication_keeps_a_replacement_and_reports_held(self):
        with tempfile.TemporaryDirectory() as config, patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": config}):
            name = stop.claim_name(inputs_fixture.SESSION, "input:1", "uncovered_input")
            claim = Path(config) / "state" / "track" / "stop-holds" / "inputs" / name

            def replace_then_deny(_path):
                # Runs at the creator's temp cleanup, after the claim was published.
                claim.rename(claim.with_suffix(".original"))
                claim.write_text("foreign replacement", encoding="utf-8")
                raise PermissionError("FIXTURE: cleanup failed after replacement")

            with patch.object(stop.os, "unlink", side_effect=replace_then_deny):
                self.assertEqual(stop.decision({"session_id": inputs_fixture.SESSION}, self.snapshot()),
                                 {"decision": "block", "reason": inputs_fixture.REASON})
            self.assertEqual(claim.read_text(encoding="utf-8"), "foreign replacement")


if __name__ == "__main__":
    unittest.main()
