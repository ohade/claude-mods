#!/usr/bin/env python3
"""FIXTURE-only pause at the unchanged publisher's publication call seam.

Only this process's loaded blob_fs.publish function is wrapped. The product,
publisher source and frozen pause runner remain byte-identical.
"""
import argparse
import importlib.util
import os
import select
import stat
import sys


def pause_before_open(ready_path, go_path):
    descriptors = []
    try:
        for path in (ready_path, go_path):
            info = os.lstat(path)
            if not stat.S_ISFIFO(info.st_mode) or info.st_uid != os.geteuid():
                raise RuntimeError("safety runner requires owned fixture FIFOs")
            descriptors.append(os.open(path, os.O_RDWR | os.O_NONBLOCK | os.O_NOFOLLOW))
        ready, go = descriptors
        message = b"paused before-object-publish\n"
        if os.write(ready, message) != len(message):
            raise RuntimeError("safety runner could not send the pause receipt")
        readable, _, _ = select.select([go], [], [], 10)
        if not readable or os.read(go, 4096) != b"go\n":
            raise RuntimeError("safety runner did not receive a bounded go handshake")
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("history_path")
    parser.add_argument("--ready", required=True)
    parser.add_argument("--go", required=True)
    arguments = parser.parse_args()
    specification = importlib.util.spec_from_file_location("track_safety_history", arguments.history_path)
    if specification is None or specification.loader is None:
        raise ImportError("safety runner cannot load the requested helper")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    original_publish = module.blob_fs.publish

    def publish_after_pause(*args, **kwargs):
        pause_before_open(arguments.ready, arguments.go)
        return original_publish(*args, **kwargs)

    module.blob_fs.publish = publish_after_pause
    return module.main(["save"])


if __name__ == "__main__":
    sys.exit(main())
