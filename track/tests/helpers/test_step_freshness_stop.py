"""FIXTURE: TRACK-27 v2 Stop boundary, exact messages and real exclusive claims.

All state is under a temporary CLAUDE_CONFIG_DIR. No installed hooks are called.
The plugin invokes the same helper with --claim; ordinary Stop uses no flag.
"""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / "hooks" / "stop-gate.py"
SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
STALE = "track: plan:1 is still in_progress, but no work owns it. Call mark_step with completed, paused, or waiting and the true result, then finish."
PREMATURE = "track: plan:1 is completed while its owned task worker-1 is still running. Reopen or pause the step, or wait for that task, then finish."
WAITING = "track: plan:1 is waiting, but the final reply has no 👉 plan:1: request line. Ask the user visibly, then finish."
EDIT = "track: this turn changed files but no step was created or marked. Reuse a step with mark_step or register one with track_steps, then finish."


def candidate(kind="stale_in_progress", **extra):
    return {"kind": kind, "id": "plan:1", "owner_task_ids": [], **extra}


class StepFreshnessStopTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="track27-")
        self.addCleanup(self.temp.cleanup)
        self.config = Path(self.temp.name)

    def snapshot(self, candidates=None, **extra):
        return {"v": 2, "session_id": SID, "turn_id": "t1", "open": [],
                "candidates": [candidate()] if candidates is None else candidates,
                # FIXTURE: worker-1 and other have recorded owners, as the plugin snapshot lists them.
                "attributed_task_ids": ["worker-1", "other"],
                "response": {"turn_id": "t1", "request_id": "response-1"}, "held": [], **extra}

    def invoke(self, snapshot=None, payload=None, plugin=False):
        env = {**os.environ, "CLAUDE_CONFIG_DIR": str(self.config),
               "TRACK_GATE_SNAPSHOT": json.dumps(self.snapshot() if snapshot is None else snapshot)}
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *(["--claim"] if plugin else [])],
            input=json.dumps({"session_id": SID, "stop_hook_active": False, "background_tasks": []}
                             if payload is None else payload),
            text=True, capture_output=True, env=env, check=False, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout), result.stderr

    def test_stale_current_turn_step_blocks_once_without_a_live_owner(self):
        self.assertEqual(self.invoke()[0], {"decision": "block", "reason": STALE})
        self.assertEqual(self.invoke()[0], {})

    def test_each_freshness_kind_has_the_exact_approved_message(self):
        cases = [
            (candidate("premature_completion", owner_task_ids=["worker-1"]), PREMATURE),
            (candidate(), STALE),
            (candidate("missing_waiting_request"), WAITING),
            (candidate("untracked_edit"), EDIT),
        ]
        payload = {"session_id": SID, "background_tasks": [{"id": "worker-1", "type": "agent"}]}
        for row, reason in cases:
            with self.subTest(kind=row["kind"]):
                self.assertEqual(self.invoke(self.snapshot([row]), payload)[0], {"decision": "block", "reason": reason})

    def test_candidate_priority_is_completion_stale_waiting_then_untracked_edit(self):
        rows = [candidate("untracked_edit"), candidate("missing_waiting_request"), candidate(),
                candidate("premature_completion", owner_task_ids=["worker-1"])]
        payload = {"session_id": SID, "background_tasks": [{"id": "worker-1", "type": "agent"}]}
        for reason in [PREMATURE, STALE, WAITING, EDIT]:
            self.assertEqual(self.invoke(self.snapshot(rows), payload)[0], {"decision": "block", "reason": reason})
        self.assertEqual(self.invoke(self.snapshot(rows), payload)[0], {})

    def test_owned_running_task_prevents_completion_but_an_unrelated_task_does_not(self):
        snapshot = self.snapshot([candidate("premature_completion", owner_task_ids=["worker-1"])])
        self.assertEqual(self.invoke(snapshot, {"session_id": SID, "background_tasks": [{"id": "other", "type": "agent"}]})[0], {})
        self.assertEqual(self.invoke(snapshot, {"session_id": SID, "background_tasks": [{"id": "worker-1", "type": "agent"}]})[0], {"decision": "block", "reason": PREMATURE})

    def test_an_exact_live_owner_exempts_a_stale_step(self):
        snapshot = self.snapshot([candidate(owner_task_ids=["worker-1"])])
        self.assertEqual(self.invoke(snapshot, {"session_id": SID, "background_tasks": [{"id": "worker-1", "type": "agent"}]})[0], {})

    def test_missing_task_list_nudges_and_passes_without_spending_the_hold(self):
        answer, diagnostic = self.invoke(payload={"session_id": SID})
        self.assertEqual(answer, {})
        self.assertRegex(diagnostic, r"(?i)task|background")
        self.assertEqual(self.invoke()[0], {"decision": "block", "reason": STALE})

    def test_missing_response_or_owner_receipt_nudges_and_passes(self):
        missing_owner = candidate()
        del missing_owner["owner_task_ids"]
        for snapshot in [self.snapshot(response=None), self.snapshot([missing_owner])]:
            with self.subTest(snapshot=snapshot):
                answer, diagnostic = self.invoke(snapshot)
                self.assertEqual(answer, {})
                self.assertRegex(diagnostic, r"(?i)response|owner|receipt")

    def test_different_or_missing_identity_cannot_block_or_claim(self):
        for snapshot in [self.snapshot(session_id="another-session"), self.snapshot(turn_id=None),
                         self.snapshot(response={"turn_id": "old", "request_id": "response-1"})]:
            with self.subTest(snapshot=snapshot):
                self.assertEqual(self.invoke(snapshot)[0], {})
        self.assertEqual(self.invoke()[0], {"decision": "block", "reason": STALE})

    def test_subagent_and_stop_hook_active_do_not_consume_a_hold(self):
        for extra in [{"agent_id": "worker"}, {"stop_hook_active": True}]:
            with self.subTest(extra=extra):
                self.assertEqual(self.invoke(payload={"session_id": SID, "background_tasks": [], **extra})[0], {})
        self.assertEqual(self.invoke()[0], {"decision": "block", "reason": STALE})

    def test_fallback_then_plugin_and_plugin_then_fallback_share_one_claim(self):
        for first_plugin in [False, True]:
            with self.subTest(first_plugin=first_plugin):
                snapshot = self.snapshot(turn_id=f"order-{first_plugin}", response={"turn_id": f"order-{first_plugin}", "request_id": "response-1"})
                self.assertEqual(self.invoke(snapshot, plugin=first_plugin)[0], {"decision": "block", "reason": STALE})
                self.assertEqual(self.invoke(snapshot, plugin=not first_plugin)[0], {})

    def test_concurrent_fresh_processes_grant_exactly_one_hold(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            answers = list(pool.map(lambda _: self.invoke()[0], range(8)))
        self.assertEqual(answers.count({"decision": "block", "reason": STALE}), 1)
        self.assertEqual(answers.count({}), 7)

    def test_claim_is_private_hash_named_and_scoped_to_session_turn_and_kind(self):
        self.assertEqual(self.invoke()[0], {"decision": "block", "reason": STALE})
        directory = self.config / "state" / "track" / "stop-holds"
        files = list(directory.iterdir())
        self.assertEqual(len(files), 1)
        self.assertRegex(files[0].name, r"^[0-9a-f]{64}$")
        self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(files[0].stat().st_mode), 0o600)
        self.assertEqual(self.invoke(self.snapshot(turn_id="t2", response={"turn_id": "t2", "request_id": "response-2"}))[0], {"decision": "block", "reason": STALE})
        self.assertEqual(self.invoke(self.snapshot([candidate("untracked_edit")]))[0], {"decision": "block", "reason": EDIT})

    def test_claim_failure_logs_and_passes(self):
        path = self.config / "state" / "track" / "stop-holds"
        path.parent.mkdir(parents=True)
        path.write_text("fixture: path occupied by a file")
        answer, diagnostic = self.invoke()
        self.assertEqual(answer, {})
        self.assertRegex(diagnostic, r"(?i)claim|hold")

    def test_expiration_removes_only_helper_owned_files_older_than_seven_days(self):
        self.assertEqual(self.invoke()[0], {"decision": "block", "reason": STALE})
        directory = self.config / "state" / "track" / "stop-holds"
        owned = list(directory.iterdir())[0]
        foreign = directory / ("f" * 64)
        foreign.write_text("foreign file, not a Track claim")
        old = time.time() - 8 * 24 * 60 * 60
        os.utime(owned, (old, old))
        os.utime(foreign, (old, old))
        self.assertEqual(self.invoke(self.snapshot(turn_id="t2", response={"turn_id": "t2", "request_id": "response-2"}))[0], {"decision": "block", "reason": STALE})
        self.assertFalse(owned.exists())
        self.assertEqual(foreign.read_text(), "foreign file, not a Track claim")

    def test_snapshot_held_kind_cannot_block_twice_but_another_kind_can(self):
        snapshot = self.snapshot([candidate(), candidate("untracked_edit")], held=["stale_in_progress"])
        self.assertEqual(self.invoke(snapshot)[0], {"decision": "block", "reason": EDIT})

    def test_v2_keeps_open_question_priority_and_v1_compatibility(self):
        for version in [1, 2]:
            with self.subTest(version=version):
                answer = self.invoke(self.snapshot(v=version, open=[{"id": 7, "head": "Question"}]))[0]
                self.assertEqual(answer.get("decision"), "block")
                self.assertIn("Q7", answer.get("reason", ""))
                self.assertIn("<!-- A7:start -->", answer.get("reason", ""))

    def test_no_candidate_or_unknown_kind_passes(self):
        for rows in [[], [candidate("unapproved_signal")]]:
            with self.subTest(rows=rows):
                self.assertEqual(self.invoke(self.snapshot(rows))[0], {})


if __name__ == "__main__":
    unittest.main()
