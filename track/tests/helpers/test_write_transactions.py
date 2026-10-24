"""TRACK-39 P1a isolated OS FIXTURE gates for the real helper subprocess.

These checks do not launch Claude, inspect a user store, or model SDK cancellation.
Only the missing-HOME negative uses a FIXTURE passwd fallback, to prevent the old
helper's Path.home() from reaching the real account directory before it is fixed.
"""
import calendar
import datetime
import fcntl
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import uuid


HELPER = Path(__file__).resolve().parents[2] / "hooks" / "writer-lock.py"
GRANT_TIMEOUT = 5
COMPLETION_TIMEOUT = 2
MAX_RECORD_BYTES = 4096
MAX_DIAGNOSTIC_BYTES = 16384
SCRUB_ENVIRONMENT = (
    "TRACK_LOCK_PROTOCOL", "TRACK_LOCK_DIR", "CLAUDE_CONFIG_DIR",
    "PYTHONDONTWRITEBYTECODE", "PYTHONPYCACHEPREFIX",
)
UNSUPPORTED_PROTOCOLS = (None, "", "1", "3", "02", "unsupported")

# FIXTURE only: a native process holds the historical token-only lease format.
# Its readiness record is not a helper grant. The parent owns bounded cleanup,
# and this lifetime also prevents an abandoned fixture from keeping the flock.
LEGACY_LEASE_FIXTURE = (
    "import fcntl,json,os,sys,time; "
    "descriptor=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600); "
    "fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB); "
    "os.ftruncate(descriptor,0); "
    "os.write(descriptor,json.dumps({'token':sys.argv[2]}).encode('ascii')); "
    "print(json.dumps({'fixture':'legacy-token-only-lease','pid':os.getpid()}),flush=True); "
    "time.sleep(float(sys.argv[3]))"
)

# FIXTURE safety only: run the same absolute entrypoint with a temporary passwd
# home. Without this wrapper old Path.home() would use the real account's home.
SAFE_PASSWD_WRAPPER = (
    "import pwd,runpy,sys; from types import SimpleNamespace; "
    "fixture_home=sys.argv[1]; helper=sys.argv[2]; "
    "pwd.getpwuid=lambda uid: SimpleNamespace(pw_dir=fixture_home); "
    "sys.argv=sys.argv[2:]; runpy.run_path(helper,run_name='__main__')"
)


class OwnedHelper:
    """Own one child and bounded binary protocol/diagnostic pipe buffers."""

    def __init__(self, command, environment, cwd, *, isolated_group=False):
        self.process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, bufsize=0, env=environment, cwd=cwd,
            start_new_session=isolated_group,
        )
        # start_new_session makes this child's pid its dedicated process group.
        self.process_group = self.process.pid if isolated_group else None
        self.selector = selectors.DefaultSelector()
        self.stdout_buffer = bytearray()
        self.stderr_buffer = bytearray()
        self.stdout_eof = False
        self.closed = False
        for stream, label in ((self.process.stdout, "stdout"),
                              (self.process.stderr, "stderr")):
            os.set_blocking(stream.fileno(), False)
            self.selector.register(stream, selectors.EVENT_READ, label)

    def _read_ready(self, timeout):
        for key, _ in self.selector.select(timeout):
            data = os.read(key.fileobj.fileno(), MAX_RECORD_BYTES + 1)
            if not data:
                self.selector.unregister(key.fileobj)
                if key.data == "stdout":
                    self.stdout_eof = True
                continue
            if key.data == "stderr":
                self.stderr_buffer.extend(data)
                if len(self.stderr_buffer) > MAX_DIAGNOSTIC_BYTES:
                    raise AssertionError("helper diagnostics exceeded the fixture bound")
                continue
            self.stdout_buffer.extend(data)
            for line in self.stdout_buffer.split(b"\n"):
                if len(line) >= MAX_RECORD_BYTES:
                    raise AssertionError("helper stdout record must be under 4096 bytes")
            if len(self.stdout_buffer) > MAX_DIAGNOSTIC_BYTES:
                raise AssertionError("helper stdout backlog exceeded the fixture bound")

    def read_record(self, timeout=GRANT_TIMEOUT, optional=False):
        deadline = time.monotonic() + timeout
        while True:
            newline = self.stdout_buffer.find(b"\n")
            if newline >= 0:
                line = bytes(self.stdout_buffer[:newline])
                del self.stdout_buffer[:newline + 1]
                try:
                    value = json.loads(line)
                except (UnicodeDecodeError, ValueError) as error:
                    raise AssertionError("helper emitted a non-JSON stdout record") from error
                if not isinstance(value, dict):
                    raise AssertionError("helper stdout record must be a JSON object")
                return value
            if self.stdout_eof:
                if self.stdout_buffer:
                    raise AssertionError("helper emitted an unterminated stdout record")
                if optional:
                    return None
                raise AssertionError(
                    "helper closed stdout before a receipt; stderr="
                    + repr(bytes(self.stderr_buffer))
                )
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if optional:
                    return None
                raise AssertionError("helper did not emit a receipt within the bounded wait")
            self._read_ready(remaining)

    def wait_exit(self, timeout=GRANT_TIMEOUT):
        deadline = time.monotonic() + timeout
        while self.process.poll() is None or self.selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError("owned helper did not exit within the bounded wait")
            self._read_ready(min(remaining, 0.05))
        return self.process.wait(timeout=0)

    def _signal_owned_process(self, number):
        if self.process_group is None:
            self.process.send_signal(number)
            return
        try:
            os.killpg(self.process_group, number)
        except ProcessLookupError:
            pass  # The isolated child exited; stop() still reaps it below.

    def stop(self, kill=False):
        if self.closed:
            return
        try:
            if self.process.poll() is None:
                self._signal_owned_process(signal.SIGKILL if kill else signal.SIGTERM)
                try:
                    self.process.wait(timeout=GRANT_TIMEOUT)
                except subprocess.TimeoutExpired:
                    # Only an opt-in fixture has its own recorded process group.
                    self._signal_owned_process(signal.SIGKILL)
                    self.process.wait(timeout=GRANT_TIMEOUT)
        finally:
            self.selector.close()
            self.process.stdout.close()
            self.process.stderr.close()
            self.closed = True


class TransactionFixture(unittest.TestCase):
    """Create isolated namespaces, own children, and assert shared wire records."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="track39-transactions-")
        # Resolve /var aliases before choosing the fixture's authority anchor.
        self.root = Path(self.temporary.name).resolve()
        self.home = self.root / "home"
        self.cwd = self.root / "unrelated-cwd"
        self.config = self.root / "config"
        self.home.mkdir(mode=0o700)
        self.cwd.mkdir(mode=0o700)
        self.environment = {
            name: value for name, value in os.environ.items()
            if name not in SCRUB_ENVIRONMENT
        }
        self.environment.update(HOME=str(self.home),
                                CLAUDE_CONFIG_DIR=str(self.config),
                                TRACK_LOCK_PROTOCOL="2")
        self.session = str(uuid.uuid4())
        self.token = "owner-" + uuid.uuid4().hex
        self.children = []
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(self.stop_children)

    @property
    def locks(self):
        return self.config / "state" / "track" / "locks"

    def stop_children(self):
        for child in reversed(self.children):
            child.stop()

    def spawn(self, mode=None, *, session=None, token=None, environment=None,
              helper=HELPER, arguments=None, safe_missing_home=False,
              isolated_group=False):
        child_arguments = ([mode, session or self.session, token or self.token]
                           if arguments is None else list(arguments))
        command = [sys.executable, str(helper), *child_arguments]
        if safe_missing_home:
            command = [sys.executable, "-c", SAFE_PASSWD_WRAPPER,
                       str(self.home), str(helper), *child_arguments]
        child = OwnedHelper(command, environment or self.environment, self.cwd,
                            isolated_group=isolated_group)
        self.children.append(child)
        return child

    def protocol_environment(self, protocol, **overrides):
        environment = dict(self.environment, **overrides)
        if protocol is None:
            environment.pop("TRACK_LOCK_PROTOCOL")
        else:
            environment["TRACK_LOCK_PROTOCOL"] = protocol
        return environment

    def start_legacy_lease_fixture(self, locks=None):
        """Hold a real flock in a FIXTURE process, without the legacy CLI."""
        directory = self.locks if locks is None else locks
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        leaf = directory / (self.session + ".lock")
        child = OwnedHelper(
            [sys.executable, "-c", LEGACY_LEASE_FIXTURE, str(leaf), self.token,
             str(4 * GRANT_TIMEOUT)],
            self.environment, self.cwd, isolated_group=True,
        )
        self.children.append(child)
        self.assertEqual(child.read_record(), {
            "fixture": "legacy-token-only-lease", "pid": child.process.pid,
        })
        self.assertIsNone(child.process.poll(), "legacy FIXTURE must still own its flock")
        self.assertEqual(json.loads(leaf.read_bytes()), {"token": self.token})
        with leaf.open("r+") as probe:
            with self.assertRaises(BlockingIOError,
                                   msg="legacy FIXTURE must hold an actual native flock"):
                fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return child

    def start_success(self, mode, **kwargs):
        child = self.spawn(mode, **kwargs)
        receipt = child.read_record()
        # Keep setup compatible with the current CLI. The named test below owns
        # the primary transaction assertion; setup must not index missing fields.
        self.assertIs(receipt.get("ok"), True, receipt)
        return child, receipt

    def start_transaction(self, **kwargs):
        self.start_success("lease", **kwargs)
        child, receipt = self.start_success("write", **kwargs)
        transaction = self.require_transaction(receipt)
        return child, receipt, transaction

    def require_transaction(self, receipt):
        transaction = receipt.get("transaction")
        self.assertIsInstance(
            transaction, dict,
            "protocol2 write grant must name an already durable transaction",
        )
        self.assertEqual(set(transaction), {"id", "nonce"})
        transaction_id = transaction.get("id")
        self.assertIsInstance(transaction_id, str)
        parsed = uuid.UUID(transaction_id)
        self.assertEqual(parsed.version, 4)
        self.assertEqual(str(parsed), transaction_id)
        self.assertRegex(transaction.get("nonce", ""), r"\A[0-9a-f]{64}\Z")
        return transaction

    def transaction_paths(self, transaction):
        directory = self.locks / "tx"
        transaction_id = transaction["id"]
        return (directory / (transaction_id + ".json"),
                directory / (transaction_id + "." + transaction["nonce"] + ".complete"))

    def write_request(self, transaction, content=None):
        _, request = self.transaction_paths(transaction)
        # fs.write's normal 0644 is allowed inside the private 0700 tx directory.
        # Set/check mode while empty, before valid bytes can trigger its unlink.
        with request.open("wb") as stream:
            os.fchmod(stream.fileno(), 0o644)
            self.assertEqual(stat.S_IMODE(os.fstat(stream.fileno()).st_mode), 0o644)
            stream.write(transaction["nonce"].encode("ascii")
                         if content is None else content)
        return request

    def assert_refused(self, child, expected_code=1, canary=None, timeout=GRANT_TIMEOUT):
        receipt = child.read_record(timeout)
        self.assertIs(receipt.get("ok"), False, receipt)
        self.assertIsInstance(receipt.get("reason"), str)
        self.assertTrue(receipt["reason"])
        self.assertEqual(child.wait_exit(timeout), expected_code)
        self.assertFalse(child.stdout_buffer, "failure must have only one stdout record")
        output = json.dumps(receipt).encode() + bytes(child.stderr_buffer)
        self.assertNotIn(b"Traceback", output)
        if canary is not None:
            self.assertNotIn(canary.encode(), output)
            self.assertNotIn(canary.splitlines()[0].encode(), output)
        return receipt

    def assert_nonmutating_refusal(self, child_factory, expected_code=1, canary=None):
        before = self.snapshot()
        self.assert_refused(child_factory(), expected_code, canary)
        self.assertEqual(self.snapshot(), before,
                         "rejected invocation must not create or change paths")

    def assert_pending(self, child):
        self.assertIsNone(child.read_record(COMPLETION_TIMEOUT, optional=True),
                          "invalid completion content must not emit completion")
        self.assertIsNone(child.process.poll(),
                          "partial/wrong nonce must leave the transaction pending")

    def assert_completed(self, child, grant):
        self.assertEqual(child.read_record(COMPLETION_TIMEOUT), {
            "ok": True, "protocol": 2, "mode": "completed", "token": self.token,
            "transaction": grant["transaction"],
        })
        self.assertEqual(child.wait_exit(COMPLETION_TIMEOUT), 0)
        self.assertFalse(child.stdout_buffer)
        self.assertNotIn(b"Traceback", child.stderr_buffer)

    def snapshot(self):
        """Record only the owned fixture tree; never follow a symlink."""
        entries = {}
        for directory, names, filenames in os.walk(self.root, followlinks=False):
            for name in names + filenames:
                path = Path(directory) / name
                metadata = path.lstat()
                payload = None
                if stat.S_ISREG(metadata.st_mode):
                    payload = path.read_bytes()
                elif stat.S_ISLNK(metadata.st_mode):
                    payload = os.readlink(path)
                entries[str(path.relative_to(self.root))] = (
                    metadata.st_mode, metadata.st_uid, metadata.st_nlink,
                    metadata.st_dev, metadata.st_ino, payload,
                )
        return entries


class DurableTransactionTests(TransactionFixture):
    """Assert transaction evidence, native identity, and completion lifecycle."""

    def assert_private_file(self, path, mode):
        metadata = path.lstat()
        self.assertTrue(stat.S_ISREG(metadata.st_mode), path)
        self.assertEqual(metadata.st_uid, os.getuid())
        self.assertEqual(metadata.st_nlink, 1)
        self.assertEqual(stat.S_IMODE(metadata.st_mode), mode)

    def assert_birth(self, birth):
        self.assertIsInstance(birth, dict)
        self.assertEqual(set(birth), {"sec", "usec"})
        self.assertIs(type(birth["sec"]), int)
        self.assertGreater(birth["sec"], 0)
        self.assertIs(type(birth["usec"]), int)
        self.assertGreaterEqual(birth["usec"], 0)
        self.assertLess(birth["usec"], 1000000)

    def assert_native_identity(self, owner, helper_identity, child):
        self.assertEqual(set(owner), {
            "pid", "start", "hostname", "boot_id", "unknown", "reason",
        })
        self.assertEqual(set(helper_identity), {"pid", "ppid", "start"})
        self.assertEqual(owner["pid"], os.getpid())
        self.assertEqual(owner["hostname"], socket.gethostname())
        self.assertIs(owner["unknown"], True, "a Python parent is never a supported engine")
        self.assertRegex(owner["reason"], r"\A[a-z][a-z0-9_]{0,63}\Z")
        self.assertEqual(helper_identity["pid"], child.process.pid)
        if sys.platform != "darwin":
            self.assertIsNone(owner["start"])
            self.assertIsNone(owner["boot_id"])
            self.assertIsNone(helper_identity["start"])
            self.assertIsNone(helper_identity["ppid"])
            self.assertNotEqual(owner["reason"], "parent_not_engine")
            return
        self.assert_macos_identity(owner, helper_identity)

    def assert_macos_identity(self, owner, helper_identity):
        # Independent OS oracles, not product libproc code or process arguments.
        oracle_environment = dict(self.environment, LC_ALL="C", LANG="C", TZ="UTC")
        birth = subprocess.run(
            ["/bin/ps", "-p", str(os.getpid()), "-o", "lstart="],
            capture_output=True, env=oracle_environment, cwd=self.cwd, timeout=2,
            check=True,
        ).stdout.decode("ascii").strip()
        expected_seconds = calendar.timegm(
            datetime.datetime.strptime(birth, "%a %b %d %H:%M:%S %Y").timetuple()
        )
        boot = subprocess.run(
            ["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"],
            capture_output=True, env=oracle_environment, cwd=self.cwd, timeout=2,
            check=True,
        ).stdout.decode("ascii").strip()
        self.assertLessEqual(len(boot), 128)
        # On this supported Mac these probes are required, not a version skip.
        self.assert_birth(owner["start"])
        self.assertEqual(owner["start"]["sec"], expected_seconds)
        self.assertEqual(uuid.UUID(owner["boot_id"]), uuid.UUID(boot))
        self.assertEqual(owner["reason"], "parent_not_engine")
        self.assert_birth(helper_identity["start"])
        self.assertEqual(helper_identity["ppid"], os.getpid(),
                         "helper.ppid must come from its native pbi_ppid field")

    def assert_marker(self, child, receipt):
        transaction = self.require_transaction(receipt)
        self.assertEqual(receipt, {
            "ok": True, "protocol": 2, "mode": "write", "token": self.token,
            "transaction": transaction,
        })
        marker, request = self.transaction_paths(transaction)
        self.assertTrue(marker.exists(), "the marker must exist before the write grant")
        self.assertFalse(request.exists())
        self.assert_private_file(marker, 0o600)
        for directory in (self.config, self.config / "state",
                          self.config / "state" / "track", self.locks, self.locks / "tx"):
            metadata = directory.lstat()
            self.assertTrue(stat.S_ISDIR(metadata.st_mode))
            self.assertEqual(metadata.st_uid, os.getuid())
            self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o700)
        record = json.loads(marker.read_bytes())
        self.assertEqual(set(record), {
            "v", "id", "nonce", "session_id", "module_token", "owner", "helper",
        })
        self.assertEqual(record["v"], 2)
        self.assertEqual(record["id"], transaction["id"])
        self.assertEqual(record["nonce"], transaction["nonce"])
        self.assertEqual(record["session_id"], self.session)
        self.assertEqual(record["module_token"], self.token)
        self.assert_native_identity(record["owner"], record["helper"], child)
        with (self.locks / "store.lock").open("r+") as store:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(store, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return transaction

    def test_00_v2_write_grant_has_already_durable_transaction(self):
        _, lease = self.start_success("lease")
        writer, grant = self.start_success("write")
        # Primary RED: valid old lease/write grants reach this assertion directly.
        self.require_transaction(grant)
        self.assertEqual(lease, {
            "ok": True, "protocol": 2, "mode": "lease", "token": self.token,
        })
        self.assertEqual(json.loads((self.locks / (self.session + ".lock")).read_bytes()),
                         {"protocol": 2, "token": self.token})
        self.assert_marker(writer, grant)

    def test_exact_nonce_completes_and_preserves_unrelated_file(self):
        writer, grant, transaction = self.start_transaction()
        marker, request = self.transaction_paths(transaction)
        sentinel = marker.parent / "unrelated-sentinel"
        sentinel.write_bytes(b"keep this unrelated evidence")
        self.write_request(transaction)
        self.assert_completed(writer, grant)
        self.assertFalse(marker.exists())
        self.assertFalse(request.exists())
        self.assertEqual(sentinel.read_bytes(), b"keep this unrelated evidence")

    def test_partial_wrong_newline_and_oversized_nonce_stay_pending(self):
        self.start_success("lease")
        for kind in ("empty", "partial", "wrong", "newline", "oversized"):
            with self.subTest(kind=kind):
                writer, grant = self.start_success("write")
                transaction = self.require_transaction(grant)
                marker, _ = self.transaction_paths(transaction)
                original = marker.read_bytes()
                nonce = transaction["nonce"].encode("ascii")
                contents = {
                    "empty": b"", "partial": nonce[:31],
                    "wrong": (b"1" if nonce[:1] == b"0" else b"0") + nonce[1:],
                    "newline": nonce + b"\n", "oversized": nonce + b"x" * 64,
                }
                request = self.write_request(transaction, contents[kind])
                self.assert_pending(writer)
                self.assertEqual(marker.read_bytes(), original)
                self.assertEqual(request.read_bytes(), contents[kind])
                writer.stop()

    def test_changed_marker_bytes_refuse_completion_and_remain(self):
        writer, _, transaction = self.start_transaction()
        marker, _ = self.transaction_paths(transaction)
        changed = marker.read_bytes() + b" "
        marker.write_bytes(changed)
        request = self.write_request(transaction)
        self.assert_refused(writer)
        self.assertEqual(marker.read_bytes(), changed)
        self.assertEqual(request.read_bytes(), transaction["nonce"].encode("ascii"))

    def test_replaced_marker_inode_refuses_even_with_identical_bytes(self):
        writer, _, transaction = self.start_transaction()
        marker, _ = self.transaction_paths(transaction)
        original = marker.read_bytes()
        replacement = marker.parent / "replacement-owned-marker"
        replacement.write_bytes(original)
        replacement.chmod(0o600)
        original_inode = marker.stat().st_ino
        replacement.replace(marker)
        self.assertNotEqual(marker.stat().st_ino, original_inode)
        request = self.write_request(transaction)
        self.assert_refused(writer)
        self.assertEqual(marker.read_bytes(), original)
        self.assertTrue(request.exists())

    def test_killed_helper_retains_evidence_and_new_same_session_ignores_it(self):
        writer, _, old_transaction = self.start_transaction()
        old_marker, old_request = self.transaction_paths(old_transaction)
        marker_bytes = old_marker.read_bytes()
        self.write_request(old_transaction, b"partial")
        writer.stop(kill=True)
        self.assertEqual(old_marker.read_bytes(), marker_bytes)
        self.assertEqual(old_request.read_bytes(), b"partial")
        # Write the full stale nonce only after death, avoiding a completion race.
        self.write_request(old_transaction)
        new_writer, new_grant = self.start_success("write")
        new_transaction = self.require_transaction(new_grant)
        self.assertNotEqual(new_transaction["id"], old_transaction["id"])
        self.assertNotEqual(new_transaction["nonce"], old_transaction["nonce"])
        self.assert_pending(new_writer)
        self.write_request(new_transaction)
        self.assert_completed(new_writer, new_grant)
        new_marker, new_request = self.transaction_paths(new_transaction)
        self.assertFalse(new_marker.exists())
        self.assertFalse(new_request.exists())
        self.assertEqual(old_marker.read_bytes(), marker_bytes)
        self.assertEqual(old_request.read_bytes(), old_transaction["nonce"].encode("ascii"))

    def test_safe_path_import_from_copied_hooks_has_same_contract_and_no_cache(self):
        hooks = self.root / "isolated-hooks"
        hooks.mkdir(mode=0o700)
        copied_helper = hooks / HELPER.name
        shutil.copyfile(HELPER, copied_helper)
        library = HELPER.with_name("write_transactions.py")
        if library.is_file():
            # Copy the real unmodified library when present; never invent a stub.
            shutil.copyfile(library, hooks / library.name)
        environment = dict(self.environment, PYTHONSAFEPATH="1")
        self.start_success("lease", helper=copied_helper, environment=environment)
        writer, grant = self.start_success("write", helper=copied_helper,
                                           environment=environment)
        transaction = self.assert_marker(writer, grant)
        self.write_request(transaction)
        self.assert_completed(writer, grant)
        self.assertFalse((hooks / "__pycache__").exists())
        self.assertFalse(list(hooks.rglob("*.pyc")))


class NamespaceTests(TransactionFixture):
    """Assert config/descendant authority and completion-leaf safety."""

    def test_track_lock_dir_presence_is_rejected_without_path_effects(self):
        for override in ("", str(self.locks), str(self.root / "override")):
            with self.subTest(override=override):
                environment = dict(self.environment, TRACK_LOCK_DIR=override)
                self.assert_nonmutating_refusal(
                    lambda: self.spawn("lease", environment=environment))

    def test_relative_nonempty_config_never_falls_back_to_home(self):
        environment = dict(self.environment, CLAUDE_CONFIG_DIR="relative-config")
        self.assert_nonmutating_refusal(
            lambda: self.spawn("lease", environment=environment))

    def test_empty_and_unset_config_use_absolute_home(self):
        for config_kind in ("empty", "unset"):
            with self.subTest(config_kind=config_kind):
                home = self.root / ("home-" + config_kind)
                home.mkdir(mode=0o700)
                environment = dict(self.environment, HOME=str(home))
                if config_kind == "empty":
                    environment["CLAUDE_CONFIG_DIR"] = ""
                else:
                    environment.pop("CLAUDE_CONFIG_DIR")
                child, receipt = self.start_success("lease", environment=environment,
                                                    session=str(uuid.uuid4()))
                self.assertEqual(receipt, {
                    "ok": True, "protocol": 2, "mode": "lease", "token": self.token,
                })
                self.assertTrue((home / ".claude" / "state" / "track" / "locks").is_dir())
                self.assertFalse(self.config.exists())
                child.stop()

    def test_missing_home_refuses_with_isolated_passwd_fallback_fixture(self):
        environment = dict(self.environment)
        environment.pop("CLAUDE_CONFIG_DIR")
        environment.pop("HOME")
        self.assert_nonmutating_refusal(
            lambda: self.spawn("lease", environment=environment, safe_missing_home=True))

    def test_relative_home_refuses_without_path_effects(self):
        environment = dict(self.environment, HOME="relative-home", CLAUDE_CONFIG_DIR="")
        self.assert_nonmutating_refusal(
            lambda: self.spawn("lease", environment=environment))

    def test_fresh_state_track_created_and_existing_state_permissions_preserved(self):
        self.config.mkdir(mode=0o700)
        state = self.config / "state"
        state.mkdir(mode=0o755)
        state.chmod(0o755)
        self.assertFalse((state / "track").exists())
        _, _, transaction = self.start_transaction()
        self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((state / "track").stat().st_mode), 0o700)
        self.assertTrue(self.transaction_paths(transaction)[0].is_file())

    def test_symlink_config_anchor_is_resolved_and_allowed(self):
        actual = self.root / "actual-config"
        actual.mkdir(mode=0o700)
        self.config.symlink_to(actual, target_is_directory=True)
        _, _, transaction = self.start_transaction()
        marker, _ = self.transaction_paths(transaction)
        self.assertTrue(marker.is_file())
        self.assertEqual(marker.resolve().parent, actual / "state" / "track" / "locks" / "tx")
        self.assertFalse((self.home / ".claude").exists())

    def test_symlink_config_request_completes_in_the_realpath_namespace(self):
        # P1b1 coverage: a client writes its request under the same symlinked config
        # string it passed to the helper; the helper consumes it under the realpath.
        actual = self.root / "actual-config"
        actual.mkdir(mode=0o700)
        self.config.symlink_to(actual, target_is_directory=True)
        writer, grant, transaction = self.start_transaction()
        marker, request = self.transaction_paths(transaction)
        resolved = actual / "state" / "track" / "locks" / "tx"
        self.assertTrue((resolved / marker.name).is_file())
        self.write_request(transaction)
        self.assert_completed(writer, grant)
        self.assertFalse((resolved / marker.name).exists())
        self.assertFalse((resolved / request.name).exists())
        self.assertTrue(self.config.is_symlink())
        self.assertFalse((self.home / ".claude").exists())

    def test_symlink_descendants_cannot_redirect_namespace_writes(self):
        for component in ("state", "track", "locks", "tx"):
            with self.subTest(component=component):
                config = self.root / ("config-" + component)
                config.mkdir(mode=0o700)
                components = ("state", "track", "locks", "tx")
                parent = config
                for part in components[:components.index(component)]:
                    parent = parent / part
                    parent.mkdir(mode=0o700)
                destination = self.root / ("destination-" + component)
                destination.mkdir(mode=0o700)
                (destination / "sentinel").write_bytes(b"do not change")
                (parent / component).symlink_to(destination, target_is_directory=True)
                environment = dict(self.environment, CLAUDE_CONFIG_DIR=str(config))
                self.assert_nonmutating_refusal(
                    lambda: self.spawn("lease", environment=environment))

    def test_existing_locks_and_tx_must_already_be_private(self):
        for component in ("locks", "tx"):
            with self.subTest(component=component):
                config = self.root / ("public-" + component)
                locks = config / "state" / "track" / "locks"
                locks.mkdir(mode=0o700, parents=True)
                (locks / "tx").mkdir(mode=0o700)
                public_directory = locks if component == "locks" else locks / "tx"
                public_directory.chmod(0o755)
                environment = dict(self.environment, CLAUDE_CONFIG_DIR=str(config))
                self.assert_nonmutating_refusal(
                    lambda: self.spawn("lease", environment=environment))
                self.assertEqual(stat.S_IMODE(public_directory.stat().st_mode), 0o755)

    def test_session_lock_symlink_multilink_and_nonregular_are_refused(self):
        for kind in ("symlink", "hardlink", "directory", "fifo"):
            with self.subTest(kind=kind):
                config = self.root / ("leaf-" + kind)
                locks = config / "state" / "track" / "locks"
                locks.mkdir(mode=0o700, parents=True)
                (locks / "tx").mkdir(mode=0o700)
                leaf = locks / (self.session + ".lock")
                target = self.root / ("lock-target-" + kind)
                if kind in ("symlink", "hardlink"):
                    target.write_bytes(b"do not modify lock target")
                    if kind == "symlink":
                        leaf.symlink_to(target)
                    else:
                        os.link(target, leaf)
                elif kind == "directory":
                    leaf.mkdir(mode=0o700)
                else:
                    os.mkfifo(leaf, 0o600)
                environment = dict(self.environment, CLAUDE_CONFIG_DIR=str(config))
                self.assert_nonmutating_refusal(
                    lambda: self.spawn("lease", environment=environment))

    def test_nonregular_completion_requests_cannot_retire_or_redirect(self):
        self.start_success("lease")
        for kind in ("symlink", "directory", "fifo", "hardlink"):
            with self.subTest(kind=kind):
                writer, grant = self.start_success("write")
                transaction = self.require_transaction(grant)
                marker, request = self.transaction_paths(transaction)
                marker_bytes = marker.read_bytes()
                target = self.root / ("request-target-" + kind)
                if kind in ("symlink", "hardlink"):
                    target.write_bytes(transaction["nonce"].encode("ascii"))
                    if kind == "symlink":
                        request.symlink_to(target)
                    else:
                        os.link(target, request)
                elif kind == "directory":
                    request.mkdir(mode=0o700)
                else:
                    os.mkfifo(request, 0o600)
                self.assert_refused(writer, timeout=COMPLETION_TIMEOUT)
                self.assertEqual(marker.read_bytes(), marker_bytes)
                self.assertTrue(request.exists())
                if target.exists():
                    self.assertEqual(target.read_bytes(), transaction["nonce"].encode("ascii"))
                writer.stop()


class LeaseProtocolTests(TransactionFixture):
    """Assert live lease ownership, token rechecks, and retained guards."""

    def test_write_requires_matching_live_v2_lease(self):
        self.assert_refused(self.spawn("write"))
        self.start_success("lease")
        self.assert_refused(self.spawn("write", token="wrong-owner"))
        self.assertFalse(list((self.locks / "tx").glob("*.json")))

    def test_legacy_lease_does_not_authorize_protocol2_write(self):
        legacy = self.start_legacy_lease_fixture()
        leaf = self.locks / (self.session + ".lock")
        before = leaf.read_bytes()
        receipt = self.assert_refused(self.spawn("write"))
        self.assertEqual(receipt, {
            "ok": False, "reason": "session writer protocol is not supported",
        })
        self.assertIsNone(legacy.process.poll(), "refusal must exercise a live legacy lease")
        self.assertEqual(leaf.read_bytes(), before)
        self.assertFalse(list((self.locks / "tx").glob("*.json")))

    def test_queued_writer_rechecks_lease_after_token_changes(self):
        lease, _ = self.start_success("lease")
        with (self.locks / "store.lock").open("a+") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            writer = self.spawn("write")
            self.assertIsNone(writer.read_record(0.25, optional=True))
            self.assertIsNone(writer.process.poll())
            lease.stop()
            self.start_success("lease", token="replacement-owner")
            fcntl.flock(held, fcntl.LOCK_UN)
        self.assert_refused(writer)
        self.assertFalse(list((self.locks / "tx").glob("*.json")))
        new_writer, receipt = self.start_success("write", token="replacement-owner")
        self.require_transaction(receipt)
        new_writer.stop()

    def test_guard_retains_closed_lock_and_reports_live_lease_exactly(self):
        guard, receipt = self.start_success("guard")
        self.assertEqual(receipt, {
            "ok": True, "protocol": 2, "mode": "guard", "token": self.token,
            "state": "closed",
        })
        with (self.locks / (self.session + ".lock")).open("r+") as lock:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        guard.stop()
        self.start_success("lease")
        before = (self.locks / (self.session + ".lock")).read_bytes()
        _, live = self.start_success("guard")
        self.assertEqual(live, {
            "ok": True, "protocol": 2, "mode": "guard", "token": self.token,
            "state": "live",
        })
        self.assertEqual((self.locks / (self.session + ".lock")).read_bytes(), before)


class StrictProtocolTests(TransactionFixture):
    """Refuse unsupported protocols before touching either lock namespace."""

    def assert_strict_protocol_refused(self, mode, environment):
        before = self.snapshot()
        child = self.spawn(mode, environment=environment, isolated_group=True)
        try:
            receipt = child.read_record()
            self.assertIs(
                receipt.get("ok"), False,
                "unsupported protocol must refuse before namespace effects; "
                + repr(receipt),
            )
            self.assertEqual(receipt, {
                "ok": False, "reason": "unsupported lock protocol",
            })
            self.assertEqual(child.wait_exit(), 1)
            self.assertFalse(child.stdout_buffer,
                             "refusal must emit exactly one record and no successful receipt")
            self.assertFalse(child.stderr_buffer, "protocol refusal must not emit diagnostics")
            self.assertEqual(self.snapshot(), before,
                             "unsupported protocol must not create, replace or change paths")
        finally:
            # Old lease/write helpers ignore stdin EOF. Never wait for their
            # natural exit or signal any process outside this fixture group.
            child.stop()

    def test_unset_protocol_lease_is_refused_before_namespace_effects(self):
        self.assertFalse(self.config.exists(), "primary RED needs a fresh namespace")
        self.assertFalse((self.home / ".claude").exists())
        self.assert_strict_protocol_refused("lease", self.protocol_environment(None))

    def test_unset_protocol_write_and_guard_are_refused_before_namespace_effects(self):
        # A matching token-only native lease makes the old write a valid grant.
        self.start_legacy_lease_fixture()
        environment = self.protocol_environment(None)
        for mode in ("write", "guard"):
            with self.subTest(mode=mode):
                self.assert_strict_protocol_refused(mode, environment)

    def test_empty_and_unsupported_protocols_are_refused_for_all_modes(self):
        self.start_legacy_lease_fixture()
        for protocol in UNSUPPORTED_PROTOCOLS[1:]:
            for mode in ("lease", "write", "guard"):
                with self.subTest(protocol=protocol, mode=mode):
                    self.assert_strict_protocol_refused(
                        mode, self.protocol_environment(protocol))

    def test_unsupported_protocols_ignore_override_before_namespace_effects(self):
        canary = self.root / "override-canary"
        canary.mkdir(mode=0o700)
        sentinel = canary / "sentinel"
        sentinel.write_bytes(b"preserve override canary bytes, mode and inode")
        sentinel.chmod(0o644)
        for protocol_index, protocol in enumerate(UNSUPPORTED_PROTOCOLS):
            for override_kind in ("empty", "missing", "canary"):
                for mode in ("lease", "write", "guard"):
                    with self.subTest(protocol=protocol, override=override_kind, mode=mode):
                        name = f"{protocol_index}-{override_kind}-{mode}"
                        missing = self.root / ("override-" + name)
                        override = {"empty": "", "missing": str(missing),
                                    "canary": str(canary)}[override_kind]
                        environment = self.protocol_environment(
                            protocol, CLAUDE_CONFIG_DIR=str(self.root / ("config-" + name)),
                            TRACK_LOCK_DIR=override,
                        )
                        legacy = None
                        try:
                            if mode == "write":
                                directory = self.cwd if override == "" else Path(override)
                                legacy = self.start_legacy_lease_fixture(directory)
                            self.assert_strict_protocol_refused(mode, environment)
                        finally:
                            if legacy is not None:
                                legacy.stop()


class ProtocolCliTests(TransactionFixture):
    """Assert help and usage validation precede lock protocol routing."""

    def test_help_is_successful_short_and_nonmutating(self):
        for protocol in (*UNSUPPORTED_PROTOCOLS, "2"):
            for argument in ("--help", "-h"):
                with self.subTest(protocol=protocol, argument=argument):
                    environment = self.protocol_environment(
                        protocol, TRACK_LOCK_DIR=str(self.root / "unused-override"))
                    before = self.snapshot()
                    child = self.spawn(arguments=[argument], environment=environment)
                    self.assertEqual(child.wait_exit(), 0)
                    output = bytes(child.stdout_buffer)
                    self.assertGreater(len(output), 0)
                    self.assertLess(len(output), MAX_RECORD_BYTES)
                    self.assertIn(b"lease", output)
                    self.assertIn(b"write", output)
                    self.assertIn(b"guard", output)
                    self.assertNotIn(b"Traceback", output + child.stderr_buffer)
                    self.assertEqual(self.snapshot(), before)

    def test_noargs_unknown_mode_and_malformed_canary_have_usage_exit(self):
        canary = "PRIVATE-CANARY-" + uuid.uuid4().hex + "\nnot-a-record"
        arguments = ([], ["badmode", self.session, self.token],
                     ["lease", canary, self.token], ["lease", self.session, canary])
        for protocol in (*UNSUPPORTED_PROTOCOLS, "2"):
            for invocation in arguments:
                with self.subTest(protocol=protocol, argument_count=len(invocation)):
                    environment = self.protocol_environment(
                        protocol, TRACK_LOCK_DIR=str(self.root / "unused-override"))
                    self.assert_nonmutating_refusal(
                        lambda: self.spawn(arguments=invocation, environment=environment),
                        expected_code=2, canary=canary)

    def test_unsupported_and_empty_protocol_are_nonmutating_failures(self):
        for protocol in ("", "1", "3", "02", "unsupported"):
            with self.subTest(protocol=protocol):
                environment = dict(self.environment, TRACK_LOCK_PROTOCOL=protocol)
                self.assert_nonmutating_refusal(
                    lambda: self.spawn("lease", environment=environment))


if __name__ == "__main__":
    unittest.main()
