"""FIXTURE: local-only finished ownership through the isolated Stop helper."""
import test_step_freshness_stop as base


FINISHED = ("track: plan:1 is still delegated, but its recorded background tasks have finished. "
            "Call mark_step with completed or paused and the true result. If another owner remains, "
            "keep in_progress with delegated:true and a note naming that owner. Use delegated:false "
            "only when the main thread resumes work now, then finish.")


class OwnerContractTests(base.StepFreshnessStopTests):
    def test_00_unknown_and_external_owners_do_not_block_or_claim(self):
        known = base.candidate("finished_delegation", owner_task_ids=["worker-1"])
        for row in [known, {**known, "external_owner": True}]:
            answer, diagnostic = self.invoke(self.snapshot([row]))
            self.assertEqual(answer, {})
            self.assertIn("complete local ownership declaration", diagnostic)
        local = {**known, "external_owner": False}
        self.assertEqual(self.invoke(self.snapshot([local]))[0], {"decision": "block", "reason": FINISHED})

    def test_empty_owner_receipt_nudges_without_claim(self):
        empty = base.candidate("finished_delegation", external_owner=False)
        answer, diagnostic = self.invoke(self.snapshot([empty]))
        self.assertEqual(answer, {})
        self.assertIn("finished task owner receipt", diagnostic)
        known = {**empty, "owner_task_ids": ["worker-1"]}
        self.assertEqual(self.invoke(self.snapshot([known]))[0], {"decision": "block", "reason": FINISHED})

    def test_live_owner_then_finished_blocks_only_once(self):
        row = base.candidate("finished_delegation", owner_task_ids=["worker-1"], external_owner=False)
        snapshot = self.snapshot([row])
        live = {"session_id": base.SID, "background_tasks": [{"id": "worker-1", "type": "agent"}]}
        self.assertEqual(self.invoke(snapshot, live)[0], {})
        self.assertEqual(self.invoke(snapshot)[0], {"decision": "block", "reason": FINISHED})
        self.assertEqual(self.invoke(snapshot)[0], {})
        self.assertEqual(self.invoke(self.snapshot([]))[0], {})

    def test_missing_malformed_and_unattributed_facts_do_not_claim(self):
        valid = base.candidate("finished_delegation", owner_task_ids=["worker-1"], external_owner=False)
        missing = {key: value for key, value in valid.items() if key != "owner_task_ids"}
        for row, payload in [(missing, None), ({**valid, "owner_task_ids": [1]}, None),
                             (valid, {"session_id": base.SID}),
                             (valid, {"session_id": base.SID, "background_tasks": [{}]}),
                             (valid, {"session_id": base.SID, "background_tasks": [{"id": "unknown"}]})]:
            with self.subTest(row=row, payload=payload):
                answer, diagnostic = self.invoke(self.snapshot([row]), payload)
                self.assertEqual(answer, {})
                self.assertRegex(diagnostic, r"(?i)owner|task|background")
        self.assertEqual(self.invoke(self.snapshot([valid]))[0], {"decision": "block", "reason": FINISHED})

    def test_priority_is_unchanged(self):
        finished = base.candidate("finished_delegation", owner_task_ids=["other"], external_owner=False)
        rows = [base.candidate("untracked_edit"), base.candidate("missing_waiting_request"), finished,
                base.candidate(), base.candidate("premature_completion", owner_task_ids=["worker-1"])]
        live = {"session_id": base.SID, "background_tasks": [{"id": "worker-1", "type": "agent"}]}
        for reason in [base.PREMATURE, base.STALE, FINISHED, base.WAITING, base.EDIT]:
            self.assertEqual(self.invoke(self.snapshot(rows), live)[0], {"decision": "block", "reason": reason})
        self.assertEqual(self.invoke(self.snapshot(rows), live)[0], {})
