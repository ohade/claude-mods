"""FIXTURE tests for receipt counts and dead/unknown lock ownership."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('land_state', ROOT / 'scripts/land-state.py')
state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state)


class LandStateTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=ROOT / '.local')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.log = self.root / 'mod.log'
        self.mods = self.root / 'mods.json'
        self.mods.write_text('{}')

    def test_native_footer_counts(self):
        self.log.write_text('\x1b[32m 487 pass\x1b[0m\n 0 fail\nRan 487 tests across 65 files. [9.76s]\n')
        state.record_counts(self.log, 'track', self.mods)
        self.assertEqual(json.loads(self.mods.read_text()), {'track': {'pass': 487, 'fail': 0}})

    def test_failed_counts_are_recorded_without_attesting_success(self):
        self.log.write_text(' 487 pass\n 1 fail\nRan 488 tests across 65 files. [9.76s]\n')
        with self.assertRaisesRegex(ValueError, 'non-passing'):
            state.record_counts(self.log, 'track', self.mods)
        self.assertEqual(json.loads(self.mods.read_text()), {'track': {'pass': 487, 'fail': 1}})

    def test_missing_footer_does_not_invent_counts(self):
        self.log.write_text('completed\n')
        with self.assertRaisesRegex(ValueError, 'footer missing'):
            state.record_counts(self.log, 'track', self.mods)
        self.assertEqual(self.mods.read_text(), '{}')

    def test_old_dead_owner_is_reclaimed(self):
        child = subprocess.Popen(['/usr/bin/true'])
        child.wait()
        lock = self.root / 'lock'
        lock.mkdir()
        (lock / 'owner.json').write_text(json.dumps({'pid': child.pid, 'created_at': 0, 'host': socket.gethostname()}))
        state.acquire_lock(str(lock), os.getpid())
        self.assertEqual(json.loads((lock / 'owner.json').read_text())['pid'], os.getpid())
        state.release_lock(str(lock), os.getpid())
        self.assertFalse(lock.exists())

    def test_unknown_owner_is_not_reclaimed(self):
        lock = self.root / 'lock'
        lock.mkdir()
        (lock / 'owner.json').write_text('{broken')
        with self.assertRaisesRegex(ValueError, 'lock held'):
            state.acquire_lock(str(lock), os.getpid())
        self.assertEqual((lock / 'owner.json').read_text(), '{broken')


if __name__ == '__main__':
    unittest.main()
