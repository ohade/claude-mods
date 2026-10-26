"""TRACK-39 A2 pin rows from the manager's rulings on the collect self-check.

Same fixture as test_history_collect.py: real history.py processes and real
writer-lock leases in a temporary CLAUDE_CONFIG_DIR. P1-P3 change behaviour
(precommit response bound, damaged-root wording, lock-shape preflight); P4-P9
pin paths the first rows did not reach.
"""
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
import uuid

from test_history import HISTORY, checksum, compact
from test_history_collect import DAY_MS, CollectFixture, now_ms

LIMIT_RUNNER = Path(__file__).resolve().parent / "history_limit_runner.py"
FIRST = "00000000-0000-4000-8000-000000000001"
SECOND = "00000000-0000-4000-8000-000000000002"


class CollectPinTests(CollectFixture):

    def locks(self):
        return self.config / "state" / "track" / "locks"

    def collect_limited(self, row, limit):
        request = {"v": 3, "op": "collect", "store": self.store, "protected": [], "dry_run": False, "limit": 50}
        completed = subprocess.run([sys.executable, str(LIMIT_RUNNER), str(HISTORY), "collect", str(limit)],
                                   input=compact(request), capture_output=True, env=self.environment,
                                   cwd=self.scratch, timeout=20)
        return completed, self.parse_response(completed, request, row)

    def test_p1_response_over_the_bound_refuses_precommit_with_zero_changes(self):
        for _ in range(3):
            self.save_at("P1", now_ms() - 8 * DAY_MS)
        before = self.inventory()
        completed, response = self.collect_limited("P1", 400)
        self.assert_refusal(completed, response, "P1", "collect response too large")
        self.assertEqual(self.inventory(), before, "P1: refused before any rename")

    def test_p2_damaged_root_with_a_root_name_refuses_as_damaged(self):
        session = str(uuid.uuid4())
        path = self.namespace() / "roots" / (session + ".json")
        path.write_bytes(b"{}")
        path.chmod(0o600)
        before = self.inventory()
        completed, response = self.collect("P2")
        self.assert_refusal(completed, response, "P2", "v3 history damaged: roots/" + session + ".json")
        self.assertNotIn("unknown entry", response["reason"], "P2: a recognised name is not unknown")
        self.assertEqual(self.inventory(), before, "P2: zero changes")

    def test_p2b_damaged_trash_entry_with_a_trash_name_refuses_as_damaged(self):
        self.save_at("P2b", now_ms() - 8 * DAY_MS)
        self.collected("P2b trash")
        [entry] = self.trash_entries()
        path = self.namespace() / "trash" / entry
        path.write_bytes(path.read_bytes() + b" ")
        before = self.inventory()
        completed, response = self.collect("P2b")
        self.assert_refusal(completed, response, "P2b", "v3 history damaged: trash/" + entry)
        self.assertEqual(self.inventory(), before, "P2b: zero changes")

    def test_p3_an_odd_lock_shape_refuses_before_any_rename(self):
        self.save_at("P3", now_ms() - 8 * DAY_MS, session=FIRST)
        self.save_at("P3", now_ms() - 8 * DAY_MS, session=SECOND)
        os.link(self.locks() / (SECOND + ".lock"), self.locks() / "p3-extra-link")
        before = self.inventory()
        completed, response = self.collect("P3")
        self.assert_refusal(completed, response, "P3")
        self.assertEqual(self.inventory(), before, "P3: the first victim was not renamed either")

    def test_p4_content_null_fence_root_ages_by_mtime(self):
        stale, fresh = str(uuid.uuid4()), str(uuid.uuid4())
        for session in (stale, fresh):
            lease = self.start_lease("P4", session=session)
            request = {"v": 3, "op": "resolve", "store": self.store, "session_id": session,
                       "module_token": self.token, "request_id": str(uuid.uuid4()),
                       "expect": {"absent": True}, "resolve_id": str(uuid.uuid4())}
            completed, response = self.invoke(request, "P4 fence")
            self.assert_ok(completed, response, "P4 fence")
            self.assertEqual(response["outcome"], "fenced", "P4: a content-null fence root was written")
            lease.stop()
            self.children.remove(lease)
        old = (now_ms() - 8 * DAY_MS) / 1000
        os.utime(self.root_of(stale), (old, old))
        response = self.collected("P4")
        self.assertEqual([entry["session_id"] for entry in response["trashed"]], [stale], "P4: the 8-day fence root is trashed")
        self.assertEqual(self.kept(response).get(fresh), "young", "P4: the fresh fence root is kept young")

    def test_p5_missing_lock_file_means_no_live_owner(self):
        session, _ = self.save_at("P5", now_ms() - 8 * DAY_MS)
        (self.locks() / (session + ".lock")).unlink()
        response = self.collected("P5")
        self.assertEqual([entry["session_id"] for entry in response["trashed"]], [session], "P5: trashed without a lock file")

    def test_p6_own_temp_names_are_tolerated_and_left(self):
        self.save_at("P6", now_ms() - 6 * DAY_MS)
        temps = [self.namespace() / "roots" / ("." + str(uuid.uuid4()) + ".123.0123456789abcdef.tmp"),
                 self.namespace() / "objects" / ("." + checksum(b"temp") + ".123.0123456789abcdef.tmp")]
        for path in temps:
            path.write_bytes(b"partial")
            path.chmod(0o600)
        response = self.collected("P6")
        self.assertEqual(response["trashed"], [], "P6: nothing expired")
        self.assertTrue(all(path.exists() for path in temps), "P6: temp files are left in place")

    def test_p7_bad_collect_schema_refuses(self):
        base = {"v": 3, "op": "collect", "store": self.store, "protected": [], "dry_run": False, "limit": 50}
        cases = {"limit 0": {"limit": 0}, "limit 51": {"limit": 51}, "dry_run text": {"dry_run": "no"},
                 "protected not uuid4": {"protected": ["not-a-session"]},
                 "protected over 64": {"protected": [str(uuid.uuid4()) for _ in range(65)]},
                 "extra key": {"session_id": str(uuid.uuid4())}}
        for name, change in cases.items():
            completed, response = self.invoke({**base, **change}, "P7 " + name)
            self.assert_refusal(completed, response, "P7 " + name, "invalid")

    def test_p8_restore_of_an_absent_trash_entry_refuses(self):
        session, receipt = self.save_at("P8", now_ms() - 8 * DAY_MS)
        self.collected("P8")
        [entry] = self.trash_entries()
        other = entry.rsplit(".", 2)[0] + ".1.json"
        request = {"v": 3, "op": "restore", "store": self.store, "session_id": session, "entry": other}
        completed, response = self.invoke(request, "P8")
        self.assert_refusal(completed, response, "P8", "trash entry absent")
        self.assertEqual(self.trash_entries(), [entry], "P8: the real entry stays")

    def test_p9_restore_of_a_damaged_trash_entry_refuses(self):
        session, _ = self.save_at("P9", now_ms() - 8 * DAY_MS)
        self.collected("P9")
        [entry] = self.trash_entries()
        path = self.namespace() / "trash" / entry
        path.write_bytes(path.read_bytes() + b" ")
        request = {"v": 3, "op": "restore", "store": self.store, "session_id": session, "entry": entry}
        completed, response = self.invoke(request, "P9")
        self.assert_refusal(completed, response, "P9", "v3 history damaged")
        self.assertFalse(self.root_of(session).exists(), "P9: nothing was restored")


if __name__ == "__main__":
    unittest.main()
