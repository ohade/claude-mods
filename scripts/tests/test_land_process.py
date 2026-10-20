"""GR-1: timing out a command must also stop its TERM-ignoring children."""
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('land_process', ROOT / 'scripts/land-state.py')
state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state)


class BoundedProcessTest(unittest.TestCase):
    def test_timeout_stops_child_when_its_parent_exits_on_term(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child = root / 'child.py'
            parent = root / 'parent.py'
            pid_file = root / 'child.pid'
            child.write_text(
                'import os, pathlib, signal, sys, time\n'
                'signal.signal(signal.SIGTERM, signal.SIG_IGN)\n'
                'pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\n'
                'time.sleep(30)\n'
            )
            parent.write_text(
                'import subprocess, sys, time\n'
                'subprocess.Popen([sys.executable, sys.argv[1], sys.argv[2]])\n'
                'time.sleep(30)\n'
            )
            child_pid = None
            try:
                result = state.run_bounded(1, [sys.executable, str(parent), str(child), str(pid_file)])
                self.assertEqual(result, 1)
                self.assertTrue(pid_file.exists(), 'child must start before the timeout')
                child_pid = int(pid_file.read_text())
                process = subprocess.run(
                    ['/bin/ps', '-o', 'stat=', '-p', str(child_pid)],
                    capture_output=True, text=True, check=False,
                )
                self.assertTrue(
                    process.returncode == 1 or process.stdout.strip().startswith('Z'),
                    'TERM-ignoring child remains alive after the bounded command returns',
                )
            finally:
                if child_pid is not None:
                    try:
                        os.kill(child_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass  # The production timeout path already terminated it.


if __name__ == '__main__':
    unittest.main()
