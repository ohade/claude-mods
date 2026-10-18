"""FIXTURE: TRACK-27 finding 5, Ohad's decision 2026-10-18 ("recheck after a block").

A Stop marked stop_hook_active still checks the v2 freshness kinds; the real shared claim
allows each kind one block per turn. The open-question gate keeps its bypass.
All state is under a temporary CLAUDE_CONFIG_DIR. No installed hooks are called.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / "hooks" / "stop-gate.py"
SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
STALE = "track: plan:1 is still in_progress, but no work owns it. Call mark_step with completed, paused, or waiting and the true result, then finish."
WAITING = "track: plan:2 is waiting, but the final reply has no 👉 plan:2: request line. Ask the user visibly, then finish."


def snapshot(**extra):
    return {"v": 2, "session_id": SID, "turn_id": "t1", "open": [],
            "candidates": [{"kind": "stale_in_progress", "id": "plan:1", "owner_task_ids": []},
                           {"kind": "missing_waiting_request", "id": "plan:2"}],
            "attributed_task_ids": [], "response": {"turn_id": "t1", "request_id": "response-1"}, "held": [], **extra}


class Track27RecheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="track27-recheck-")
        self.addCleanup(self.temp.cleanup)

    def invoke(self, state, plugin=False, **payload):
        env = {**os.environ, "CLAUDE_CONFIG_DIR": self.temp.name, "TRACK_GATE_SNAPSHOT": json.dumps(state, ensure_ascii=False)}
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *(["--claim"] if plugin else [])],
            input=json.dumps({"session_id": SID, "background_tasks": [], **payload}),
            text=True, capture_output=True, env=env, check=False, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_a_stop_after_a_block_checks_each_remaining_kind_once(self):
        for plugin in (False, True):
            with self.subTest(plugin=plugin):
                state = snapshot(turn_id=f"t-{plugin}", response={"turn_id": f"t-{plugin}", "request_id": "response-1"})
                self.assertEqual(self.invoke(state, plugin, stop_hook_active=False), {"decision": "block", "reason": STALE})
                self.assertEqual(self.invoke(state, plugin, stop_hook_active=True), {"decision": "block", "reason": WAITING})
                self.assertEqual(self.invoke(state, plugin, stop_hook_active=True), {})

    def test_stop_hook_active_skips_the_open_question_but_not_freshness(self):
        state = snapshot(open=[{"id": 7, "head": "Which option?"}])
        self.assertEqual(self.invoke(state, stop_hook_active=True), {"decision": "block", "reason": STALE})
        v1 = {"v": 1, "session_id": SID, "turn_id": "t1", "open": [{"id": 7, "head": "Which option?"}]}
        self.assertEqual(self.invoke(v1, stop_hook_active=True), {})

    def test_a_subagent_stop_checks_nothing(self):
        self.assertEqual(self.invoke(snapshot(), agent_id="worker", stop_hook_active=True), {})
        self.assertEqual(self.invoke(snapshot(), stop_hook_active=False), {"decision": "block", "reason": STALE})


if __name__ == "__main__":
    unittest.main()
