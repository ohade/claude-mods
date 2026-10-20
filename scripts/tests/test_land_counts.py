"""Characterisation: an existing zero-pass footer must never attest success."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('land_counts', ROOT / 'scripts/land-state.py')
state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state)


class CountsTest(unittest.TestCase):
    def test_zero_pass_is_recorded_but_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / 'native.log'
            counts = root / 'mods.json'
            log.write_text('0 passed, 0 failed\n')
            counts.write_text('{}')
            with self.assertRaisesRegex(ValueError, 'non-passing test counts: 0 pass, 0 fail'):
                state.record_counts(log, 'fixture', counts)
            self.assertEqual(json.loads(counts.read_text()), {'fixture': {'pass': 0, 'fail': 0}})


if __name__ == '__main__':
    unittest.main()
