"""Release gates for the Track-owned lock; it never reads or writes a ledger."""
import json
import fcntl
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time
import unittest
import uuid

HELPER = Path(__file__).resolve().parents[2] / "hooks" / "writer-lock.py"
SID = "11111111-2222-4333-8444-555555555555"
SCRUB_ENVIRONMENT = ("TRACK_LOCK_PROTOCOL", "TRACK_LOCK_DIR", "CLAUDE_CONFIG_DIR")


def assert_write_grant(test, receipt, directory, token="owner"):
    transaction = receipt.get("transaction")
    test.assertIsInstance(transaction, dict, receipt)
    test.assertEqual(set(transaction), {"id", "nonce"})
    transaction_id = transaction["id"]
    test.assertIsInstance(transaction_id, str)
    parsed = uuid.UUID(transaction_id)
    test.assertEqual(parsed.version, 4)
    test.assertEqual(str(parsed), transaction_id)
    test.assertRegex(transaction["nonce"], r"\A[0-9a-f]{64}\Z")
    test.assertEqual(receipt, {"ok": True, "protocol": 2, "mode": "write",
                               "token": token, "transaction": transaction})
    marker = json.loads((directory / "tx" / (transaction_id + ".json")).read_text())
    test.assertEqual(set(marker), {"v", "id", "nonce", "session_id", "module_token",
                                   "owner", "helper"})
    test.assertEqual((marker["v"], marker["id"], marker["nonce"],
                      marker["session_id"], marker["module_token"]),
                     (2, transaction_id, transaction["nonce"], SID, token))
    test.assertIsInstance(marker["owner"], dict)
    test.assertIsInstance(marker["helper"], dict)


class WriterLockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.home = self.root / "home"
        self.config = self.root / "config"
        self.directory = self.config / "state" / "track" / "locks"
        self.home.mkdir(mode=0o700)
        self.env = {name: value for name, value in os.environ.items()
                    if name not in SCRUB_ENVIRONMENT}
        self.env.update(HOME=str(self.home), CLAUDE_CONFIG_DIR=str(self.config),
                        TRACK_LOCK_PROTOCOL="2")
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
        self.assertEqual(first, {"ok": True, "protocol": 2, "mode": "lease", "token": "owner"})
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
        assert_write_grant(self, good, self.directory)
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
        with open(self.directory / "store.lock", "w") as held:
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
        self.root = Path(self.tmp.name).resolve()
        self.home = self.root / "home"
        self.cwd = self.root / "cwd"
        self.home.mkdir(mode=0o700)
        self.cwd.mkdir(mode=0o700)
        self.env = {name: value for name, value in os.environ.items()
                    if name not in SCRUB_ENVIRONMENT}
        self.env.update(HOME=str(self.home), TRACK_LOCK_PROTOCOL="2")
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
        return child, json.loads(child.stdout.readline())

    def assert_locks_in(self, directory):
        _, lease = self.start("lease")
        self.assertTrue(lease["ok"])
        _, write = self.start("write")
        self.assertTrue(write["ok"])
        assert_write_grant(self, write, directory)
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

    def test_track_lock_dir_presence_is_refused_before_namespace_effects(self):
        config = self.root / "config"
        override = self.root / "override"
        config.mkdir(mode=0o700)
        override.mkdir(mode=0o700)
        canaries = (config / "canary", override / "canary")
        for canary in canaries:
            canary.write_bytes(b"keep this fixture unchanged\n")
            canary.chmod(0o640)

        def snapshot():
            entries = {}
            for path in (self.root, *self.root.rglob("*")):
                metadata = path.lstat()
                payload = path.read_bytes() if stat.S_ISREG(metadata.st_mode) else None
                entries[str(path.relative_to(self.root))] = (
                    metadata.st_mode, metadata.st_ino, payload)
            return entries

        before = snapshot()
        self.env["CLAUDE_CONFIG_DIR"] = str(config)
        for value in ("", str(override)):
            for mode in ("lease", "write", "guard"):
                with self.subTest(override=value, mode=mode):
                    self.env["TRACK_LOCK_DIR"] = value
                    child, receipt = self.start(mode)
                    self.assertEqual(receipt, {
                        "ok": False, "reason": "protocol 2 does not accept TRACK_LOCK_DIR",
                    })
                    output, error = child.communicate(timeout=5)
                    self.assertEqual(child.returncode, 1)
                    self.assertEqual((output, error), ("", ""))
                    self.assertEqual(snapshot(), before,
                                     "refusal must preserve the entire fixture namespace")


if __name__ == "__main__":
    unittest.main()
