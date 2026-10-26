"""FIXTURE: skipped classic.Stop still holds each uncovered input once."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "hooks" / "stop-gate.py"
SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
REASON = 'track: a prompt looks like a question ("Why is the task waiting?") but no Track row was written for it.'


class StopInputTests(unittest.TestCase):
    def invoke(self, config, inputs, turn="t1", session=SESSION, **payload):
        snapshot = {
            "v": 2, "session_id": session, "turn_id": turn,
            "open": [], "candidates": [], "held": [], "inputs": inputs, "inputs_complete": True,
        }
        result = subprocess.run(
            ["python3", str(SCRIPT)],
            input=json.dumps({"session_id": session, **payload}),
            text=True, capture_output=True, check=False,
            env={**os.environ, "CLAUDE_CONFIG_DIR": str(config),
                 "TRACK_GATE_SNAPSHOT": json.dumps(snapshot)},
            timeout=5,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def question(self, identity=1, reason=REASON):
        # The module owns wording/classifier policy and supplies its exact repair text.
        return {"id": identity, "reason": reason}

    def test_uncovered_input_blocks_even_after_another_stop_hook_blocked(self):
        with tempfile.TemporaryDirectory() as config:
            answer = self.invoke(config, [self.question()], stop_hook_active=True)
            self.assertEqual(answer, {"decision": "block", "reason": REASON})

    def test_input_is_held_once_across_turns_and_helper_processes(self):
        with tempfile.TemporaryDirectory() as config:
            self.assertEqual(self.invoke(config, [self.question()]).get("decision"), "block")
            self.assertEqual(self.invoke(config, [self.question()]), {})
            self.assertEqual(self.invoke(config, [self.question()], turn="t2"), {})

    def test_multiple_inputs_are_each_held_and_new_input_still_blocks(self):
        second = "track: the classifier labelled another prompt a question; steps never cover a labelled question."
        third = "track: this newly arrived prompt still needs a Track row."
        with tempfile.TemporaryDirectory() as config:
            answer = self.invoke(config, [self.question(), self.question(2, second)])
            self.assertEqual(answer, {"decision": "block", "reason": f"{REASON} {second}"})
            self.assertEqual(self.invoke(config, [self.question(2, second)], turn="t2"), {})
            self.assertEqual(self.invoke(config, [self.question(), self.question(3, third)], turn="t3"),
                             {"decision": "block", "reason": third})

    def test_same_numeric_input_in_another_session_is_independent(self):
        with tempfile.TemporaryDirectory() as config:
            self.assertEqual(self.invoke(config, [self.question()]).get("decision"), "block")
            other = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"
            self.assertEqual(self.invoke(config, [self.question()], session=other).get("decision"), "block")

    def test_subagent_does_not_consume_main_input_hold(self):
        with tempfile.TemporaryDirectory() as config:
            self.assertEqual(self.invoke(config, [self.question()], agent_id="worker"), {})
            self.assertEqual(self.invoke(config, [self.question()]).get("decision"), "block")

    def test_unknown_or_malformed_input_cannot_authorize_a_block(self):
        for inputs in (None, {}, [{"id": 1}], [{"id": True, "reason": REASON}],
                       [{"id": 0, "reason": REASON}], [{"id": 1, "reason": " "}],
                       [{"id": 1, "reason": REASON}, {"id": "unknown", "reason": REASON}]):
            with self.subTest(inputs=inputs), tempfile.TemporaryDirectory() as config:
                self.assertEqual(self.invoke(config, inputs), {})


if __name__ == "__main__":
    unittest.main()
