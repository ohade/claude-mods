#!/usr/bin/env python3
"""Prepare/refresh an owned instrumented fixture for TRACK-14 wrap reuse.

The 2026-10-12 baseline recomputed offscreen wrapping on every redraw.
Native globals are readonly, so count calls in a scratch copy, never production.
Tier B CLI: writes only the explicit scratch tree; never runs a model or test.
"""

import argparse
import hashlib
from pathlib import Path
import shutil
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1] / "track")
    parser.add_argument("--output-tree", type=Path, required=True)
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    tree = args.output_tree.resolve()
    if tree == source or source in tree.parents or tree in source.parents:
        parser.error("scratch tree must be outside the source tree")
    marker = tree / ".track14-wrap-fixture"
    test = (source / "benchmarks" / "wrap-reuse.case.tsx").read_bytes()
    expected_marker = hashlib.sha256(test).hexdigest()
    if tree.exists():
        if not marker.is_file() or marker.read_text() != expected_marker:
            parser.error("existing tree is not this unchanged wrap-check fixture")
        if (tree / "tests" / "wrap-reuse.test.tsx").read_bytes() != test:
            parser.error("scratch check changed; restore and repeat RED before GREEN")
    else:
        shutil.copytree(source, tree, ignore=shutil.ignore_patterns("tests", "benchmarks", "__pycache__", "*.pyc"))
        (tree / "tests").mkdir()
        shutil.copyfile(source / "tests" / "kit.ts", tree / "tests" / "kit.ts")
        (tree / "tests" / "wrap-reuse.test.tsx").write_bytes(test)
        marker.write_text(expected_marker)
    shutil.copytree(source / "hooks", tree / "hooks", dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    path = tree / "hooks" / "register.tsx"
    original = path.read_text()
    counter_at = "const wrappedLines = (text: string, width: number): number => {"
    report_at = "    const atWork = steps.findIndex(s => s.status !== 'completed')"
    if original.count(counter_at) != 1 or original.count(report_at) != 1:
        raise ValueError("wrap measurement anchors changed; no check was run")
    instrumented = original.replace(counter_at,
        "let fixtureWrapCalls = 0\n" + counter_at +
        "\n  if (text.includes('CACHE_OFFSCREEN_SENTINEL')) fixtureWrapCalls++")
    instrumented = instrumented.replace(report_at,
        "    $.ui.log(`TRACK14_WRAP_COUNT ${fixtureWrapCalls}`, { to: 'debug' })\n" + report_at)
    path.write_text(instrumented)
    print(f"INSTRUMENTED FIXTURE tree={tree} check_sha256={expected_marker} source_sha256={hashlib.sha256(original.encode()).hexdigest()}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(f"prepare-track-wrap-check: {error}", file=sys.stderr)
        sys.exit(1)
