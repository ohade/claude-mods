"""GR-1: release-state tests must work before any other suite creates .local."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class FreshCheckoutTest(unittest.TestCase):
    def test_state_suite_passes_without_a_preexisting_local_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            checkout = Path(directory)
            tests = checkout / 'scripts/tests'
            tests.mkdir(parents=True)
            shutil.copy2(ROOT / 'scripts/land-state.py', checkout / 'scripts/land-state.py')
            shutil.copy2(ROOT / 'scripts/tests/test_land_state.py', tests / 'test_land_state.py')
            self.assertFalse((checkout / '.local').exists())
            result = subprocess.run(
                [sys.executable, str(tests / 'test_land_state.py')],
                capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('OK', result.stderr)


if __name__ == '__main__':
    unittest.main()
