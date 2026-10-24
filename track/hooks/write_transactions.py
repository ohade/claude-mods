"""Protocol 2 lock and durable transaction implementation for writer-lock.py.

This library touches only lock metadata. A grant follows file and directory
fsync; only the same helper can consume its exact completion request. Closing
descriptors releases locks but deliberately leaves unfinished evidence intact.
"""
from contextlib import contextmanager, ExitStack
import ctypes
import fcntl
import json
import os
import secrets
import select
import socket
import stat
import struct
import sys
import time
import uuid


class TransactionError(RuntimeError):
    """A controlled refusal, safe to send over the helper protocol."""


class IdentityError(RuntimeError):
    """A normalized reason why native process identity is unavailable."""


def emit(mode, token, **fields):
    print(json.dumps({"ok": True, "protocol": 2, "mode": mode,
                      "token": token, **fields}, separators=(",", ":")), flush=True)


def same_file(first, second):
    return (first.st_dev, first.st_ino) == (second.st_dev, second.st_ino)


def validate_directory(metadata, private=False):
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.geteuid():
        raise TransactionError("lock namespace is not an owned directory")
    if private and stat.S_IMODE(metadata.st_mode) != 0o700:
        raise TransactionError("lock namespace is not private")


def validate_leaf(metadata):
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid()
            or metadata.st_nlink != 1):
        raise TransactionError("lock metadata is not an owned single-link regular file")


@contextmanager
def open_directory(name, *, parent=None, private=False, create=False):
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            # Existing paths are validated, never chmodded into acceptance.
            pass
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    validate_directory(before, private)
    descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                         dir_fd=parent)
    try:
        after = os.fstat(descriptor)
        validate_directory(after, private)
        if not same_file(before, after):
            raise TransactionError("lock directory changed while opening")
        yield descriptor
    finally:
        os.close(descriptor)


def revalidate_leaf(directory, name, descriptor, expected=None):
    current = os.stat(name, dir_fd=directory, follow_symlinks=False)
    opened = os.fstat(descriptor)
    validate_leaf(current)
    validate_leaf(opened)
    if not same_file(current, opened) or (expected is not None
                                          and not same_file(current, expected)):
        raise TransactionError("lock metadata changed while opening")
    return opened


@contextmanager
def open_leaf(directory, name, *, writable=False, create=False, exclusive=False):
    try:
        before = os.stat(name, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        before = None
        if not create:
            raise
    if before is not None:
        validate_leaf(before)
    flags = (os.O_RDWR if writable else os.O_RDONLY) | os.O_NOFOLLOW | os.O_NONBLOCK
    if create:
        flags |= os.O_CREAT
    if exclusive:
        flags |= os.O_EXCL
    descriptor = os.open(name, flags, 0o600, dir_fd=directory)
    try:
        revalidate_leaf(directory, name, descriptor, before)
        yield descriptor
    finally:
        os.close(descriptor)


def selected_config():
    if "TRACK_LOCK_DIR" in os.environ:
        raise TransactionError("protocol 2 does not accept TRACK_LOCK_DIR")
    selected = os.environ.get("CLAUDE_CONFIG_DIR")
    if not selected:
        home = os.environ.get("HOME")
        if not home or not os.path.isabs(home):
            raise TransactionError("HOME must be present and absolute")
        selected = os.path.join(home, ".claude")
    if not os.path.isabs(selected):
        raise TransactionError("config directory must be absolute")
    return os.path.realpath(selected)


def preflight_namespace(anchor, session):
    """Refuse existing unsafe descendants before creating any missing ones."""
    with ExitStack() as handles:
        parent = anchor
        for component in ("state", "track", "locks", "tx"):
            try:
                parent = handles.enter_context(open_directory(
                    component, parent=parent, private=component in ("locks", "tx")))
            except FileNotFoundError:
                return
            if component == "locks":
                for leaf in (session + ".lock", "store.lock"):
                    try:
                        with open_leaf(parent, leaf):
                            pass  # Opening validates the existing leaf without changing it.
                    except FileNotFoundError:
                        continue


@contextmanager
def open_namespace(session):
    anchor_path = selected_config()
    os.makedirs(anchor_path, mode=0o700, exist_ok=True)
    with ExitStack() as handles:
        parent = handles.enter_context(open_directory(anchor_path))
        preflight_namespace(parent, session)
        directories = {}
        for component in ("state", "track", "locks", "tx"):
            parent = handles.enter_context(open_directory(
                component, parent=parent, private=component in ("locks", "tx"),
                create=True))
            directories[component] = parent
        yield directories["locks"], directories["tx"]


class OutputWatcher:
    """Reports a stdout reader that went away, in the poll(ms) shape callers use.

    macOS sets POLLHUP on a socket whose peer only stopped writing, which Bun's
    spawn does from the start, so kqueue says whether the write side reached
    end-of-file instead. POLLERR and POLLNVAL still count; POLLHUP alone does
    not. Ordinary writability is not an event, every wait lasts its full
    timeout, and a watcher that cannot answer fails closed. The first lost
    owner it observes is final: a later clean probe never restores it.
    """

    def __init__(self, descriptor):
        self.descriptor = descriptor
        self.errors = select.poll()
        self.errors.register(descriptor, select.POLLERR | select.POLLNVAL)
        self.queue = select.kqueue()
        self.lost = False

    def disconnected(self):
        if not self.lost:
            self.lost = self.probe()
        return self.lost

    def probe(self):
        if any(events & (select.POLLERR | select.POLLNVAL) for _, events in self.errors.poll(0)):
            return True
        change = select.kevent(self.descriptor, select.KQ_FILTER_WRITE,
                               select.KQ_EV_ADD | select.KQ_EV_ONESHOT)
        try:
            events = self.queue.control([change], 1, 0)
        except OSError:
            return True
        return any(event.flags & (select.KQ_EV_EOF | select.KQ_EV_ERROR) for event in events)

    def poll(self, timeout):
        if not self.disconnected() and timeout:
            time.sleep(timeout / 1000)
        return [(self.descriptor, select.POLLHUP)] if self.disconnected() else []

    def close(self):
        self.queue.close()


@contextmanager
def output_disconnects():
    descriptor = sys.stdout.fileno()
    mode = os.fstat(descriptor).st_mode
    if hasattr(select, "kqueue") and (stat.S_ISSOCK(mode) or stat.S_ISFIFO(mode)):
        watcher = OutputWatcher(descriptor)
        try:
            yield watcher
        finally:
            watcher.close()
        return
    # Without kqueue, POLLHUP means both directions closed (a half-close is
    # POLLRDHUP). A regular-file stdout never reports a disconnect.
    disconnected = select.poll()
    disconnected.register(descriptor, select.POLLERR | select.POLLHUP | select.POLLNVAL)
    yield disconnected


def owner_connected(parent, disconnected):
    return os.getppid() == parent and not disconnected.poll(0)


def retain_lock(parent, disconnected):
    while owner_connected(parent, disconnected):
        if disconnected.poll(500):
            break


def acquire_lock(descriptor, busy_reason, parent, disconnected):
    deadline = time.monotonic() + 3
    while True:
        if not owner_connected(parent, disconnected):
            raise TransactionError("lock owner is no longer connected")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise TransactionError(busy_reason)
            time.sleep(0.01)


def lease_failure(descriptor, token):
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        try:
            data = os.pread(descriptor, 4097, 0)
            owner = json.loads(data) if len(data) <= 4096 else None
        except (ValueError, UnicodeDecodeError, OSError):
            return "session writer identity is unknown"
        if not isinstance(owner, dict):
            return "session writer identity is unknown"
        if owner.get("token") != token:
            return "session writer identity does not match"
        if (type(owner.get("protocol")) is not int or owner["protocol"] != 2
                or set(owner) != {"protocol", "token"}):
            return "session writer protocol is not supported"
        return None
    else:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        return "session writer lease is not alive"


def require_lease(directory, name, descriptor, token):
    revalidate_leaf(directory, name, descriptor)
    failure = lease_failure(descriptor, token)
    if failure is not None:
        raise TransactionError(failure)


def write_all(descriptor, data):
    remaining = memoryview(data)
    while remaining:
        written = os.write(descriptor, remaining)
        if written <= 0:
            raise TransactionError("lock metadata write did not complete")
        remaining = remaining[written:]


def run_lease(directory, name, descriptor, token, parent, disconnected):
    acquire_lock(descriptor, "another loaded Track instance owns this session",
                 parent, disconnected)
    revalidate_leaf(directory, name, descriptor)
    os.ftruncate(descriptor, 0)
    os.lseek(descriptor, 0, os.SEEK_SET)
    write_all(descriptor, json.dumps({"protocol": 2, "token": token},
                                     separators=(",", ":")).encode("ascii"))
    emit("lease", token)
    retain_lock(parent, disconnected)


def run_guard(descriptor, token, parent, disconnected):
    # A guard its owner cannot keep must not be granted, even for a moment.
    if not owner_connected(parent, disconnected):
        raise TransactionError("lock owner is no longer connected")
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = "closed"
    except BlockingIOError:
        state = "live"
    emit("guard", token, state=state)
    retain_lock(parent, disconnected)


def bind_process_probe():
    library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    probe = library.proc_pidinfo
    probe.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                      ctypes.c_void_p, ctypes.c_int]
    probe.restype = ctypes.c_int
    return probe


def probe_process(probe, pid):
    # PROC_PIDTBSDINFO and these offsets are the checked macOS 136-byte layout.
    buffer = ctypes.create_string_buffer(136)
    if probe(pid, 3, 0, buffer, len(buffer)) != 136:
        raise IdentityError("process_probe_failed")
    parent_pid = struct.unpack_from("=I", buffer.raw, 16)[0]
    seconds, microseconds = struct.unpack_from("=QQ", buffer.raw, 120)
    birth = {"sec": seconds, "usec": microseconds}
    reason = None
    if seconds <= 0 or microseconds >= 1000000:
        birth = None
        reason = "process_layout_invalid"
    try:
        command = buffer.raw[48:64].split(b"\0", 1)[0].decode("utf-8")
    except UnicodeDecodeError:
        # Birth and ppid remain useful even when the command cannot be decoded.
        command = None
        reason = reason or "process_name_invalid"
    return {"ppid": parent_pid, "start": birth, "command": command, "reason": reason}


def probe_boot_id():
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    query = library.sysctlbyname
    query.argtypes = [ctypes.c_char_p, ctypes.c_void_p,
                      ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
    query.restype = ctypes.c_int
    buffer = ctypes.create_string_buffer(128)
    length = ctypes.c_size_t(len(buffer))
    if (query(b"kern.bootsessionuuid", buffer, ctypes.byref(length), None, 0) != 0
            or not 1 <= length.value <= len(buffer)):
        raise IdentityError("boot_probe_failed")
    try:
        return str(uuid.UUID(buffer.raw[:length.value].rstrip(b"\0").decode("ascii")))
    except (UnicodeDecodeError, ValueError) as error:
        raise IdentityError("boot_identity_invalid") from error


def capture_identity():
    parent = os.getppid()
    owner = {"pid": parent, "start": None, "hostname": None, "boot_id": None,
             "unknown": True, "reason": "unsupported_platform"}
    helper = {"pid": os.getpid(), "ppid": None, "start": None}
    reasons = []
    try:
        owner["hostname"] = socket.gethostname()
    except OSError:
        reasons.append("hostname_unavailable")
    if sys.platform != "darwin":
        return owner, helper
    parent_command = None
    try:
        probe = bind_process_probe()
    except (OSError, AttributeError):
        reasons.append("process_library_unavailable")
    else:
        for pid, record in ((parent, owner), (helper["pid"], helper)):
            try:
                identity = probe_process(probe, pid)
            except IdentityError as error:
                reasons.append(str(error))
                continue
            if identity["reason"] is not None:
                reasons.append(identity["reason"])
            record["start"] = identity["start"]
            if record is helper:
                helper["ppid"] = identity["ppid"]
            else:
                parent_command = identity["command"]
    try:
        owner["boot_id"] = probe_boot_id()
    except IdentityError as error:
        reasons.append(str(error))
    except (OSError, AttributeError):
        reasons.append("boot_library_unavailable")
    if os.getppid() != parent or (helper["ppid"] is not None and helper["ppid"] != parent):
        reasons.insert(0, "parent_changed")
    if not reasons and parent_command != "claude.exe":
        reasons.append("parent_not_engine")
    owner["unknown"] = bool(reasons)
    owner["reason"] = reasons[0] if reasons else "engine_verified"
    return owner, helper


def create_transaction(directory, session, token, owner, helper):
    transaction = {"id": str(uuid.uuid4()), "nonce": secrets.token_hex(32)}
    record = {"v": 2, **transaction, "session_id": session, "module_token": token,
              "owner": owner, "helper": helper}
    data = json.dumps(record, separators=(",", ":")).encode("utf-8")
    name = transaction["id"] + ".json"
    with open_leaf(directory, name, writable=True, create=True, exclusive=True) as descriptor:
        write_all(descriptor, data)
        os.fsync(descriptor)
        original = revalidate_leaf(directory, name, descriptor)
        os.fsync(directory)
    return transaction, data, original


def verify_marker(directory, name, data, original):
    with open_leaf(directory, name) as descriptor:
        revalidate_leaf(directory, name, descriptor, original)
        if os.pread(descriptor, len(data) + 1, 0) != data:
            raise TransactionError("transaction marker changed; evidence retained")
        revalidate_leaf(directory, name, descriptor, original)


def complete_if_requested(directory, transaction, data, original, parent, disconnected):
    marker = transaction["id"] + ".json"
    request = transaction["id"] + "." + transaction["nonce"] + ".complete"
    nonce = transaction["nonce"].encode("ascii")
    with ExitStack() as handles:
        try:
            descriptor = handles.enter_context(open_leaf(directory, request))
        except FileNotFoundError:
            # Only an absent request is pending; missing evidence after this
            # point is a failure, including a lost request during removal.
            return False
        if os.pread(descriptor, 65, 0) != nonce:
            return False
        verify_marker(directory, marker, data, original)
        revalidate_leaf(directory, request, descriptor)
        if os.pread(descriptor, 65, 0) != nonce:
            return False
        if not owner_connected(parent, disconnected):
            return False
        # Removal is ordered and durable, not atomic across two filenames.
        # A crash after the first fsync can leave only the unique request.
        os.unlink(marker, dir_fd=directory)
        os.fsync(directory)
        os.unlink(request, dir_fd=directory)
        os.fsync(directory)
    return True


def run_write(locks, transactions, session_name, session_file, session, token,
              parent, disconnected):
    require_lease(locks, session_name, session_file, token)
    # Native probes cannot extend the store mutex's hold time.
    owner, helper = capture_identity()
    if owner["pid"] != parent:
        owner["unknown"] = True
        owner["reason"] = "parent_changed"
    with open_leaf(locks, "store.lock", writable=True, create=True) as store:
        acquire_lock(store, "store writer is busy", parent, disconnected)
        revalidate_leaf(locks, "store.lock", store)
        require_lease(locks, session_name, session_file, token)
        transaction, data, original = create_transaction(
            transactions, session, token, owner, helper)
        emit("write", token, transaction=transaction)
        while owner_connected(parent, disconnected):
            if complete_if_requested(transactions, transaction, data, original,
                                     parent, disconnected):
                emit("completed", token, transaction=transaction)
                return
            if disconnected.poll(20):
                return


def main(mode, session, token):
    previous_mask = os.umask(0o077)
    try:
        parent = os.getppid()
        with output_disconnects() as disconnected, open_namespace(session) as (locks, transactions):
            name = session + ".lock"
            with open_leaf(locks, name, writable=True, create=True) as session_file:
                if mode == "lease":
                    run_lease(locks, name, session_file, token, parent, disconnected)
                elif mode == "guard":
                    run_guard(session_file, token, parent, disconnected)
                else:
                    run_write(locks, transactions, name, session_file, session, token,
                              parent, disconnected)
        return 0
    except TransactionError as error:
        print(json.dumps({"ok": False, "reason": str(error)},
                         separators=(",", ":")), flush=True)
        return 1
    finally:
        os.umask(previous_mask)
