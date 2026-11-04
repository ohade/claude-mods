"""GR-1: timing out a command must also stop its TERM-ignoring children."""
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('land_process', ROOT / 'scripts/land-state.py')
state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state)


class BoundedProcessTest(unittest.TestCase):
    def test_sigterm_stops_child_before_supervisor_exits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child = root / 'child.py'
            parent = root / 'parent.py'
            pid_file = root / 'child.pid'
            group_file = root / 'parent.pgid'
            child.write_text(
                'import os, pathlib, signal, sys, time\n'
                'signal.signal(signal.SIGTERM, signal.SIG_IGN)\n'
                'pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\n'
                'time.sleep(30)\n'
            )
            parent.write_text(
                'import os, pathlib, subprocess, sys, time\n'
                'pathlib.Path(sys.argv[2]).write_text(str(os.getpgid(0)))\n'
                'subprocess.Popen([sys.executable, sys.argv[1], sys.argv[3]])\n'
                'time.sleep(30)\n'
            )
            supervisor = subprocess.Popen([
                sys.executable, str(ROOT / 'scripts/land-state.py'), 'run', '30',
                sys.executable, str(parent), str(child), str(group_file), str(pid_file),
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            child_pid = None
            group = None

            def assert_stopped(pid, message):
                deadline = time.monotonic() + 2
                while True:
                    process = subprocess.run(['/bin/ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True, check=False)
                    stopped = process.returncode == 1 or process.stdout.strip().startswith('Z')
                    if stopped or time.monotonic() >= deadline:
                        self.assertTrue(stopped, message)
                        return
                    time.sleep(.01)

            try:
                deadline = time.monotonic() + 5
                while not (pid_file.exists() and group_file.exists()) and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(pid_file.exists() and group_file.exists(), 'the owned parent and child must start')
                child_pid = int(pid_file.read_text())
                group = int(group_file.read_text())
                self.assertEqual(os.getpgid(child_pid), group, 'the child belongs to the recorded owned group')
                os.kill(supervisor.pid, signal.SIGTERM)
                supervisor.wait(timeout=10)
                assert_stopped(child_pid, 'TERM-ignoring child remains alive after supervisor SIGTERM')
                self.assertEqual(supervisor.returncode, 143)
            finally:
                group = group if group is not None else int(group_file.read_text()) if group_file.exists() else None
                child_pid = child_pid if child_pid is not None else int(pid_file.read_text()) if pid_file.exists() else None
                for pid in (child_pid, group):
                    if pid is None or group is None:
                        continue
                    try:
                        if os.getpgid(pid) == group:
                            os.killpg(group, signal.SIGKILL)
                            break
                    except ProcessLookupError:
                        pass  # This exact owned member already exited.
                if supervisor.poll() is None:
                    supervisor.kill()
                supervisor.communicate(timeout=5)
                for pid in (child_pid, group):
                    if pid is not None:
                        assert_stopped(pid, 'the test must not leak its owned parent or child')

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
