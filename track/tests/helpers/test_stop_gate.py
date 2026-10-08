"""FIXTURE: independent ordinary Stop gate required by the Track release."""
import json
import os
from pathlib import Path
import subprocess
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / "hooks" / "stop-gate.py"
SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"


class StopGateTests(unittest.TestCase):
    def invoke(self, payload, snapshot):
        env = {**os.environ, "TRACK_GATE_SNAPSHOT": json.dumps(snapshot, ensure_ascii=False)}
        result = subprocess.run(["python3", str(SCRIPT)], input=json.dumps(payload), text=True,
                                capture_output=True, env=env, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def snapshot(self):
        return {"v": 1, "session_id": SID, "turn_id": "t1", "open": [{"id": 7, "head": "שאלה 😀"}]}

    def test_open_question_blocks_main_stop(self):
        answer = self.invoke({"session_id": SID, "stop_hook_active": False}, self.snapshot())
        self.assertEqual(answer["decision"], "block")
        self.assertIn("Q7", answer["reason"])
        self.assertIn("mark_answered", answer["reason"])

    def test_different_session_cannot_block(self):
        self.assertEqual(self.invoke({"session_id": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"}, self.snapshot()), {})

    def test_loop_and_subagent_protections(self):
        for extra in ({"stop_hook_active": True}, {"agent_id": "worker"}):
            self.assertEqual(self.invoke({"session_id": SID, **extra}, self.snapshot()), {})

    def test_resolved_questions_allow_stop(self):
        self.assertEqual(self.invoke({"session_id": SID}, {**self.snapshot(), "open": []}), {})


if __name__ == "__main__":
    unittest.main()
