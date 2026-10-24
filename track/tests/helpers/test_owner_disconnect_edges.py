"""TRACK-39 P1b1 FIXTURE edge gates, added after the freeze5b cycle: the
helper's output monitor fails closed on every error it can see, and the real
protocol-2 write and guard helpers keep their locks while a half-closed output
stays open.

Monitor errors are injected with unittest.mock or produced by the kernel on an
owned descriptor; the transport cases run the real helper. Production Bun
1.4.4 is unverified. These checks launch no Claude and read no user store.
"""
from contextlib import ExitStack, redirect_stdout
import errno
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import select
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

import test_owner_disconnect as base


LIBRARY = Path(__file__).resolve().parents[2] / "hooks" / "write_transactions.py"
# Shorter than one 500 ms retention wait: a refused owner must not reach one.
REFUSAL_LIMIT = 0.3
# No kernel filter has this number, so registration fails with EINVAL.
UNSUPPORTED_FILTER = -99
# One failure each, after which every probe reaches the real kernel again.
ONE_SHOT_FAILURES = ("POLLERR", "POLLNVAL", "control-oserror", "ev-error")
# Clean probes that must not restore a lost owner.
LATER_CHECKS = 3


def load_library():
    spec = importlib.util.spec_from_file_location("track39_edges_write_transactions", LIBRARY)
    module = importlib.util.module_from_spec(spec)
    previous, sys.dont_write_bytecode = sys.dont_write_bytecode, True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


def flock_denied(path):
    """Whether another open file description holds an exclusive flock on path."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return True
    finally:
        os.close(descriptor)
    return False


class StdoutAt:
    """A stand-in sys.stdout that reports an owned descriptor."""

    def __init__(self, descriptor):
        self.descriptor = descriptor

    def fileno(self):
        return self.descriptor


def fail_once(watcher, descriptor, kind):
    """Make the watcher's next probe of `kind` fail once; later probes reach the real kernel."""
    pending = [kind]
    if kind in ("POLLERR", "POLLNVAL"):
        errors = watcher.errors
        watcher.errors = mock.Mock()
        watcher.errors.poll.side_effect = lambda timeout: (
            [(descriptor, getattr(select, pending.pop()))] if pending else errors.poll(timeout))
        return
    queue = watcher.queue

    def control(changes, max_events, timeout=None):
        if not pending:
            return queue.control(changes, max_events, timeout)
        if pending.pop() == "control-oserror":
            raise OSError(errno.EINTR, "fixture one-shot kqueue failure")
        return [select.kevent(descriptor, select.KQ_FILTER_WRITE, select.KQ_EV_ERROR, 0, errno.EIO)]

    watcher.queue = mock.Mock()
    watcher.queue.control.side_effect = control
    watcher.queue.close.side_effect = queue.close


def run_bounded(target, *args):
    """Run target in a daemon thread for at most base.EXIT_TIMEOUT; (finished, raised error)."""
    outcome = []

    def body():
        try:
            target(*args)
        except BaseException as error:  # The caller asserts on the raised error.
            outcome.append(error)
        else:
            outcome.append(None)

    worker = threading.Thread(target=body, daemon=True)
    worker.start()
    worker.join(base.EXIT_TIMEOUT)
    return (not worker.is_alive()), (outcome[0] if outcome else None)


def success_receipts(text):
    return [record for record in (json.loads(line) for line in text.splitlines() if line.strip())
            if record.get("ok") is True]


class MonitorFailsClosed(unittest.TestCase):
    """Each error the monitor can see refuses the owner: no new lock, and a
    held one is released before its first retention wait."""

    @classmethod
    def setUpClass(cls):
        cls.library = load_library()

    def setUp(self):
        # Bun's shape: the parent end is shut for writing, so the helper's end
        # reports POLLHUP although it can still write.
        self.reader, self.output = socket.socketpair()
        self.reader.shutdown(socket.SHUT_WR)
        self.addCleanup(self.reader.close)
        self.addCleanup(self.output.close)
        temporary = tempfile.TemporaryDirectory(prefix="track39-edges-")
        self.addCleanup(temporary.cleanup)
        self.lock_path = Path(temporary.name) / "fixture.lock"
        self.lock = os.open(self.lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        self.addCleanup(os.close, self.lock)
        self.parent = os.getppid()

    def watch(self, descriptor=None):
        watcher = self.library.OutputWatcher(self.output.fileno() if descriptor is None else descriptor)
        # A test may replace the queue; the allocated one is still closed.
        self.addCleanup(watcher.queue.close)
        return watcher

    def assert_refused(self, watcher):
        self.assertFalse(self.library.owner_connected(self.parent, watcher),
                         "a monitor error must not count as a connected owner")
        with self.assertRaises(self.library.TransactionError) as refusal:
            self.library.acquire_lock(self.lock, "fixture lock is busy", self.parent, watcher)
        self.assertEqual(str(refusal.exception), "lock owner is no longer connected")
        self.assertFalse(flock_denied(self.lock_path), "a refused owner must not take the lock")
        retention = threading.Thread(target=self.library.retain_lock,
                                     args=(self.parent, watcher), daemon=True)
        started = time.monotonic()
        retention.start()
        retention.join(REFUSAL_LIMIT)
        self.assertFalse(retention.is_alive(), "a refused owner must release a held lock at once")
        self.assertLess(time.monotonic() - started, REFUSAL_LIMIT)

    def returned_events(self, watcher, events):
        watcher.errors = mock.Mock()
        watcher.errors.poll.return_value = [(self.output.fileno(), events)]

    def test_ordinary_write_ready_output_stays_connected(self):
        watcher = self.watch()
        self.assertTrue(self.library.owner_connected(self.parent, watcher),
                        "a half-closed but writable output is a connected owner")
        self.library.acquire_lock(self.lock, "fixture lock is busy", self.parent, watcher)
        self.assertTrue(flock_denied(self.lock_path), "a connected owner takes the lock")
        fcntl.flock(self.lock, fcntl.LOCK_UN)
        self.assertEqual(watcher.poll(0), [])

    def test_returned_pollerr_refuses_the_owner(self):
        watcher = self.watch()
        self.returned_events(watcher, select.POLLERR)
        self.assert_refused(watcher)

    def test_returned_pollnval_refuses_the_owner(self):
        watcher = self.watch()
        self.returned_events(watcher, select.POLLNVAL)
        self.assert_refused(watcher)

    def test_kqueue_control_oserror_refuses_the_owner(self):
        watcher = self.watch()
        watcher.queue = mock.Mock()
        watcher.queue.control.side_effect = OSError(errno.EBADF, "fixture kqueue failure")
        self.assert_refused(watcher)

    def test_returned_ev_error_refuses_the_owner(self):
        watcher = self.watch()
        watcher.queue = mock.Mock()
        watcher.queue.control.return_value = [select.kevent(
            self.output.fileno(), select.KQ_FILTER_WRITE, select.KQ_EV_ERROR, 0, errno.EIO)]
        self.assert_refused(watcher)

    def test_unsupported_filter_registration_refuses_the_owner(self):
        # The kernel itself answers EV_ERROR with EINVAL for this registration.
        watcher = self.watch()
        with mock.patch.object(select, "KQ_FILTER_WRITE", UNSUPPORTED_FILTER):
            self.assert_refused(watcher)

    def test_closed_descriptor_registration_refuses_the_owner(self):
        # The kernel answers EV_ERROR with EBADF. Stub the poll side so only
        # the kqueue registration can refuse.
        descriptor = os.dup(self.output.fileno())
        watcher = self.watch(descriptor)
        os.close(descriptor)
        watcher.errors = mock.Mock()
        watcher.errors.poll.return_value = []
        self.assert_refused(watcher)

    def test_ordinary_output_stays_connected_across_repeated_checks(self):
        watcher = self.watch()
        for _ in range(LATER_CHECKS):
            self.assertTrue(self.library.owner_connected(self.parent, watcher),
                            "a writable output stays a connected owner")
            self.assertEqual(watcher.poll(0), [])
            self.assertEqual(watcher.poll(20), [])

    def assert_stays_lost(self, watcher):
        for _ in range(LATER_CHECKS):
            self.assertFalse(self.library.owner_connected(self.parent, watcher),
                             "a later clean probe must not restore a lost owner")
            self.assertNotEqual(watcher.poll(0), [], "a lost owner must stay lost in every wait")
            self.assertNotEqual(watcher.poll(20), [], "a lost owner must stay lost in every wait")
        self.assert_refused(watcher)

    def test_one_shot_failure_seen_by_an_owner_check_stays_lost(self):
        for kind in ONE_SHOT_FAILURES:
            with self.subTest(failure=kind):
                watcher = self.watch()
                fail_once(watcher, self.output.fileno(), kind)
                self.assertFalse(self.library.owner_connected(self.parent, watcher),
                                 "the failure itself must count as a lost owner")
                self.assert_stays_lost(watcher)

    def test_one_shot_failure_seen_inside_one_wait_stays_lost(self):
        for kind in ONE_SHOT_FAILURES:
            with self.subTest(failure=kind):
                watcher = self.watch()
                fail_once(watcher, self.output.fileno(), kind)
                self.assertNotEqual(watcher.poll(20), [],
                                    "a wait must keep the failure its first probe saw")
                self.assert_stays_lost(watcher)

    def test_guard_with_a_broken_monitor_takes_no_lock_and_grants_nothing(self):
        for kind in ("POLLERR", "control-oserror"):
            with self.subTest(failure=kind):
                watcher = self.watch()
                if kind == "POLLERR":
                    self.returned_events(watcher, select.POLLERR)
                else:
                    watcher.queue = mock.Mock()
                    watcher.queue.control.side_effect = OSError(errno.EBADF, "fixture kqueue failure")
                path = self.lock_path.with_name(f"guard-{kind}.lock")
                descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
                self.addCleanup(os.close, descriptor)
                output = io.StringIO()
                with redirect_stdout(output):
                    finished, error = run_bounded(self.library.run_guard, descriptor,
                                                  "guard-token", self.parent, watcher)
                self.assertTrue(finished, "a guard with a broken monitor must not wait")
                self.assertEqual(success_receipts(output.getvalue()), [],
                                 "a broken monitor must not grant a guard")
                self.assertFalse(flock_denied(path),
                                 "a broken monitor must not take the guard's lock")
                self.assertIsInstance(error, self.library.TransactionError)
                self.assertEqual(str(error), "lock owner is no longer connected")

    def output_transports(self):
        read_end, write_end = os.pipe()
        self.addCleanup(os.close, read_end)
        self.addCleanup(os.close, write_end)
        return (("socket", self.output.fileno()), ("fifo", write_end))

    def test_output_monitor_closes_its_queue_on_normal_exit(self):
        for transport, descriptor in self.output_transports():
            with self.subTest(transport=transport), mock.patch.object(sys, "stdout", StdoutAt(descriptor)):
                with self.library.output_disconnects() as watcher:
                    self.assertIsInstance(watcher, self.library.OutputWatcher)
                    queue = watcher.queue
                    self.assertFalse(queue.closed)
                self.assertTrue(queue.closed, "a finished monitor must close its kqueue")

    def test_output_monitor_closes_its_queue_on_exceptional_exit(self):
        for transport, descriptor in self.output_transports():
            with self.subTest(transport=transport), mock.patch.object(sys, "stdout", StdoutAt(descriptor)):
                with self.assertRaises(RuntimeError):
                    with self.library.output_disconnects() as watcher:
                        queue = watcher.queue
                        raise RuntimeError("fixture failure inside the monitor")
                self.assertTrue(queue.closed, "a failing caller must still close the kqueue")


class HalfClosedTransport(unittest.TestCase):
    """The real helper over Bun's half-closed socket: a write grant and a
    CLOSED guard each hold their lock until the reader closes. The test
    process stays the helper's parent throughout."""

    # Composed from the original fixture without inheriting its seven tests.
    setUp = base.OwnerDisconnectFixture.setUp
    stop_helpers = base.OwnerDisconnectFixture.stop_helpers
    spawn = base.OwnerDisconnectFixture.spawn
    grant = base.OwnerDisconnectFixture.grant
    lease_held = base.OwnerDisconnectFixture.lease_held

    def locks(self):
        return self.config / "state" / "track" / "locks"

    def test_half_closed_write_holds_the_store_lock_until_its_reader_closes(self):
        lease, _ = self.grant("lease", "socket", half_close=True)
        write, receipt = self.grant("write", "socket", half_close=True)
        transaction = receipt.get("transaction")
        self.assertIsInstance(transaction, dict, receipt)
        time.sleep(base.HOLD)
        self.assertTrue(write.running(), "a half-closed output must keep the write grant")
        self.assertTrue(flock_denied(self.locks() / "store.lock"),
                        "a live write grant must hold the store lock")
        write.close_reader()
        write.wait_exit()
        self.assertFalse(flock_denied(self.locks() / "store.lock"),
                         "the store lock must be free once the write reader is gone")
        self.assertTrue((self.locks() / "tx" / (transaction["id"] + ".json")).exists(),
                        "a lost owner must leave its unfinished transaction evidence")
        self.assertTrue(lease.running(), "losing the write reader must not end the lease")
        self.assertTrue(self.lease_held())
        lease.close_reader()
        lease.wait_exit()

    def test_half_closed_closed_guard_holds_the_target_lock_until_its_reader_closes(self):
        guard, receipt = self.grant("guard", "socket", half_close=True)
        self.assertEqual(receipt, {"ok": True, "protocol": 2, "mode": "guard",
                                   "token": self.token, "state": "closed"})
        time.sleep(base.HOLD)
        self.assertTrue(guard.running(), "a half-closed output must keep the guard")
        self.assertTrue(self.lease_held(), "a CLOSED guard must hold the target session lock")
        guard.close_reader()
        guard.wait_exit()
        self.assertFalse(self.lease_held(), "the target lock must be free once the guard reader is gone")


class CompletionStaysLost(unittest.TestCase):
    """One monitor failure inside complete_if_requested ends the write for
    good: later clean probes must not let run_write retire its record. The
    production run_write runs in-process on a real namespace and lease; only
    the monitor's next probe is made to fail."""

    setUp_fixture = base.OwnerDisconnectFixture.setUp
    stop_helpers = base.OwnerDisconnectFixture.stop_helpers
    spawn = base.OwnerDisconnectFixture.spawn
    grant = base.OwnerDisconnectFixture.grant

    @classmethod
    def setUpClass(cls):
        cls.library = load_library()

    def setUp(self):
        self.setUp_fixture()
        self.reader, self.output = socket.socketpair()
        self.reader.shutdown(socket.SHUT_WR)
        self.addCleanup(self.reader.close)
        self.addCleanup(self.output.close)

    def wait_for_write_grant(self, output):
        deadline = time.monotonic() + base.GRANT_TIMEOUT
        while time.monotonic() < deadline:
            text = output.getvalue()
            # Only complete lines: the writer may be mid-record.
            for record in success_receipts(text[:text.rfind("\n") + 1]):
                if record.get("mode") == "write":
                    return record["transaction"]
            time.sleep(0.02)
        raise AssertionError("run_write did not grant within the bounded wait")

    def test_monitor_failure_inside_completion_keeps_the_record(self):
        lease, _ = self.grant("lease", "socket", half_close=True)
        library = self.library
        watcher = library.OutputWatcher(self.output.fileno())
        self.addCleanup(watcher.queue.close)
        verify_marker = library.verify_marker
        armed = []

        def verify_then_fail_once(*args):
            verify_marker(*args)
            if not armed:
                # The next probe is complete_if_requested's own owner check.
                armed.append(True)
                fail_once(watcher, self.output.fileno(), "POLLERR")

        output = io.StringIO()
        name = self.session + ".lock"
        with ExitStack() as stack:
            stack.enter_context(mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(self.config)}))
            os.environ.pop("TRACK_LOCK_DIR", None)
            locks, transactions = stack.enter_context(library.open_namespace(self.session))
            session_file = stack.enter_context(library.open_leaf(locks, name, writable=True, create=True))
            stack.enter_context(mock.patch.object(library, "verify_marker", verify_then_fail_once))
            stack.enter_context(redirect_stdout(output))
            writer = threading.Thread(target=library.run_write, daemon=True, args=(
                locks, transactions, name, session_file, self.session, self.token, os.getppid(), watcher))
            writer.start()
            transaction = self.wait_for_write_grant(output)
            tx = self.config / "state" / "track" / "locks" / "tx"
            record = tx / (transaction["id"] + ".json")
            request = tx / (transaction["id"] + "." + transaction["nonce"] + ".complete")
            request.write_text(transaction["nonce"])
            writer.join(base.EXIT_TIMEOUT)
            finished = not writer.is_alive()
        self.assertTrue(armed, "the completion path must reach its owner check")
        self.assertTrue(finished, "a write whose owner was lost must end")
        self.assertEqual([receipt["mode"] for receipt in success_receipts(output.getvalue())], ["write"],
                         "a write whose owner was lost must never report completed")
        self.assertTrue(record.exists(), "a lost owner must leave its unfinished record")
        self.assertTrue(request.exists(), "a lost owner must leave its unconsumed request")
        lease.close_reader()
        lease.wait_exit()


if __name__ == "__main__":
    unittest.main()
