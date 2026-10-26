"""FIXTURE: complete input evidence is independent of truncated freshness evidence."""
import json
import os
import subprocess
import tempfile
import unittest

import test_stop_inputs as inputs_fixture


def snapshot(rows, **flags):
    return {"v": 2, "session_id": inputs_fixture.SESSION, "turn_id": "t1",
            "open": [], "candidates": [], "held": [], "inputs": rows, **flags}


class CompleteInputTests(unittest.TestCase):
    def invoke(self, config, evidence):
        result = subprocess.run(
            ["python3", str(inputs_fixture.SCRIPT)],
            input=json.dumps({"session_id": inputs_fixture.SESSION}),
            text=True, capture_output=True, check=False,
            env={**os.environ, "CLAUDE_CONFIG_DIR": config, "TRACK_GATE_SNAPSHOT": json.dumps(evidence)},
            timeout=5,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_H1_complete_inputs_block_when_only_freshness_is_truncated(self):
        evidence = snapshot([{"id": 1, "reason": inputs_fixture.REASON}], inputs_complete=True, truncated=True)
        with tempfile.TemporaryDirectory() as config:
            self.assertEqual(self.invoke(config, evidence), {"decision": "block", "reason": inputs_fixture.REASON})

    def test_H2_absent_or_false_completeness_preserves_an_unspent_input(self):
        rows = [{"id": 1, "reason": inputs_fixture.REASON}]
        for flags in ({}, {"inputs_complete": False}):
            with tempfile.TemporaryDirectory() as config:
                self.assertEqual(self.invoke(config, snapshot(rows, **flags)), {})
                self.assertEqual(self.invoke(config, snapshot(rows, inputs_complete=True)),
                                 {"decision": "block", "reason": inputs_fixture.REASON})

    def test_H3_fifty_minimal_reasons_are_accepted_and_joined(self):
        rows = [{"id": identity, "reason": f"track: Register input {identity} with mcp__track__track_question."}
                for identity in range(1, 51)]
        with tempfile.TemporaryDirectory() as config:
            self.assertEqual(self.invoke(config, snapshot(rows, inputs_complete=True)),
                             {"decision": "block", "reason": " ".join(row["reason"] for row in rows)})


if __name__ == "__main__":
    unittest.main()
