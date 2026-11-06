"""TRACK-52 bug-report helper: quoted credential edge cases (automated security review, 2026-11-06).

f303c07's quoted rule stopped at an escaped quote (password="a\\"b c" left 'b c"') and left text glued to
the closing quote (password="ab"cd left 'cd', which the older whole-token rule removed). Checked
through the real preview path: stdout, outbound.json and note_out.

Run: python3 -m unittest discover -s track/tests/helpers -p 'test_bug_report_quote_edges.py' -v
"""

import unittest

from test_bug_report import BugReportTest

CASES = {
    "escaped double quote": ('password="EDGE_a\\"EDGE_b EDGE_c"', ("EDGE_a", "EDGE_b", "EDGE_c")),
    "text glued after double quote": ('token="EDGE_d"EDGE_e', ("EDGE_d", "EDGE_e")),
    "text glued after single quote": ("secret='EDGE_f'EDGE_g", ("EDGE_f", "EDGE_g")),
    "empty quotes then glued text": ('api_key=""EDGE_h', ("EDGE_h",)),
}


class QuoteEdgeTest(BugReportTest):
    # Reuse the fixture only; the base tests run in their own module.
    for _name in [n for n in dir(BugReportTest) if n.startswith("test_")]:
        locals()[_name] = None
    del _name

    def test_quoted_values_are_removed_whole_in_every_edge_case(self):
        for name, (note, words) in CASES.items():
            with self.subTest(name):
                result, out = self.preview(note=note + " tail_kept")
                self.assertEqual(result.returncode, 0, result.stderr)
                outbound = (self.report_root() / out["draft_id"] / "outbound.json").read_text()
                for word in words:
                    for where, text in (("stdout", result.stdout), ("outbound", outbound), ("note_out", out["note_out"])):
                        self.assertNotIn(word, text, f"{name}: {word} leaked in {where}")
                self.assertIn("tail_kept", out["note_out"])


if __name__ == "__main__":
    unittest.main()
