"""FIXTURE: TRACK-44 repair wording through the real isolated Stop helper and claims.

When the snapshot names the waiting step's subject, the block tells the model to ask with the title
Ohad sees on the pane; an old snapshot without a usable subject keeps the legacy wording.
Run: python3 -m unittest -v test_track44_waiting_title   (cwd = track/tests/helpers)
"""
import test_step_freshness_stop as base

TITLE = "Approve the compact-crafter install"
TITLED = (f'track: "{TITLE}" (plan:1) is waiting, but the final reply has no 👉 {TITLE}: request line. '
          "Ask the user visibly, then finish.")


class WaitingTitleTests(base.StepFreshnessStopTests):
    def test_subject_names_the_visible_title_in_the_repair(self):
        snapshot = self.snapshot([base.candidate("missing_waiting_request", subject=TITLE)])
        self.assertEqual(self.invoke(snapshot)[0], {"decision": "block", "reason": TITLED})
        self.assertEqual(self.invoke(snapshot)[0], {}, "the block is claimed once")

    def test_a_missing_or_unusable_subject_keeps_the_legacy_wording(self):
        for label, extra in (("absent", {}), ("empty", {"subject": "  "}), ("not text", {"subject": 7})):
            with self.subTest(subject=label):
                turn = f"legacy-{label.replace(' ', '-')}"
                snapshot = self.snapshot([base.candidate("missing_waiting_request", **extra)], turn_id=turn,
                                         response={"turn_id": turn, "request_id": "response"})
                self.assertEqual(self.invoke(snapshot)[0], {"decision": "block", "reason": base.WAITING})

    def test_other_kinds_ignore_a_subject(self):
        snapshot = self.snapshot([base.candidate(subject=TITLE)])
        self.assertEqual(self.invoke(snapshot)[0], {"decision": "block", "reason": base.STALE})
