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


class LockNamespaceTests(unittest.TestCase):
    """The helper must lock where register.tsx configDir() points, never under its cwd."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.home = self.root / "home"
        self.cwd = self.root / "cwd"
        self.home.mkdir()
        self.cwd.mkdir()
        inherited = ("TRACK_LOCK_DIR", "CLAUDE_CONFIG_DIR")
        self.env = {name: value for name, value in os.environ.items() if name not in inherited}
        self.env["HOME"] = str(self.home)
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()
            child.communicate(timeout=5)
        self.tmp.cleanup()

    def start(self, mode):
        child = subprocess.Popen(["python3", str(HELPER), mode, SID, "owner"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env, cwd=self.cwd)
        self.children.append(child)
        return json.loads(child.stdout.readline())

    def assert_locks_in(self, directory):
        self.assertTrue(self.start("lease")["ok"])
        self.assertTrue(self.start("write")["ok"])
        self.assertTrue((directory / f"{SID}.lock").is_file(), f"the lease lock must be in {directory}")
        self.assertTrue((directory / "store.lock").is_file(), f"the store lock must be in {directory}")
        self.assertFalse((self.cwd / "state").exists(), "the helper must not create a lock namespace under its cwd")
        with open(directory / "store.lock", "r+") as probe:
            with self.assertRaises(BlockingIOError, msg="the live write helper must hold the expected store lock"):
                fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_empty_config_dir_falls_back_to_home_claude(self):
        self.env["CLAUDE_CONFIG_DIR"] = ""
        self.assert_locks_in(self.home / ".claude" / "state" / "track" / "locks")

    def test_unset_config_dir_falls_back_to_home_claude(self):
        self.assert_locks_in(self.home / ".claude" / "state" / "track" / "locks")

    def test_explicit_config_dir_is_used(self):
        config = self.root / "config"
        self.env["CLAUDE_CONFIG_DIR"] = str(config)
        self.assert_locks_in(config / "state" / "track" / "locks")
        self.assertFalse((self.home / ".claude").exists(), "an explicit config dir must not fall back to HOME")

    def test_track_lock_dir_overrides_config_dir(self):
        config = self.root / "config"
        locks = self.root / "locks"
        self.env["CLAUDE_CONFIG_DIR"] = str(config)
        self.env["TRACK_LOCK_DIR"] = str(locks)
        self.assert_locks_in(locks)
        self.assertFalse((config / "state").exists(), "TRACK_LOCK_DIR must replace the config namespace")


if __name__ == "__main__":
    unittest.main()
