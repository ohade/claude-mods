"""Real cancellation during timeout cleanup, plus signal-handler lifetime."""
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
spec = importlib.util.spec_from_file_location('land_cleanup', ROOT / 'scripts/land-state.py')
state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state)


class CleanupSignalTest(unittest.TestCase):
    def assert_stopped(self, pid):
        deadline = time.monotonic() + 2
        while True:
            result = subprocess.run(['/bin/ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True, check=False)
            stopped = result.returncode == 1 or result.stdout.strip().startswith('Z')
            if stopped or time.monotonic() >= deadline:
                self.assertTrue(stopped, 'a cancellation during timeout cleanup must not leave the owned process alive')
                return
            time.sleep(.01)

    def cancel_during_timeout_cleanup(self, cancellation):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child, parent = root / 'child.py', root / 'parent.py'
            child_pid_file, group_file, term_file = root / 'child.pid', root / 'parent.pgid', root / 'term.received'
            child.write_text(
                'import os,pathlib,signal,sys,time\n'
                'signal.signal(signal.SIGTERM,signal.SIG_IGN)\n'
                'pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\n'
                'time.sleep(30)\n'
            )
            parent.write_text(
                'import os,pathlib,signal,subprocess,sys,time\n'
                'signal.signal(signal.SIGTERM,lambda *_:pathlib.Path(sys.argv[4]).write_text("term"))\n'
                'pathlib.Path(sys.argv[2]).write_text(str(os.getpgid(0)))\n'
                'subprocess.Popen([sys.executable,sys.argv[1],sys.argv[3]])\n'
                'time.sleep(30)\n'
            )
            supervisor = subprocess.Popen([
                sys.executable, str(ROOT / 'scripts/land-state.py'), 'run', '1',
                sys.executable, str(parent), str(child), str(group_file), str(child_pid_file), str(term_file),
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            child_pid = group = None
            try:
                deadline = time.monotonic() + 5
                while not all(path.exists() for path in (child_pid_file, group_file, term_file)) and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(all(path.exists() for path in (child_pid_file, group_file, term_file)), 'the parent must observe timeout TERM before the cancellation')
                child_pid, group = int(child_pid_file.read_text()), int(group_file.read_text())
                self.assertEqual(os.getpgid(child_pid), group)
                os.kill(supervisor.pid, cancellation)
                supervisor.wait(timeout=5)
                self.assert_stopped(child_pid)
                self.assert_stopped(group)
                self.assertEqual(supervisor.returncode, 1, 'timeout remains the first failure cause')
                _, stderr = supervisor.communicate(timeout=5)
                self.assertNotIn('Traceback', stderr)
            finally:
                child_pid = child_pid if child_pid is not None else int(child_pid_file.read_text()) if child_pid_file.exists() else None
                group = group if group is not None else int(group_file.read_text()) if group_file.exists() else None
                for pid in (child_pid, group):
                    if pid is None or group is None:
                        continue
                    try:
                        if os.getpgid(pid) == group:
                            os.killpg(group, signal.SIGKILL)
                            break
                    except ProcessLookupError:
                        pass  # The named member already exited.
                if supervisor.poll() is None:
                    supervisor.kill()
                supervisor.communicate(timeout=5)
                for pid in (child_pid, group):
                    if pid is not None:
                        self.assert_stopped(pid)

    def test_term_during_timeout_cleanup(self):
        self.cancel_during_timeout_cleanup(signal.SIGTERM)

    def test_int_during_timeout_cleanup(self):
        self.cancel_during_timeout_cleanup(signal.SIGINT)

    def test_existing_handlers_are_restored_after_timeout(self):
        previous = {kind: signal.getsignal(kind) for kind in (signal.SIGTERM, signal.SIGINT)}
        sentinel = lambda *_: None
        try:
            for kind in previous:
                signal.signal(kind, sentinel)
            self.assertEqual(state.run_bounded(0, [sys.executable, '-c', 'import time; time.sleep(30)']), 1)
            for kind in previous:
                self.assertIs(signal.getsignal(kind), sentinel, 'the library call must restore the caller handler')
        finally:
            for kind, handler in previous.items():
                signal.signal(kind, handler)


if __name__ == '__main__':
    unittest.main()
