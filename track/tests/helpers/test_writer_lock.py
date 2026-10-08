"""Release gates for the Track-owned lock; it never reads or writes a ledger."""
import json
import fcntl
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

HELPER = Path(__file__).resolve().parents[2] / "hooks" / "writer-lock.py"
SID = "11111111-2222-4333-8444-555555555555"


class WriterLockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = dict(os.environ, TRACK_LOCK_DIR=self.tmp.name)
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()
            child.communicate(timeout=5)
        self.tmp.cleanup()

    def start(self, mode, session=SID, token="owner"):
        child = subprocess.Popen(["python3", str(HELPER), mode, session, token], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env)
        self.children.append(child)
        return child, json.loads(child.stdout.readline())

    def test_duplicate_session_refused_while_owner_is_alive(self):
        _, first = self.start("lease")
        child, second = self.start("lease", token="other")
        self.assertEqual(first, {"ok": True, "mode": "lease", "token": "owner"})
        self.assertFalse(second["ok"])
        self.assertIn("another", second["reason"])
        self.assertNotEqual(child.wait(timeout=5), 0)

    def test_terminated_owner_releases_session_without_stale_pid_guessing(self):
        child, first = self.start("lease")
        self.assertTrue(first["ok"])
        child.terminate()
        child.wait(timeout=5)
        _, second = self.start("lease", token="new-owner")
        self.assertTrue(second["ok"])

    def test_store_write_requires_the_matching_live_session_lease(self):
        _, lease = self.start("lease")
        self.assertTrue(lease["ok"])
        _, good = self.start("write")
        self.assertTrue(good["ok"])
        child, wrong = self.start("write", token="wrong")
        self.assertFalse(wrong["ok"])
        self.assertNotEqual(child.wait(timeout=5), 0)

    def test_store_write_without_live_lease_is_refused(self):
        child, value = self.start("write")
        self.assertFalse(value["ok"])
        self.assertNotEqual(child.wait(timeout=5), 0)

    def test_waiting_store_writer_rechecks_lease_after_a_new_owner_takes_over(self):
        lease, value = self.start("lease")
        self.assertTrue(value["ok"])
        with open(Path(self.tmp.name) / "store.lock", "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            writer = subprocess.Popen(["python3", str(HELPER), "write", SID, "owner"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env)
            self.children.append(writer)
            # Hold the global lock while the old writer validates its lease.
            time.sleep(0.25)
            self.assertIsNone(writer.poll())
            lease.terminate()
            lease.wait(timeout=5)
            _, new = self.start("lease", token="new-owner")
            self.assertTrue(new["ok"])
            fcntl.flock(held, fcntl.LOCK_UN)
        result = json.loads(writer.stdout.readline())
        self.assertFalse(result["ok"], "the old token must not write after waiting behind another store writer")
        self.assertIn("identity", result["reason"])
        self.assertNotEqual(writer.wait(timeout=5), 0)


if __name__ == "__main__":
    unittest.main()
