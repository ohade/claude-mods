"""FIXTURE: TRACK-30, real Stop helper and exclusive claims in a temporary home.

No installed hook, store or user session is changed. Known owner receipts are
published by Track; the current Stop payload supplies authoritative running tasks.
"""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "hooks" / "stop-gate.py"
SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
REASON = (
    "track: plan:1 is still delegated, but its recorded background tasks have finished. "
    "Call mark_step with completed or paused and the true result. "
    "If another owner remains, keep in_progress with delegated:true and a note naming that owner. "
    "Use delegated:false only when the main thread resumes work now, then finish."
)


class FinishedDelegationStopTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="track30-")
        self.addCleanup(self.temp.cleanup)

    def invoke(self, owners=None, tasks=None, external_owner=False, turn_id="t1", **changes):
        row = {"kind": "finished_delegation", "id": "plan:1",
               "owner_task_ids": ["worker-1", "worker-2"] if owners is None else owners}
        if external_owner is not None:
            row["external_owner"] = external_owner
        snapshot = {"v": 2, "session_id": SID, "turn_id": turn_id, "open": [],
                    "candidates": [row], "attributed_task_ids": ["worker-1", "worker-2", "other"],
                    "response": {"turn_id": turn_id, "request_id": "response-1"}, "held": []}
        payload = {"session_id": SID, "background_tasks": [] if tasks is None else tasks}
        snapshot.update(changes.pop("snapshot", {}))
        payload.update(changes)
        result = subprocess.run(
            [sys.executable, str(SCRIPT)], input=json.dumps(payload), text=True,
            capture_output=True, timeout=10, check=False,
            env={**os.environ, "CLAUDE_CONFIG_DIR": self.temp.name,
                 "TRACK_GATE_SNAPSHOT": json.dumps(snapshot)},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout), result.stderr

    def test_all_known_owners_finished_blocks_once_with_exact_repair(self):
        self.assertEqual(self.invoke()[0], {"decision": "block", "reason": REASON})
        self.assertEqual(self.invoke()[0], {})

    def test_one_running_owner_passes_without_consuming_the_hold(self):
        self.assertEqual(self.invoke(tasks=[{"id": "worker-2", "type": "agent"}])[0], {})
        self.assertEqual(self.invoke()[0], {"decision": "block", "reason": REASON})

    def test_a_known_unrelated_task_does_not_hide_finished_owners(self):
        self.assertEqual(self.invoke(tasks=[{"id": "other", "type": "agent"}])[0],
                         {"decision": "block", "reason": REASON})

    def test_unknown_running_work_passes_without_consuming_the_hold(self):
        self.assertEqual(self.invoke(tasks=[{"id": "unknown", "type": "agent"}])[0], {})
        self.assertEqual(self.invoke()[0], {"decision": "block", "reason": REASON})

    def test_empty_or_malformed_owner_receipt_does_not_authorize_a_block(self):
        for owners in [[], [""], [1], "worker-1"]:
            with self.subTest(owners=owners):
                self.assertEqual(self.invoke(owners=owners)[0], {})

    def test_missing_or_malformed_task_list_does_not_authorize_a_block(self):
        for tasks in [False, [{"type": "agent"}], [{"id": 12}]]:
            with self.subTest(tasks=tasks):
                self.assertEqual(self.invoke(tasks=tasks)[0], {})
        self.assertEqual(self.invoke(background_tasks=None)[0], {})

    def test_missing_response_and_subagent_never_consume_a_hold(self):
        self.assertEqual(self.invoke(snapshot={"response": None})[0], {})
        self.assertEqual(self.invoke(agent_id="worker-1")[0], {})
        self.assertEqual(self.invoke()[0], {"decision": "block", "reason": REASON})

    def test_held_kind_does_not_block_again(self):
        self.assertEqual(self.invoke(snapshot={"held": ["finished_delegation"]})[0], {})

    def test_unseen_or_unknown_ownership_never_authorizes_a_hold(self):
        # A known local launch does not prove that no unseen peer still owns work.
        for index, owner in enumerate([True, None, "false", 0]):
            with self.subTest(external_owner=owner):
                self.assertEqual(self.invoke(external_owner=owner, turn_id=f"scope-{index}")[0], {})
        self.assertEqual(self.invoke(external_owner=False)[0], {"decision": "block", "reason": REASON})

    def test_concurrent_processes_grant_one_hold(self):
        with ThreadPoolExecutor(max_workers=6) as pool:
            answers = list(pool.map(lambda _: self.invoke()[0], range(6)))
        self.assertEqual(answers.count({"decision": "block", "reason": REASON}), 1)
        self.assertEqual(answers.count({}), 5)


if __name__ == "__main__":
    unittest.main()
