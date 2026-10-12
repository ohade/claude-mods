#!/usr/bin/env python3
"""TRACK-14 part 1: capture repeatable mod-dispatch proxies, never paint latency.

Tier B, agent/human caller. --prepare-only writes a fresh disposable benchmark
tree; otherwise a fixed native test command runs with no model prompt. --log
parses a lead-run receipt instead. Scratch is retained for review/Trash cleanup.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


SCENARIOS = {
    "empty": (0, 0), "steps-50": (50, 0), "maximum": (300, 200),
    "busy": (50, 0), "rapid-scroll": (300, 200), "resize": (300, 200),
    "closed-busy": (50, 0),
}
PREFIX = "TRACK14_BASELINE "


def source_digest(source: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted((source / "hooks").rglob("*")):
        if path.is_file() and path.suffix not in {".pyc"}:
            digest.update(path.relative_to(source).as_posix().encode())
            digest.update(b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")
    return digest.hexdigest()


def percentile(samples: list[float], percent: float) -> float:
    ordered = sorted(samples)
    return ordered[math.ceil(percent * len(ordered)) - 1]


def parse_receipt(text: str, expected_digest: str) -> list[dict]:
    records = {}
    for line in text.splitlines():
        if PREFIX not in line:
            continue
        record = json.loads(line.split(PREFIX, 1)[1])
        name = record["scenario"]
        if name in records or name not in SCENARIOS:
            raise ValueError("duplicate or unknown benchmark scenario")
        if (record["steps"], record["questions"]) != SCENARIOS[name]:
            raise ValueError(f"fixture size mismatch: {name}")
        samples = record["samples_ms"]
        if (record.get("proof_class") != "FIXTURE" or record.get("schema_version") != 1
                or record.get("production_source_digest") != expected_digest
                or record.get("metric") != "pane_render_dispatch_ms"
                or not isinstance(samples, list) or len(samples) < 40
                or any(isinstance(value, bool) or not isinstance(value, (int, float))
                       or not math.isfinite(value) or value < 0 for value in samples)):
            raise ValueError(f"invalid measurement receipt: {name}")
        if not isinstance(record.get("snapshot"), dict):
            raise ValueError(f"missing render tree: {name}")
        window = record["timer_window"]
        if window["virtual_ms"] != 6000:
            raise ValueError(f"wrong timer window: {name}")
        for key in ("pulse_state_writes", "clock_state_writes", "explicit_invalidation_calls", "observed_render_dispatches"):
            if not isinstance(window[key], int) or window[key] < 0:
                raise ValueError(f"invalid counter: {name}/{key}")
        records[name] = {**record, "summary_ms": {
            "n": len(samples), "p50": percentile(samples, .50),
            "p95": percentile(samples, .95), "min": min(samples), "max": max(samples),
        }, "timer_render_dispatches_per_virtual_second": window["observed_render_dispatches"] / 6}
    if set(records) != set(SCENARIOS):
        raise ValueError(f"missing scenarios: {sorted(set(SCENARIOS) - set(records))}")
    return [records[name] for name in SCENARIOS]


def prepare(source: Path, scratch_parent: Path, expected_digest: str) -> Path:
    scratch_parent.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix="track14-baseline-", dir=scratch_parent))
    tree = scratch / "track"
    shutil.copytree(source, tree, ignore=shutil.ignore_patterns("tests", "benchmarks", "__pycache__", "*.pyc"))
    tests = tree / "tests"
    tests.mkdir()
    shutil.copyfile(source / "tests" / "kit.ts", tests / "kit.ts")
    benchmark = (source / "benchmarks" / "pane-render.case.tsx").read_text()
    marker = "TRACK14_PREPARED_SOURCE_DIGEST"
    if benchmark.count(marker) != 1 or source_digest(tree) != expected_digest:
        raise ValueError("benchmark marker missing or copied production source changed")
    (tests / "pane-render.test.tsx").write_text(benchmark.replace(marker, expected_digest))
    return tree


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1] / "track")
    parser.add_argument("--scratch-parent", type=Path, default=Path(tempfile.gettempdir()))
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--log", type=Path, help="parse a successful native benchmark test log")
    parser.add_argument("--output", type=Path, help="new baseline JSON path; existing files are preserved")
    parser.add_argument("--engine-version", help="version checked by the lead for this receipt")
    args = parser.parse_args()
    if args.prepare_only and (args.log or args.output):
        parser.error("--prepare-only cannot be combined with --log or --output")
    if not args.prepare_only and (not args.output or not args.engine_version):
        parser.error("capture/parse requires --output and --engine-version")
    if args.output and args.output.exists():
        parser.error("--output already exists; choose a new path")
    source = args.source.resolve(strict=True)
    before = source_digest(source)
    if args.prepare_only:
        tree = prepare(source, args.scratch_parent, before)
        print(json.dumps({"schema_version": 1, "tree": str(tree), "source_digest": before,
                          "next_argv": ["claude", "plugin", "test", str(tree)]}))
        return 0
    if args.log:
        text = args.log.read_text()
        log_digest = hashlib.sha256(args.log.read_bytes()).hexdigest()
    else:
        tree = prepare(source, args.scratch_parent, before)
        result = subprocess.run(["claude", "plugin", "test", str(tree)],
                                capture_output=True, text=True, timeout=180, check=False)
        text = result.stdout + "\n" + result.stderr
        log = tree.parent / "engine.log"
        log.write_text(text)
        if result.returncode != 0:
            raise ValueError(f"native benchmark failed (exit {result.returncode}); inspect {log}")
        log_digest = hashlib.sha256(text.encode()).hexdigest()
    if source_digest(source) != before:
        raise ValueError("production hooks changed during capture")
    records = parse_receipt(text, before)
    # A failed test cannot become a passing baseline just because it emitted records first.
    if "(fail)" in text or not re.search(r"\b0 fail\b", text):
        raise ValueError("receipt does not prove zero failing benchmark tests")
    baseline = {"schema_version": 1, "proof_class": "FIXTURE", "engine_version": args.engine_version,
                "production_source_digest": before, "receipt_sha256": log_digest,
                "percentile_method": "nearest rank", "key_to_paint_ms": None,
                "key_to_paint_status": "UNRESOLVED", "scenarios": records}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as stream:
        json.dump(baseline, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({"proof_class": "FIXTURE", "key_to_paint_status": "UNRESOLVED", "scenarios": [
        {"name": row["scenario"], "render_dispatch_ms": row["summary_ms"], "timer_window": row["timer_window"]}
        for row in records]}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        print(f"track-ui-baseline: {error}", file=sys.stderr)
        sys.exit(1)
