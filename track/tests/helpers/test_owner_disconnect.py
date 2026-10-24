"""TRACK-39 P1b1 FIXTURE gates: how the real protocol-2 helper tells a
half-closed output from a lost owner.

Bun 1.3.6 (observed; the engine's own Bun is unverified) gives a helper a
Unix-socket stdout whose parent end is shut for writing from the start. On
macOS that end reports POLLHUP although the helper can still write and the
parent still reads. A half-closed output must keep its grant; a reader that
really goes away must still end the helper. These checks launch no Claude and
read no user store.
"""
import fcntl
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid


HELPER = Path(__file__).resolve().parents[2] / "hooks" / "writer-lock.py"
GRANT_TIMEOUT = 5
EXIT_TIMEOUT = 3
# Longer than two 500 ms retention wakes.
HOLD = 1.2
# A helper that spins on ordinary writability would burn about HOLD seconds.
MAX_CPU_SECONDS = 0.6
SCRUB_ENVIRONMENT = (
    "TRACK_LOCK_PROTOCOL", "TRACK_LOCK_DIR", "CLAUDE_CONFIG_DIR",
    "PYTHONDONTWRITEBYTECODE", "PYTHONPYCACHEPREFIX",
)
# Starts the helper with this process's stdout, reports its pid, and exits
# once the test closes this process's stdin.
PARENT_SCRIPT = (
    "import json,subprocess,sys; "
    "child=subprocess.Popen(json.loads(sys.argv[1]),stdin=subprocess.DEVNULL,stderr=subprocess.DEVNULL); "
    "print(child.pid,file=sys.stderr,flush=True); sys.stdin.read()"
)


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def kill_quietly(pid):
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def stop_middle(middle):
    for stream in (middle.stdin, middle.stderr):
        if not stream.closed:
            stream.close()
    try:
        middle.wait(timeout=GRANT_TIMEOUT)
    except subprocess.TimeoutExpired:
        middle.kill()
        middle.wait(timeout=GRANT_TIMEOUT)


class Helper:
    """One real helper whose stdout is a socket or a pipe owned by the test."""

    def __init__(self, command, environment, cwd, transport, half_close):
        if transport == "socket":
            self.reader, child_end = socket.socketpair()
            if half_close:
                self.reader.shutdown(socket.SHUT_WR)
            child_fd = child_end.fileno()
        else:
            read_fd, child_fd = os.pipe()
            self.reader = os.fdopen(read_fd, "rb", buffering=0)
        self.process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=child_fd,
            stderr=subprocess.DEVNULL, env=environment, cwd=cwd,
        )
        if transport == "socket":
            child_end.close()
        else:
            os.close(child_fd)
        self.buffer = bytearray()
        self.status = None
        self.rusage = None

    def read_record(self, timeout=GRANT_TIMEOUT):
        deadline = time.monotonic() + timeout
        while b"\n" not in self.buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError("helper did not emit a receipt within the bounded wait")
            ready, _, _ = select.select([self.reader], [], [], remaining)
            if not ready:
                continue
            data = os.read(self.reader.fileno(), 4097)
            if not data:
                raise AssertionError("helper closed stdout before a receipt")
            self.buffer.extend(data)
        line, _, rest = bytes(self.buffer).partition(b"\n")
        self.buffer = bytearray(rest)
        return json.loads(line)

    def close_reader(self):
        self.reader.close()

    def running(self):
        if self.rusage is not None:
            return False
        pid, status, rusage = os.wait4(self.process.pid, os.WNOHANG)
        if pid == 0:
            return True
        self.status, self.rusage = status, rusage
        self.process.returncode = 0  # Reaped here; keep Popen from waiting again.
        return False

    def wait_exit(self, timeout=EXIT_TIMEOUT):
        deadline = time.monotonic() + timeout
        while self.running():
            if time.monotonic() >= deadline:
                raise AssertionError("helper still runs after its reader closed")
            time.sleep(0.02)

    def stop(self):
        if self.running():
            self.process.kill()
            self.wait_exit(GRANT_TIMEOUT)
        if not getattr(self.reader, "closed", False):
            self.reader.close()


class OwnerDisconnectFixture(unittest.TestCase):

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="track39-owner-")
        self.root = Path(self.temporary.name).resolve()
        self.cwd = self.root / "unrelated-cwd"
        self.config = self.root / "config"
        (self.root / "home").mkdir(mode=0o700)
        self.cwd.mkdir(mode=0o700)
        self.environment = {
            name: value for name, value in os.environ.items()
            if name not in SCRUB_ENVIRONMENT
        }
        self.environment.update(HOME=str(self.root / "home"),
                                CLAUDE_CONFIG_DIR=str(self.config),
                                TRACK_LOCK_PROTOCOL="2")
        self.session = str(uuid.uuid4())
        self.token = "owner-" + uuid.uuid4().hex
        self.helpers = []
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(self.stop_helpers)

    def stop_helpers(self):
        for helper in reversed(self.helpers):
            helper.stop()

    def spawn(self, mode, transport, half_close=False):
        command = [sys.executable, str(HELPER), mode, self.session, self.token]
        helper = Helper(command, self.environment, self.cwd, transport, half_close)
        self.helpers.append(helper)
        return helper

    def grant(self, mode, transport, half_close=False):
        helper = self.spawn(mode, transport, half_close)
        receipt = helper.read_record()
        self.assertIs(receipt.get("ok"), True, receipt)
        self.assertEqual((receipt.get("protocol"), receipt.get("mode"), receipt.get("token")),
                         (2, mode, self.token), receipt)
        return helper, receipt

    def lease_held(self):
        path = self.config / "state" / "track" / "locks" / f"{self.session}.lock"
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        finally:
            os.close(descriptor)
        return False

    def test_half_closed_socket_keeps_the_lease_until_its_reader_closes(self):
        helper, _ = self.grant("lease", "socket", half_close=True)
        time.sleep(HOLD)
        self.assertTrue(helper.running(), "a half-closed output is not a lost owner")
        self.assertTrue(self.lease_held(), "the lease must stay held while its reader is open")
        helper.close_reader()
        helper.wait_exit()
        self.assertFalse(self.lease_held(), "the lease must be free once its reader is gone")
        cpu = helper.rusage.ru_utime + helper.rusage.ru_stime
        self.assertLess(cpu, MAX_CPU_SECONDS, "ordinary writability must not count as a wake")

    def write_transaction(self):
        lease, _ = self.grant("lease", "socket", half_close=True)
        write, receipt = self.grant("write", "socket", half_close=True)
        transaction = receipt.get("transaction")
        self.assertIsInstance(transaction, dict, receipt)
        self.assertEqual(set(transaction), {"id", "nonce"})
        self.assertEqual(uuid.UUID(transaction["id"]).version, 4)
        self.assertRegex(transaction["nonce"], r"\A[0-9a-f]{64}\Z")
        return lease, write, transaction

    def transaction_record(self, transaction):
        return self.config / "state" / "track" / "locks" / "tx" / (transaction["id"] + ".json")

    def test_half_closed_socket_completes_a_write(self):
        lease, write, transaction = self.write_transaction()
        time.sleep(HOLD)
        self.assertTrue(write.running(), "a half-closed output must keep the write grant")
        request = self.transaction_record(transaction).with_name(
            transaction["id"] + "." + transaction["nonce"] + ".complete")
        request.write_text(transaction["nonce"])
        self.assertEqual(write.read_record(), {
            "ok": True, "protocol": 2, "mode": "completed", "token": self.token,
            "transaction": transaction,
        })
        write.wait_exit()
        self.assertEqual(os.waitstatus_to_exitcode(write.status), 0)
        cpu = write.rusage.ru_utime + write.rusage.ru_stime
        self.assertLess(cpu, MAX_CPU_SECONDS, "the completion wait must not spin on writability")
        lease.close_reader()
        lease.wait_exit()

    def test_reader_loss_ends_a_write_and_keeps_its_unfinished_record(self):
        lease, write, transaction = self.write_transaction()
        write.close_reader()
        write.wait_exit()
        self.assertTrue(self.transaction_record(transaction).exists(),
                        "a lost owner must leave its unfinished transaction evidence")
        self.assertTrue(lease.running(), "losing the write reader must not end the lease")
        lease.close_reader()
        lease.wait_exit()

    def test_parent_loss_with_an_open_reader_ends_the_lease(self):
        reader, child_end = socket.socketpair()
        reader.shutdown(socket.SHUT_WR)
        command = [sys.executable, str(HELPER), "lease", self.session, self.token]
        # A middle process owns the helper, reports its pid, and exits on request.
        middle = subprocess.Popen(
            [sys.executable, "-c", PARENT_SCRIPT, json.dumps(command)],
            stdin=subprocess.PIPE, stdout=child_end.fileno(), stderr=subprocess.PIPE,
            env=self.environment, cwd=self.cwd,
        )
        child_end.close()
        self.addCleanup(reader.close)
        self.addCleanup(stop_middle, middle)
        helper_pid = int(middle.stderr.readline())
        self.addCleanup(kill_quietly, helper_pid)
        holder = Helper.__new__(Helper)
        holder.reader, holder.buffer = reader, bytearray()
        receipt = holder.read_record()
        self.assertIs(receipt.get("ok"), True, receipt)
        self.assertTrue(self.lease_held())
        middle.stdin.close()  # The middle process exits; its helper loses its parent.
        middle.wait(timeout=GRANT_TIMEOUT)
        middle.stderr.close()
        deadline = time.monotonic() + EXIT_TIMEOUT
        while alive(helper_pid) and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertFalse(alive(helper_pid), "a helper whose parent exited must stop")
        self.assertFalse(self.lease_held(), "the lease must be free once its parent is gone")

    def test_regular_file_stdout_keeps_the_lease(self):
        output = self.root / "stdout.jsonl"
        with output.open("wb") as stream:
            process = subprocess.Popen(
                [sys.executable, str(HELPER), "lease", self.session, self.token],
                stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.DEVNULL,
                env=self.environment, cwd=self.cwd,
            )
        self.addCleanup(process.wait)
        self.addCleanup(kill_quietly, process.pid)
        deadline = time.monotonic() + GRANT_TIMEOUT
        while not output.read_bytes().endswith(b"\n") and time.monotonic() < deadline:
            time.sleep(0.02)
        receipt = json.loads(output.read_bytes())
        self.assertIs(receipt.get("ok"), True, receipt)
        time.sleep(HOLD)
        self.assertIsNone(process.poll(), "a regular-file output is not a lost owner")
        self.assertTrue(self.lease_held())

    def test_closed_socket_reader_ends_the_lease(self):
        helper, _ = self.grant("lease", "socket")
        self.assertTrue(self.lease_held())
        helper.close_reader()
        helper.wait_exit()
        self.assertFalse(self.lease_held())

    def test_closed_pipe_reader_ends_the_lease(self):
        helper, _ = self.grant("lease", "pipe")
        self.assertTrue(self.lease_held())
        helper.close_reader()
        helper.wait_exit()
        self.assertFalse(self.lease_held())


if __name__ == "__main__":
    unittest.main()
