#!/usr/bin/env python3
"""Test-owned runner for TRACK-39 A2 pin rows: runs history.py's real main with
its response limit lowered, so a test can reach the response bound with a few
roots instead of tens of thousands."""
import importlib.util
import sys


def main():
    history, operation, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
    spec = importlib.util.spec_from_file_location("track_history", history)
    if spec is None or spec.loader is None:
        raise ImportError("limit runner cannot load the requested helper")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    module.MAX_RESPONSE = limit
    return module.main([operation])


if __name__ == "__main__":
    sys.exit(main())
