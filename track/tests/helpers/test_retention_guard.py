"""TRACK-21: real target-lease exclusion, not simulated store receipts."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

HELPER = Path(__file__).resolve().parents[2] / 'hooks' / 'writer-lock.py'
SID = '11111111-2222-4333-8444-555555555555'


class RetentionGuardTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix='track21-guard-'))
        self.environment = dict(os.environ, TRACK_LOCK_DIR=str(self.directory))
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()
            child.communicate(timeout=5)
        self.directory.rename(Path.home() / '.Trash' / self.directory.name)

    def start_helper(self, mode, token='cleaner'):
        child = subprocess.Popen(['python3', str(HELPER), mode, SID, token],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, env=self.environment)
        self.children.append(child)
        return child, json.loads(child.stdout.readline())

    def test_closed_guard_holds_existing_target_lease_until_released(self):
        guard, receipt = self.start_helper('guard')
        self.assertTrue(receipt['ok'], receipt)
        self.assertEqual(receipt['state'], 'closed')
        with open(self.directory / f'{SID}.lock', 'r+') as target:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(target, fcntl.LOCK_EX | fcntl.LOCK_NB)
            guard.terminate()
            guard.wait(timeout=5)
            fcntl.flock(target, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_live_guard_keeps_the_owner_token_unchanged(self):
        _, owner = self.start_helper('lease', 'owner')
        self.assertTrue(owner['ok'])
        before = (self.directory / f'{SID}.lock').read_bytes()
        _, receipt = self.start_helper('guard')
        self.assertTrue(receipt['ok'], receipt)
        self.assertEqual(receipt['state'], 'live')
        self.assertEqual((self.directory / f'{SID}.lock').read_bytes(), before)

    def test_startup_waits_for_brief_cleanup_contention(self):
        with open(self.directory / f'{SID}.lock', 'w') as target:
            fcntl.flock(target, fcntl.LOCK_EX | fcntl.LOCK_NB)
            child = subprocess.Popen(['python3', str(HELPER), 'lease', SID, 'starter'],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     text=True, env=self.environment)
            self.children.append(child)
            time.sleep(0.1)
            fcntl.flock(target, fcntl.LOCK_UN)
        receipt = json.loads(child.stdout.readline())
        self.assertTrue(receipt['ok'], receipt)


if __name__ == '__main__':
    unittest.main()
