#!/usr/bin/env python3
"""Test-owned fault injection around the real, isolated history helper.

No history implementation lives here. The caller owns the helper process and
both FIFOs. Patches affect this process only and use the frozen P1 call seams.
"""
import argparse
import errno
import importlib.util
import os
import stat
import sys


PAUSE_TARGETS = ("before-acquire", "after-acquire", "before-link", "before-rename")
FAIL_TARGETS = (
    "before-publish", "before-rename", "after-rename-fsync", "suppress-emit",
)


def parse_arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("history_path")
    parser.add_argument("op", choices=("bind", "read", "save", "resolve"))
    parser.add_argument("--pause-at", choices=PAUSE_TARGETS)
    parser.add_argument("--ready")
    parser.add_argument("--go")
    parser.add_argument("--fail-at", choices=FAIL_TARGETS)
    arguments = parser.parse_args()
    if bool(arguments.pause_at) != bool(arguments.ready and arguments.go):
        parser.error("--pause-at requires both --ready and --go")
    if not arguments.pause_at and (arguments.ready or arguments.go):
        parser.error("FIFO arguments require --pause-at")
    return arguments


def load_history(path):
    spec = importlib.util.spec_from_file_location("track_history", path)
    if spec is None or spec.loader is None:
        raise ImportError("history runner cannot load the requested helper")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def pause(arguments):
    with open(arguments.ready, "w", encoding="utf-8") as ready:
        ready.write(f"paused {arguments.pause_at}\n")
    with open(arguments.go, "r", encoding="utf-8") as go:
        if go.readline() != "go\n":
            raise RuntimeError("history runner did not receive its go handshake")


def patch_acquisition(module, arguments):
    if arguments.pause_at not in ("before-acquire", "after-acquire"):
        return

    def wrap_acquisition(original):
        def acquire(*args, **kwargs):
            if arguments.pause_at == "before-acquire":
                pause(arguments)
            result = original(*args, **kwargs)
            if arguments.pause_at == "after-acquire":
                pause(arguments)
            return result
        return acquire

    module.transactions.acquire_lock = wrap_acquisition(module.transactions.acquire_lock)
    module.acquire_shared = wrap_acquisition(module.acquire_shared)


def patch_publication(module, arguments):
    if arguments.pause_at != "before-link" and arguments.fail_at != "before-publish":
        return
    original_publish = module.blob_fs.publish

    def publish(*args, **kwargs):
        if arguments.fail_at == "before-publish":
            raise OSError(errno.EIO, "injected")
        return original_publish(*args, **kwargs, before_link=lambda: pause(arguments))

    module.blob_fs.publish = publish


def patch_commit(arguments):
    if (arguments.pause_at != "before-rename"
            and arguments.fail_at not in ("before-rename", "after-rename-fsync")):
        return
    original_rename = os.rename
    original_fsync = os.fsync
    renamed = False

    def rename(*args, **kwargs):
        nonlocal renamed
        if arguments.pause_at == "before-rename":
            pause(arguments)
        if arguments.fail_at == "before-rename":
            raise OSError(errno.EIO, "injected")
        result = original_rename(*args, **kwargs)
        renamed = True
        return result

    def fsync(descriptor):
        if (arguments.fail_at == "after-rename-fsync" and renamed
                and stat.S_ISDIR(os.fstat(descriptor).st_mode)):
            raise OSError(errno.EIO, "injected")
        return original_fsync(descriptor)

    os.rename = rename
    if arguments.fail_at == "after-rename-fsync":
        os.fsync = fsync


def main():
    arguments = parse_arguments()
    module = load_history(arguments.history_path)
    patch_acquisition(module, arguments)
    patch_publication(module, arguments)
    patch_commit(arguments)
    if arguments.fail_at == "suppress-emit":
        module.emit = lambda response: None
    return module.main([arguments.op])


if __name__ == "__main__":
    sys.exit(main())
