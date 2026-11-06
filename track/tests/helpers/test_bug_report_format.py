"""TRACK-52 bug-report helper: the ticket shows the note and logs literally once Plane renders them.

Codex review 2026-11-06: plane-cli.py cmd_create sends --description as raw HTML (<p>{description}</p>),
so literal tags, ampersands and line breaks in a note or a hook log are lost when Plane renders it.
The fake CLI's argv is rendered the way a browser would read that HTML.

Run: python3 -m unittest discover -s track/tests/helpers -p 'test_bug_report_format.py' -v
"""

from html.parser import HTMLParser
import re
import unittest

from test_bug_report import BugReportTest

NOTE = "literal <error>Q2 & Q3</error> after compact\nsecond line of the note"


class BrowserText(HTMLParser):
    """Visible text of an HTML fragment: unknown tags vanish, whitespace collapses, <br> and <p> break lines."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in ("br", "p"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag == "p":
            self.parts.append("\n")

    def handle_data(self, data):
        self.parts.append(re.sub(r"\s+", " ", data))

    def text(self):
        lines = "".join(self.parts).split("\n")
        return "\n".join(line.strip() for line in lines if line.strip())


def rendered(description):
    parser = BrowserText()
    parser.feed("<p>" + description + "</p>")
    parser.close()
    return parser.text()


class TicketFormatTest(BugReportTest):
    # Reuse the fixture only; the base tests run in their own module.
    for _name in [n for n in dir(BugReportTest) if n.startswith("test_")]:
        locals()[_name] = None
    del _name

    def test_note_renders_literally_with_its_line_breaks(self):
        _, out = self.preview(note=NOTE)
        filed = self.run_helper(["file"], {"v": 1, "draft_id": out["draft_id"]})
        self.assertEqual(filed.returncode, 0, filed.stderr)
        argv = self.plane_calls()[0]
        self.assertEqual(argv.count("--description"), 1)
        lines = rendered(argv[argv.index("--description") + 1]).split("\n")
        self.assertIn("literal <error>Q2 & Q3</error> after compact", lines)
        self.assertIn("second line of the note", lines)

    def test_hook_log_renders_literally(self):
        _, out = self.preview()
        self.run_helper(["file"], {"v": 1, "draft_id": out["draft_id"]})
        argv = self.plane_calls()[0]
        text = rendered(argv[argv.index("--description") + 1])
        # The fixture's hook command and stderr reach the ticket as plain visible text.
        self.assertIn("SessionStart:compact exit 1", text)
        self.assertIn("session-context.sh", text)


if __name__ == "__main__":
    unittest.main()
