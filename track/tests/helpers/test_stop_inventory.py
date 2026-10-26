"""FIXTURE: contract-stop-r1 D5. The command Stop hook records the live background task ids for its
session and turn, so a skipped classic.Stop can still reconcile the banner at the next prompt."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "hooks" / "stop-gate.py"
SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
OWNER = "track-stop-inventory-v1"


def inventory_path(config, session=SESSION):
    name = hashlib.sha256(session.encode("utf-8")).hexdigest() + ".json"
    return Path(config) / "state" / "track" / "stop-inventory" / name


def snapshot(session=SESSION, turn="t1", launch_seq=4, **extra):
    row = {"v": 2, "session_id": session, "turn_id": turn, "open": [], "candidates": [], "held": [],
           "inputs": [], "inputs_complete": True, **extra}
    if launch_seq is not None:
        row["launch_seq"] = launch_seq
    return row


class StopInventoryTests(unittest.TestCase):
    def invoke(self, config, gate, tasks, session=SESSION, **payload):
        body = {"session_id": session, "stop_hook_active": False, **payload}
        if tasks is not None:
            body["background_tasks"] = tasks
        result = subprocess.run(
            ["python3", str(SCRIPT)], input=json.dumps(body), text=True, capture_output=True, check=False,
            env={**os.environ, "CLAUDE_CONFIG_DIR": str(config), "TRACK_GATE_SNAPSHOT": json.dumps(gate)}, timeout=5)
        return result

    def test_h1_command_stop_writes_the_owner_isolated_inventory(self):
        with tempfile.TemporaryDirectory() as config:
            result = self.invoke(config, snapshot(), [{"id": "a", "type": "shell", "status": "running", "description": "x"}])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {})
            path = inventory_path(config)
            self.assertTrue(path.is_file(), "no inventory written for the command Stop")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(json.loads(path.read_text()), {
                "owner": OWNER, "session_id": SESSION, "turn_id": "t1", "launch_seq": 4,
                "task_ids": ["a"], "complete": True})
            leftovers = [entry.name for entry in path.parent.iterdir() if entry != path]
            self.assertEqual(leftovers, [], "the temp file was not renamed into place")

    def test_h2_invalid_stops_write_nothing_and_keep_an_earlier_inventory(self):
        cases = {
            "subagent stop": (snapshot(), [{"id": "a"}], {"agent_id": "worker"}),
            "snapshot of another session": (snapshot(session="bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"), [{"id": "a"}], {}),
            "missing turn id": (snapshot(turn=None), [{"id": "a"}], {}),
            "missing launch_seq": (snapshot(launch_seq=None), [{"id": "a"}], {}),
            "negative launch_seq": (snapshot(launch_seq=-1), [{"id": "a"}], {}),
            "non-list tasks": (snapshot(), {"id": "a"}, {}),
            "absent tasks": (snapshot(), None, {}),
            "over-cap tasks": (snapshot(), [{"id": f"t{index}"} for index in range(257)], {}),
            "task without string id": (snapshot(), [{"id": "a"}, {"id": 7}], {}),
        }
        for name, (gate, tasks, payload) in cases.items():
            with self.subTest(name), tempfile.TemporaryDirectory() as config:
                path = inventory_path(config)
                path.parent.mkdir(parents=True, mode=0o700)
                earlier = json.dumps({"owner": OWNER, "session_id": SESSION, "turn_id": "t0", "launch_seq": 1,
                                      "task_ids": ["old"], "complete": True}).encode("utf-8")
                path.write_bytes(earlier)
                result = self.invoke(config, gate, tasks, **payload)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(path.read_bytes(), earlier, f"{name} replaced the earlier inventory")
                self.assertEqual(sorted(entry.name for entry in path.parent.iterdir()), [path.name])

    def test_h3_unwritable_inventory_keeps_the_decision_and_exit_code(self):
        with tempfile.TemporaryDirectory() as config, tempfile.TemporaryDirectory() as clean:
            blocked = Path(config) / "state" / "track" / "stop-inventory"
            blocked.parent.mkdir(parents=True, mode=0o700)
            blocked.write_text("FIXTURE: a file where the inventory directory belongs")
            expected = self.invoke(clean, snapshot(), [{"id": "a"}])
            result = self.invoke(config, snapshot(), [{"id": "a"}])
            self.assertEqual(result.returncode, expected.returncode)
            self.assertEqual(json.loads(result.stdout), json.loads(expected.stdout))
            self.assertLessEqual(len([line for line in result.stderr.splitlines() if line.strip()]), 1)
            self.assertEqual(blocked.read_text(), "FIXTURE: a file where the inventory directory belongs")


if __name__ == "__main__":
    unittest.main()
