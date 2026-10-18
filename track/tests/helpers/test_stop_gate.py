"""FIXTURE: independent ordinary Stop gate required by the Track release."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / "hooks" / "stop-gate.py"
SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"


class StopGateTests(unittest.TestCase):
    def invoke(self, payload, snapshot, config=None):
        env = {**os.environ, "TRACK_GATE_SNAPSHOT": json.dumps(snapshot, ensure_ascii=False)}
        if config is not None:
            env["CLAUDE_CONFIG_DIR"] = str(config)
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

    def test_v1_acceptance_needs_no_freshness_claim_directory(self):
        with tempfile.TemporaryDirectory() as root:
            config = Path(root) / "not-created"
            answer = self.invoke({"session_id": SID}, self.snapshot(), config)
            self.assertEqual(answer["decision"], "block")
            self.assertIn("Q7", answer["reason"])
            self.assertFalse(config.exists())

    def test_v2_messages_match_plugin_and_each_kind_blocks_once(self):
        cases = [
            ("premature_completion", "track: task:7 is completed while its owned task worker-7 is still running. Reopen or pause the step, or wait for that task, then finish."),
            ("stale_in_progress", "track: task:7 is still in_progress, but no work owns it. Call mark_step with completed, paused, or waiting and the true result, then finish."),
            ("missing_waiting_request", "track: task:7 is waiting, but the final reply has no 👉 task:7: request line. Ask the user visibly, then finish."),
            ("untracked_edit", "track: this turn changed files but no step was created or marked. Reuse a step with mark_step or register one with track_steps, then finish."),
        ]
        with tempfile.TemporaryDirectory() as config:
            for kind, reason in cases:
                with self.subTest(kind=kind):
                    candidate = {"kind": kind, "id": "task:7", "owner_task_ids": ["worker-7"] if kind == "premature_completion" else []}
                    snapshot = {"v": 2, "session_id": SID, "turn_id": kind, "open": [], "candidates": [candidate],
                                "response": {"turn_id": kind, "request_id": "fixture-main"}, "held": []}
                    payload = {"session_id": SID, "background_tasks": [{"id": "worker-7", "type": "agent"}]}
                    self.assertEqual(self.invoke(payload, snapshot, config), {"decision": "block", "reason": reason})
                    self.assertEqual(self.invoke(payload, snapshot, config), {})


if __name__ == "__main__":
    unittest.main()
