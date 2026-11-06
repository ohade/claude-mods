"""FIXTURE: finished delegation uses the real isolated Stop helper and claims."""
import test_step_freshness_stop as base


FINISHED = ("track: plan:1 is still delegated, but its recorded background tasks have finished. "
            "Call mark_step with completed or paused and the true result. If another owner remains, "
            "keep in_progress with delegated:true and a note naming that owner. Use delegated:false "
            "only when the main thread resumes work now, then finish.")


class FinishedDelegationTests(base.StepFreshnessStopTests):
    def test_finished_with_known_owners_blocks_once_and_absent_candidate_passes(self):
        snapshot = self.snapshot([base.candidate("finished_delegation", owner_task_ids=["worker-1"], external_owner=False)])
        self.assertEqual(self.invoke(snapshot)[0], {"decision": "block", "reason": FINISHED})
        self.assertEqual(self.invoke(snapshot)[0], {})
        self.assertEqual(self.invoke(self.snapshot([]))[0], {})

    def test_remaining_live_owner_passes_then_idle_blocks_without_spending_hold(self):
        # The completed owner has already left the receipt; worker-1 remains.
        snapshot = self.snapshot([base.candidate("finished_delegation", owner_task_ids=["worker-1"], external_owner=False)])
        running = {"session_id": base.SID, "background_tasks": [{"id": "worker-1", "type": "agent"}]}
        self.assertEqual(self.invoke(snapshot, running)[0], {})
        self.assertEqual(self.invoke(snapshot)[0], {"decision": "block", "reason": FINISHED})

    def test_missing_owner_or_task_list_nudges_without_spending_hold(self):
        for missing in ("owner", "tasks"):
            with self.subTest(missing=missing):
                turn = f"missing-{missing}"
                valid = self.snapshot([base.candidate("finished_delegation", owner_task_ids=["worker-1"], external_owner=False)], turn_id=turn,
                                      response={"turn_id": turn, "request_id": "response"})
                row = {"kind": "finished_delegation", "id": "plan:1"}
                snapshot = {**valid, "candidates": [row]} if missing == "owner" else valid
                payload = {"session_id": base.SID} if missing == "tasks" else None
                answer, diagnostic = self.invoke(snapshot, payload)
                self.assertEqual(answer, {})
                self.assertRegex(diagnostic, r"(?i)owner|receipt|task|background")
                self.assertEqual(self.invoke(valid)[0], {"decision": "block", "reason": FINISHED})

    def test_unattributed_running_task_nudges_without_spending_hold(self):
        snapshot = self.snapshot([base.candidate("finished_delegation", owner_task_ids=["worker-1"], external_owner=False)])
        payload = {"session_id": base.SID, "background_tasks": [{"id": "unknown", "type": "agent"}]}
        answer, diagnostic = self.invoke(snapshot, payload)
        self.assertEqual(answer, {})
        self.assertRegex(diagnostic, r"(?i)owner|unknown|attribut")
        self.assertEqual(self.invoke(snapshot)[0], {"decision": "block", "reason": FINISHED})

    def test_priority_and_old_messages_are_preserved(self):
        rows = [base.candidate("untracked_edit"), base.candidate("missing_waiting_request"),
                base.candidate("finished_delegation", owner_task_ids=["other"], external_owner=False), base.candidate(),
                base.candidate("premature_completion", owner_task_ids=["worker-1"])]
        payload = {"session_id": base.SID, "background_tasks": [{"id": "worker-1", "type": "agent"}]}
        for reason in [base.PREMATURE, base.STALE, FINISHED, base.WAITING, base.EDIT]:
            self.assertEqual(self.invoke(self.snapshot(rows), payload)[0], {"decision": "block", "reason": reason})
        self.assertEqual(self.invoke(self.snapshot(rows), payload)[0], {})
