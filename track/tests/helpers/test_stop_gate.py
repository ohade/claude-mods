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

    # FIXTURE: pins the plugin/hook wire contract. gates.test.tsx builds the same
    # literal from ANSWER the way the module's stopEvent does and asserts it equal.
    def open_reason(self, rest):
        return ('track: Q2 "question 2" from this turn is still open' + rest + '. '
                'Write the formatted answer once between standalone <!-- A2:start --> and <!-- A2:end --> lines, '
                'using its stable numeric id; Track captures it automatically. Do not also send answer_text. '
                'For a tool/file-only answer, call mcp__track__mark_answered with the completed answer_text. '
                'If it must wait, call mcp__track__mark_answered with status "deferred" and a note. Then finish.')

    def open_rows(self, *ids):
        return [{"id": qid, "head": f"question {qid}"} for qid in ids]

    def open_block(self, rows, **extra):
        snapshot = {**self.snapshot(), "open": rows, **extra}
        return self.invoke({"session_id": SID, "stop_hook_active": False}, snapshot)

    def test_open_question_reason_equals_module_and_lists_the_others(self):
        expected = ('track: Q2 "question 2" from this turn is still open (2 more open: Q3, Q5). '
                    'Write the formatted answer once between standalone <!-- A2:start --> and <!-- A2:end --> lines, '
                    'using its stable numeric id; Track captures it automatically. Do not also send answer_text. '
                    'For a tool/file-only answer, call mcp__track__mark_answered with the completed answer_text. '
                    'If it must wait, call mcp__track__mark_answered with status "deferred" and a note. Then finish.')
        self.assertEqual(self.open_block(self.open_rows(2, 3, 5)), {"decision": "block", "reason": expected})

    def test_single_open_question_has_no_more_open_part(self):
        self.assertEqual(self.open_block(self.open_rows(2)), {"decision": "block", "reason": self.open_reason("")})

    def test_open_count_names_questions_beyond_the_listed_rows(self):
        rows = self.open_rows(2, 3, 4, 5, 6)
        for count, rest in ((7, " (6 more open: Q3, Q4, Q5, Q6 and 2 others)"),
                            (6, " (5 more open: Q3, Q4, Q5, Q6 and 1 other)")):
            with self.subTest(open_count=count):
                self.assertEqual(self.open_block(rows, open_count=count),
                                 {"decision": "block", "reason": self.open_reason(rest)})

    def test_invalid_later_row_is_counted_but_not_listed(self):
        rows = [*self.open_rows(2), {"id": "3", "head": "question 3"}, *self.open_rows(5)]
        self.assertEqual(self.open_block(rows),
                         {"decision": "block", "reason": self.open_reason(" (2 more open: Q5 and 1 other)")})

    def test_invalid_open_count_behaves_as_absent(self):
        expected = {"decision": "block", "reason": self.open_reason(" (2 more open: Q3, Q5)")}
        for count in (True, "7", 2, -1):
            with self.subTest(open_count=count):
                self.assertEqual(self.open_block(self.open_rows(2, 3, 5), open_count=count), expected)

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
                                "attributed_task_ids": ["worker-7"],
                                "response": {"turn_id": kind, "request_id": "fixture-main"}, "held": []}
                    payload = {"session_id": SID, "background_tasks": [{"id": "worker-7", "type": "agent"}]}
                    self.assertEqual(self.invoke(payload, snapshot, config), {"decision": "block", "reason": reason})
                    self.assertEqual(self.invoke(payload, snapshot, config), {})


if __name__ == "__main__":
    unittest.main()
