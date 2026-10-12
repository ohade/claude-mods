"""FIXTURE: 2026-10-12 ordinary Stop must not request a duplicate answer."""
import importlib.util
from pathlib import Path
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / "hooks" / "stop-gate.py"
spec = importlib.util.spec_from_file_location("track_stop", SCRIPT)
stop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stop)


class MarkerStopTests(unittest.TestCase):
    def test_normal_answer_uses_markers_and_tool_only_fallback_remains(self):
        snapshot = {"v": 1, "session_id": "fixture", "turn_id": "t1",
                    "open": [{"id": 25, "head": "Question"}]}
        answer = stop.decision({"session_id": "fixture"}, snapshot)
        self.assertEqual(answer["decision"], "block")
        self.assertIn("<!-- A25:start -->", answer["reason"])
        self.assertIn("<!-- A25:end -->", answer["reason"])
        self.assertIn("Do not also send answer_text", answer["reason"])
        self.assertIn("For a tool/file-only answer", answer["reason"])
        self.assertIn("mcp__track__mark_answered", answer["reason"])


if __name__ == "__main__":
    unittest.main()
