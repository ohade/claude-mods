#!/usr/bin/env python3
"""FIXTURE-only F1-F3 injection around the real history helper.

Tier C, agent-only test protocol. All writes stay in the explicitly supplied
owned fixture tree. Stdout remains the helper's JSON protocol; receipts go to
an exclusive fixture trace or owned FIFO. No product implementation lives here.
"""
import argparse
import errno
import importlib.util
import json
import os
from pathlib import Path
import select
import stat
import sys


def parse_arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("history_path")
    parser.add_argument("op", choices=("read", "save"))
    parser.add_argument("--fixture-root", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--object")
    parser.add_argument("--trace", required=True)
    parser.add_argument("--pause-at", choices=("before-object-publish", "before-link"))
    parser.add_argument("--ready")
    parser.add_argument("--go")
    parser.add_argument("--remove-root-on-revalidate", action="store_true")
    parser.add_argument("--fail-objects-dir-fsync", action="store_true")
    arguments = parser.parse_args()
    if bool(arguments.pause_at) != bool(arguments.ready and arguments.go):
        parser.error("--pause-at requires both --ready and --go")
    if not arguments.pause_at and (arguments.ready or arguments.go):
        parser.error("FIFO arguments require --pause-at")
    if arguments.op == "save" and not arguments.object:
        parser.error("save injection requires --object")
    return arguments


def validate_fixture_paths(arguments):
    anchor = Path(arguments.fixture_root).resolve(strict=True)
    info = anchor.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        raise RuntimeError("F123 runner requires an owned fixture directory")
    for name in ("root", "object", "trace", "ready", "go"):
        value = getattr(arguments, name)
        if value is not None:
            path = Path(value)
            if not path.is_absolute() or not path.resolve().is_relative_to(anchor):
                raise RuntimeError("F123 runner path escapes the fixture directory: " + name)


def load_history(path):
    specification = importlib.util.spec_from_file_location("track_f123_history", path)
    if specification is None or specification.loader is None:
        raise ImportError("F123 runner cannot load the requested history helper")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


def append_event(trace, event, **fields):
    trace.write(json.dumps({"event": event, **fields}, separators=(",", ":")) + "\n")
    trace.flush()


def pause(arguments, trace, object_path):
    descriptors = []
    try:
        for path in (arguments.ready, arguments.go):
            info = os.lstat(path)
            if not stat.S_ISFIFO(info.st_mode) or info.st_uid != os.geteuid():
                raise RuntimeError("F123 pause requires owned fixture FIFOs")
            descriptors.append(os.open(path, os.O_RDWR | os.O_NONBLOCK | os.O_NOFOLLOW))
        ready, go = descriptors
        receipt = {"event": "paused", "at": arguments.pause_at, "object_path": object_path}
        append_event(trace, **receipt)
        message = (json.dumps(receipt, separators=(",", ":")) + "\n").encode()
        if os.write(ready, message) != len(message):
            raise RuntimeError("F123 pause receipt was incomplete")
        readable, _, _ = select.select([go], [], [], 10)
        if not readable or os.read(go, 4096) != b"go\n":
            raise RuntimeError("F123 pause did not receive its bounded go handshake")
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def patch_publication(module, arguments, trace):
    if arguments.pause_at is None:
        return
    original_publish = module.blob_fs.publish
    original_link = os.link

    def publish(directory, checksum, text, **kwargs):
        object_path = os.path.join(directory, checksum + ".json")
        if object_path != arguments.object:
            raise RuntimeError("F1 pause did not reach the specified fixture object")
        if arguments.pause_at == "before-object-publish":
            pause(arguments, trace, object_path)
        else:
            kwargs["before_link"] = lambda: pause(arguments, trace, object_path)
        return original_publish(directory, checksum, text, **kwargs)

    def link(source, destination, *args, **kwargs):
        try:
            return original_link(source, destination, *args, **kwargs)
        except FileExistsError:
            if destination == Path(arguments.object).name:
                append_event(trace, "collision-file-exists", object_path=arguments.object)
            raise

    module.blob_fs.publish = publish
    os.link = link


def patch_root_disappearance(module, arguments, trace):
    if not arguments.remove_root_on_revalidate:
        return
    original_revalidate = module.transactions.revalidate_leaf
    root = Path(arguments.root)
    roots_identity = root.parent.stat()
    injected = False

    def revalidate(directory, name, descriptor, expected=None):
        nonlocal injected
        if (not injected and name == root.name
                and module.transactions.same_file(os.fstat(directory), roots_identity)):
            opened = os.fstat(descriptor)
            current = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if not stat.S_ISREG(opened.st_mode) or not module.transactions.same_file(opened, current):
                raise RuntimeError("F2 injection requires the initial successful root open")
            root.unlink()
            injected = True
            append_event(trace, "root-removed-after-open", root_path=str(root),
                         opened_inode=opened.st_ino, observed_inode=current.st_ino)
        return original_revalidate(directory, name, descriptor, expected)

    module.transactions.revalidate_leaf = revalidate


def patch_barriers(module, arguments, trace):
    if arguments.object is None:
        return
    object_path = Path(arguments.object)
    objects_identity = object_path.parent.stat()
    roots_identity = Path(arguments.root).parent.stat()
    original_fsync = os.fsync
    original_rename = os.rename

    def fsync(descriptor):
        info = os.fstat(descriptor)
        is_objects_directory = module.transactions.same_file(info, objects_identity)
        if is_objects_directory:
            append_event(trace, "objects-dir-fsync-attempt", object_path=str(object_path))
            if arguments.fail_objects_dir_fsync:
                append_event(trace, "objects-dir-fsync-failed", object_path=str(object_path))
                raise OSError(errno.EIO, "F3 injected objects directory fsync failure")
        result = original_fsync(descriptor)
        if is_objects_directory:
            append_event(trace, "objects-dir-fsync", object_path=str(object_path))
        elif stat.S_ISREG(info.st_mode) and object_path.exists():
            if module.transactions.same_file(info, object_path.stat()):
                append_event(trace, "object-file-fsync", object_path=str(object_path))
        return result

    def rename(source, destination, *args, **kwargs):
        directory = kwargs.get("dst_dir_fd")
        if (destination == Path(arguments.root).name and directory is not None
                and module.transactions.same_file(os.fstat(directory), roots_identity)):
            append_event(trace, "root-rename", root_path=arguments.root)
        return original_rename(source, destination, *args, **kwargs)

    os.fsync = fsync
    os.rename = rename


def main():
    arguments = parse_arguments()
    validate_fixture_paths(arguments)
    module = load_history(arguments.history_path)
    with open(arguments.trace, "x", encoding="utf-8") as trace:
        append_event(trace, "process-start", pid=os.getpid())
        patch_publication(module, arguments, trace)
        patch_root_disappearance(module, arguments, trace)
        patch_barriers(module, arguments, trace)
        return module.main([arguments.op])


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except (OSError, RuntimeError, ImportError) as error:
        print("F123 runner: " + str(error), file=sys.stderr)
        sys.exit(1)
