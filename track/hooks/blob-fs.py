#!/usr/bin/env python3
"""TRACK-35 blob publication: one content-addressed ledger blob per checksum.

`publish <dir> <checksum>` reads the blob text on stdin and stores it as
`<dir>/<checksum>.json`, mode 0600 in a 0700 directory. Publication is a hard
link from a private temp file, so it is atomic and never replaces an existing
file: a matching blob is accepted, anything else is refused and left untouched.
Accepting an existing blob sets its atime and mtime to now, so a reused blob
counts as young again for the sweep.

`sweep <dir> [--min-age-seconds N] [--max N]` is the only command that deletes
a blob (TRACK-42). The keep-set arrives on stdin as {"keep": [<64 hex>, ...]}.
It removes `<checksum>.json` regular files owned by this user that are not in
the keep-set and are at least N seconds old (default 604800, seven days), at
most --max per run (default 200). An empty or malformed keep-set is refused
with nothing deleted. The caller MUST hold Track's store write lock for the
whole run: the keep-set is a snapshot, and a concurrent writer could otherwise
start referencing a blob after it was read.

Track's saves and compaction publish while holding the store write lock, and the
sweep caller must hold the same lock, so the two never overlap. The directory
flock is a second guard against any publisher that does not hold the store lock,
and the age gate protects a blob such a publisher has not yet referenced.
`publish` holds LOCK_SH from just after opening the directory until after its
final directory fsync (waiting up to 5 s, then "blob directory is busy"), and
`sweep` holds LOCK_EX for its whole scan, re-check and unlink phase (waiting up
to 2 s, then the same error, deleting nothing).
"""
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import sys
import time

CHECKSUM = re.compile(r"[0-9a-f]{64}")
BLOB_NAME = re.compile(r"[0-9a-f]{64}\.json")
DEFAULT_MIN_AGE_SECONDS = 7 * 24 * 60 * 60
DEFAULT_MAX_REMOVALS = 200
SWEEP_USAGE = "usage: blob-fs.py sweep <dir> [--min-age-seconds N] [--max N]"
LOCK_RETRY_SECONDS = 0.01
PUBLISH_LOCK_WAIT_SECONDS = 5
SWEEP_LOCK_WAIT_SECONDS = 2
BUSY_MESSAGE = "blob directory is busy"


class PublishError(Exception):
    pass


class SweepError(PublishError):
    pass


def lock_directory(dir_fd, mode, wait_seconds, error_class):
    """flock `dir_fd` in `mode`, retrying every 10 ms for `wait_seconds`; `error_class` when it stays held."""
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            fcntl.flock(dir_fd, mode | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise error_class(BUSY_MESSAGE)
            time.sleep(LOCK_RETRY_SECONDS)


def open_dir(directory):
    try:
        info = os.lstat(directory)
    except FileNotFoundError:
        os.makedirs(directory, mode=0o700, exist_ok=True)
        info = os.lstat(directory)
    if stat.S_ISLNK(info.st_mode):
        raise PublishError(f"blob directory is a symlink: {directory}")
    if not stat.S_ISDIR(info.st_mode):
        raise PublishError(f"blob directory is not a directory: {directory}")
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if not stat.S_ISDIR(os.fstat(fd).st_mode):
            raise PublishError(f"blob directory changed while opening: {directory}")
        os.fchmod(fd, 0o700)
    except BaseException:
        os.close(fd)
        raise
    return fd


def read_all(fd):
    chunks = []
    while True:
        chunk = os.read(fd, 1 << 20)
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)


def accept_existing(dir_fd, name, data):
    """True when `name` already holds exactly `data`; False when it is absent."""
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    except FileNotFoundError:
        return False
    except OSError as error:
        raise PublishError(f"existing blob {name} is not a regular file; it was kept: {error}")
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
            raise PublishError(f"existing blob {name} is not a regular file owned by this user; it was kept")
        if read_all(fd) != data:
            raise PublishError(f"existing blob {name} differs from the published text; it was kept")
        if stat.S_IMODE(info.st_mode) != 0o600:
            os.fchmod(fd, 0o600)
        os.utime(fd)
    finally:
        os.close(fd)
    return True


def publish(directory, checksum, text, before_link=None):
    if not isinstance(directory, str) or not os.path.isabs(directory):
        raise PublishError("blob directory must be an absolute path")
    if not isinstance(checksum, str) or not CHECKSUM.fullmatch(checksum):
        raise PublishError("checksum must be 64 lowercase hex characters")
    data = text.encode("utf-8")
    if hashlib.sha256(data).hexdigest() != checksum:
        raise PublishError("text does not match its checksum")
    receipt = {"ok": True, "checksum": checksum, "bytes": len(data)}
    previous = os.umask(0o077)
    try:
        dir_fd = open_dir(directory)
        try:
            # Held until the directory is closed, which is after the final fsync below.
            lock_directory(dir_fd, fcntl.LOCK_SH, PUBLISH_LOCK_WAIT_SECONDS, PublishError)
            name = f"{checksum}.json"
            if accept_existing(dir_fd, name, data):
                return receipt
            temp = f".{checksum}.{os.getpid()}.{secrets.token_hex(8)}.tmp"
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dir_fd)
            try:
                try:
                    view = memoryview(data)
                    while view:
                        view = view[os.write(fd, view):]
                    os.fsync(fd)
                finally:
                    os.close(fd)
                if before_link is not None:
                    before_link()
                try:
                    os.link(temp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
                except FileExistsError:
                    if not accept_existing(dir_fd, name, data):
                        raise PublishError(f"blob {name} vanished during publication")
            finally:
                try:
                    os.unlink(temp, dir_fd=dir_fd)
                except FileNotFoundError:
                    pass
            os.fsync(dir_fd)
            return receipt
        finally:
            os.close(dir_fd)
    finally:
        os.umask(previous)


def parse_keep_set(raw):
    try:
        document = json.loads(raw)
    except (ValueError, RecursionError) as error:
        raise SweepError(f"keep-set is not valid JSON: {error}") from error
    keep = document.get("keep") if isinstance(document, dict) else None
    if not isinstance(keep, list):
        raise SweepError("keep-set must be an object with a list under 'keep'")
    if not keep:
        raise SweepError("keep-set is empty; refusing to sweep without a readable store")
    for entry in keep:
        if not isinstance(entry, str) or not CHECKSUM.fullmatch(entry):
            raise SweepError("keep-set entries must be 64 lowercase hex characters")
    return set(keep)


def open_existing_dir(directory):
    """Open `directory` for sweeping; None when it does not exist. Never creates it."""
    if not os.path.isabs(directory):
        raise SweepError("blob directory must be an absolute path")
    try:
        info = os.lstat(directory)
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(info.st_mode):
        raise SweepError(f"blob directory is a symlink: {directory}")
    if not stat.S_ISDIR(info.st_mode):
        raise SweepError(f"blob directory is not a directory: {directory}")
    try:
        return os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as error:
        raise SweepError(f"cannot open blob directory {directory}: {error}") from error


def blob_age_state(dir_fd, name, now, min_age):
    """'eligible', 'young' (too new or future-dated), or None when `name` is not an owned regular blob file."""
    try:
        info = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
        return None
    if info.st_mtime > now or now - info.st_mtime < min_age:
        return "young"
    return "eligible"


def blob_identity(dir_fd, name):
    """(st_dev, st_ino) of `name`, not following symlinks; None when it is gone."""
    try:
        info = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    return (info.st_dev, info.st_ino)


def scan_blobs(dir_fd, keep, now, min_age, receipt):
    """Count the referenced and young blobs into `receipt`; return [(name, identity)] of the eligible ones."""
    eligible = []
    for name in sorted(os.listdir(dir_fd)):
        if not BLOB_NAME.fullmatch(name):
            continue
        # The identity is read before the age, so a replacement in between is caught by the re-check.
        identity = blob_identity(dir_fd, name)
        state = blob_age_state(dir_fd, name, now, min_age)
        if identity is None or state is None:
            continue
        if name[:-len(".json")] in keep:
            receipt["kept_referenced"] += 1
        elif state == "young":
            receipt["kept_young"] += 1
        else:
            eligible.append((name, identity))
    return eligible


def remove_blobs(dir_fd, eligible, min_age, receipt):
    """Re-check each scanned blob and unlink it; the directory is fsynced when anything was removed."""
    try:
        for name, scanned_identity in eligible:
            try:
                state = blob_age_state(dir_fd, name, time.time(), min_age)
                identity = blob_identity(dir_fd, name)
            except OSError as error:
                receipt["failed"] += 1
                print(f"blob-fs: could not re-check {name}: {error}", file=sys.stderr)
                continue
            if state is None or identity != scanned_identity:
                # Gone, no longer an owned regular file, or a different file under the same name.
                receipt["vanished"] += 1
                continue
            if state == "young":
                receipt["kept_young"] += 1
                continue
            try:
                os.unlink(name, dir_fd=dir_fd)
            except FileNotFoundError:
                # Someone else removed it between the re-check and the unlink: nothing left to delete.
                receipt["vanished"] += 1
                continue
            except OSError as error:
                receipt["failed"] += 1
                print(f"blob-fs: could not remove {name}: {error}", file=sys.stderr)
                continue
            receipt["removed"].append(name)
    finally:
        if receipt["removed"]:
            os.fsync(dir_fd)


def sweep(directory, keep, min_age=DEFAULT_MIN_AGE_SECONDS, max_removals=DEFAULT_MAX_REMOVALS):
    receipt = {"ok": True, "removed": [], "kept_referenced": 0, "kept_young": 0,
               "vanished": 0, "failed": 0, "more": False}
    dir_fd = open_existing_dir(directory)
    if dir_fd is None:
        return receipt
    try:
        lock_directory(dir_fd, fcntl.LOCK_EX, SWEEP_LOCK_WAIT_SECONDS, SweepError)
        eligible = scan_blobs(dir_fd, keep, time.time(), min_age, receipt)
        receipt["more"] = len(eligible) > max_removals
        remove_blobs(dir_fd, eligible[:max_removals], min_age, receipt)
    finally:
        os.close(dir_fd)
    return receipt


def parse_sweep_args(args):
    """(directory, min_age, max_removals) from the argv after 'sweep'; ValueError on bad usage."""
    if not args:
        raise ValueError("missing <dir>")
    directory, rest = args[0], args[1:]
    options = {"--min-age-seconds": DEFAULT_MIN_AGE_SECONDS, "--max": DEFAULT_MAX_REMOVALS}
    while rest:
        if rest[0] not in options or len(rest) < 2 or not re.fullmatch(r"[0-9]+", rest[1]):
            raise ValueError(f"bad option: {rest[0]}")
        options[rest[0]] = int(rest[1])
        rest = rest[2:]
    return directory, options["--min-age-seconds"], options["--max"]


def main_sweep(args):
    try:
        directory, min_age, max_removals = parse_sweep_args(args)
    except ValueError:
        print(SWEEP_USAGE, file=sys.stderr)
        return 2
    try:
        keep = parse_keep_set(sys.stdin.buffer.read())
        receipt = sweep(directory, keep, min_age, max_removals)
    except (PublishError, OSError) as error:
        print(f"blob-fs: {error}", file=sys.stderr)
        return 1
    print(json.dumps(receipt), flush=True)
    return 0


def main(argv):
    if len(argv) > 1 and argv[1] == "sweep":
        return main_sweep(argv[2:])
    if len(argv) != 4 or argv[1] != "publish":
        print("usage: blob-fs.py publish <dir> <checksum>", file=sys.stderr)
        return 2
    try:
        text = sys.stdin.buffer.read().decode("utf-8")
        receipt = publish(argv[2], argv[3], text)
    except (PublishError, OSError, UnicodeDecodeError) as error:
        print(f"blob-fs: {error}", file=sys.stderr)
        return 1
    print(json.dumps(receipt), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
