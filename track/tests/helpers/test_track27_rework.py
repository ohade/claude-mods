"""FIXTURE: TRACK-27 refuter verdict 2, findings 1, 4 and 6, against the real stop-gate.py.

All state is under a temporary directory. No installed hooks are called.
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


def snapshot(**extra):
    return {"v": 2, "session_id": SID, "turn_id": "t1", "open": [],
            "candidates": [{"kind": "stale_in_progress", "id": "plan:1", "owner_task_ids": []}],
            "response": {"turn_id": "t1", "request_id": "response-1"}, "held": [], **extra}


class Track27ReworkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="track27-rework-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def invoke(self, state=None, tasks=(), config=True, plugin=False, timeout=10):
        env = {key: value for key, value in os.environ.items() if key != "CLAUDE_CONFIG_DIR"}
        env.update({"HOME": str(self.root / "home"), "TRACK_GATE_SNAPSHOT": json.dumps(snapshot() if state is None else state)})
        if config:
            env["CLAUDE_CONFIG_DIR"] = str(self.root / "config")
        payload = {"session_id": SID, "stop_hook_active": False, "background_tasks": list(tasks)}
        try:
            result = subprocess.run(
                [sys.executable, str(SCRIPT), *(["--claim"] if plugin else [])],
                input=json.dumps(payload), text=True, capture_output=True, env=env, check=False, timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            self.fail(f"stop-gate.py did not answer within {timeout} s")
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout), result.stderr

    def holds(self, base):
        directory = base / "state" / "track" / "stop-holds"
        return sorted(path.name for path in directory.iterdir()) if directory.is_dir() else []

    def test_finding_1_unset_config_dir_claims_under_home_claude(self):
        for plugin in (False, True):
            with self.subTest(plugin=plugin):
                state = snapshot(turn_id=f"t-{plugin}", response={"turn_id": f"t-{plugin}", "request_id": "response-1"})
                self.assertEqual(self.invoke(state, config=False, plugin=plugin)[0], {"decision": "block", "reason": STALE})
                self.assertEqual(self.invoke(state, config=False, plugin=plugin)[0], {})
        self.assertEqual(len(self.holds(self.root / "home" / ".claude")), 2)

    def test_finding_4_running_task_without_a_recorded_owner_nudges_and_passes(self):
        for state in (snapshot(attributed_task_ids=[]), snapshot(attributed_task_ids=["worker-2"]), snapshot()):
            with self.subTest(attributed=state.get("attributed_task_ids")):
                answer, stderr = self.invoke(state, tasks=[{"id": "shell-9", "type": "shell"}])
                self.assertEqual(answer, {})
                self.assertIn("owner identity", stderr)
        self.assertEqual(self.holds(self.root / "config"), [])

    def test_finding_4_tasks_owned_by_other_steps_still_leave_the_step_stale(self):
        answer, _ = self.invoke(snapshot(attributed_task_ids=["worker-2"]), tasks=[{"id": "worker-2", "type": "agent"}])
        self.assertEqual(answer, {"decision": "block", "reason": STALE})

    def test_finding_6_a_fifo_with_a_hold_name_does_not_hang_the_helper(self):
        directory = self.root / "config" / "state" / "track" / "stop-holds"
        directory.mkdir(mode=0o700, parents=True)
        os.mkfifo(directory / ("f" * 64), 0o600)
        self.assertEqual(self.invoke(timeout=4)[0], {"decision": "block", "reason": STALE})
        self.assertTrue((directory / ("f" * 64)).exists())


if __name__ == "__main__":
    unittest.main()
