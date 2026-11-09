"""FIXTURE: TRACK-46 S2 review (Codex, 2026-11-09). A hot reload into the
epoch version keeps the same pending queue. An input already held under its
legacy input:<id> claim must keep that claim name after the queue gains an
epoch, or its question is held a second time."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "hooks" / "stop-gate.py"
SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
OLD = "track: the old runtime's question still needs a Track row."
NEW = "track: the new input still needs a Track row."


class LegacyInputEpochTests(unittest.TestCase):
    def invoke(self, config, rows, epoch=None, turn="t1"):
        snapshot = {"v": 2, "session_id": SESSION, "turn_id": turn, "open": [], "candidates": [], "held": [],
                    "inputs": rows, "inputs_complete": True}
        if epoch is not None:
            snapshot["input_epoch"] = epoch
        result = subprocess.run(
            ["python3", str(SCRIPT)], input=json.dumps({"session_id": SESSION}),
            text=True, capture_output=True, check=False, timeout=5,
            env={**os.environ, "CLAUDE_CONFIG_DIR": str(config), "TRACK_GATE_SNAPSHOT": json.dumps(snapshot)},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def claims(self, config):
        directory = Path(config) / "state" / "track" / "stop-holds" / "inputs"
        return {path.name: path.read_bytes() for path in directory.iterdir()}

    def test_held_legacy_input_keeps_its_claim_after_the_queue_gains_an_epoch(self):
        with tempfile.TemporaryDirectory() as config:
            # The old version holds input 1 under its real legacy claim.
            self.assertEqual(self.invoke(config, [{"id": 1, "reason": OLD}]).get("decision"), "block")
            before = self.claims(config)
            rows = [{"id": 1, "reason": OLD, "legacy": True}, {"id": 2, "reason": NEW}]
            self.assertEqual(self.invoke(config, rows, "epoch-new"), {"decision": "block", "reason": NEW})
            self.assertEqual(self.invoke(config, rows, "epoch-new"), {})
            self.assertEqual(self.invoke(config, rows, "epoch-new", turn="t2"), {})
            after = self.claims(config)
            self.assertEqual({name: after[name] for name in before}, before, "the legacy claim stays unchanged")

    def test_malformed_legacy_marker_cannot_authorize_a_block(self):
        for marker in (False, 1, "yes"):
            with self.subTest(marker=marker), tempfile.TemporaryDirectory() as config:
                self.assertEqual(self.invoke(config, [{"id": 1, "reason": OLD, "legacy": marker}], "epoch-new"), {})


if __name__ == "__main__":
    unittest.main()
