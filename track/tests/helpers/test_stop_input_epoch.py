"""FIXTURE: TRACK-46 S2. A new process restarts input numbering at 1, but
input claims are permanent per session. Each runtime's input epoch keeps a
fresh input from meeting an older runtime's spent claim."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "hooks" / "stop-gate.py"
SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
FIRST = "track: first runtime's question still needs a Track row."
SECOND = "track: second runtime's different question still needs a Track row."


class StopInputEpochTests(unittest.TestCase):
    def invoke(self, config, reason, epoch=None, turn="t1"):
        snapshot = {
            "v": 2, "session_id": SESSION, "turn_id": turn, "open": [], "candidates": [], "held": [],
            "inputs": [{"id": 1, "reason": reason}], "inputs_complete": True,
        }
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

    def test_new_runtime_input_one_is_held_once_despite_older_runtime_claim(self):
        for older in (None, "epoch-a"):  # a legacy claim name, or an earlier epoch
            with self.subTest(older=older), tempfile.TemporaryDirectory() as config:
                self.assertEqual(self.invoke(config, FIRST, older).get("decision"), "block")
                before = self.claims(config)
                self.assertEqual(self.invoke(config, SECOND, "epoch-b"), {"decision": "block", "reason": SECOND})
                self.assertEqual(self.invoke(config, SECOND, "epoch-b"), {})
                self.assertEqual(self.invoke(config, SECOND, "epoch-b", turn="t2"), {})
                after = self.claims(config)
                self.assertEqual({name: after[name] for name in before}, before, "older claims stay unchanged")

    def test_same_epoch_still_holds_once_across_turns(self):
        with tempfile.TemporaryDirectory() as config:
            self.assertEqual(self.invoke(config, FIRST, "epoch-a").get("decision"), "block")
            self.assertEqual(self.invoke(config, FIRST, "epoch-a", turn="t2"), {})

    def test_malformed_epoch_cannot_authorize_a_block(self):
        for epoch in ("", " ", 7, "x" * 129):
            with self.subTest(epoch=epoch), tempfile.TemporaryDirectory() as config:
                self.assertEqual(self.invoke(config, FIRST, epoch), {})


if __name__ == "__main__":
    unittest.main()
