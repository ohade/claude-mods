#!/usr/bin/env python3
"""FIXTURE-only failure before the first candidate directory is opened.

The receipt is separate from stdout and stderr so the parent can prove the
injection happened without hiding the real helper's wire response or exception.
"""
import argparse
import importlib.util
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("history_path")
    parser.add_argument("injection_receipt")
    arguments = parser.parse_args()
    specification = importlib.util.spec_from_file_location(
        "track_candidate_race_history", arguments.history_path)
    if specification is None or specification.loader is None:
        raise ImportError("candidate race runner cannot load the requested helper")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    original_open_directory = module.transactions.open_directory
    injected = False

    def open_directory_with_candidate_failure(name, *args, **kwargs):
        nonlocal injected
        if name == "plugins" and not injected:
            injected = True
            Path(arguments.injection_receipt).write_text(
                "candidate-open-error plugins\n", encoding="utf-8")
            raise module.transactions.TransactionError(
                "injected candidate directory changed while opening")
        return original_open_directory(name, *args, **kwargs)

    module.transactions.open_directory = open_directory_with_candidate_failure
    return module.main(["bind"])


if __name__ == "__main__":
    sys.exit(main())
