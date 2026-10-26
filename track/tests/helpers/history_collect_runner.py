#!/usr/bin/env python3
"""Test-owned runner for TRACK-39 A2 collect rows: runs history.py's real main
and pauses before the Nth open of one named leaf, so a test can change that
file between collect's enumeration and its locked recheck."""
import argparse
import importlib.util
import os
import sys


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("history")
    parser.add_argument("op", choices=("collect",))
    parser.add_argument("--pause-name", required=True)
    parser.add_argument("--pause-count", type=int, required=True)
    parser.add_argument("--ready", required=True)
    parser.add_argument("--go", required=True)
    return parser.parse_args()


def load_history(path):
    spec = importlib.util.spec_from_file_location("track_history", path)
    if spec is None or spec.loader is None:
        raise ImportError("collect runner cannot load the requested helper")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def pause(arguments):
    with open(arguments.ready, "w", encoding="utf-8") as ready:
        ready.write(f"paused {arguments.pause_name}#{arguments.pause_count}\n")
    with open(arguments.go, "r", encoding="utf-8") as go:
        if go.readline() != "go\n":
            raise RuntimeError("collect runner did not receive its go handshake")


def main():
    arguments = parse_arguments()
    module = load_history(arguments.history)
    original = os.open
    seen = {"count": 0}

    def counted_open(path, *args, **kwargs):
        if os.path.basename(os.fsdecode(path)) == arguments.pause_name:
            seen["count"] += 1
            if seen["count"] == arguments.pause_count:
                pause(arguments)
        return original(path, *args, **kwargs)

    os.open = counted_open
    return module.main([arguments.op])


if __name__ == "__main__":
    sys.exit(main())
