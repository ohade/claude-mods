#!/usr/bin/env python3
"""TRACK-35 blob publication: one content-addressed ledger blob per checksum.

`publish <dir> <checksum>` reads the blob text on stdin and stores it as
`<dir>/<checksum>.json`, mode 0600 in a 0700 directory. Publication is a hard
link from a private temp file, so it is atomic and never replaces an existing
file: a matching blob is accepted, anything else is refused and left untouched.
Nothing here deletes a blob.
"""
import hashlib
import json
import os
import re
import secrets
import stat
import sys

CHECKSUM = re.compile(r"[0-9a-f]{64}")


class PublishError(Exception):
    pass


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


def main(argv):
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
