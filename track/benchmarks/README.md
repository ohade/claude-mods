# Track pane baseline

TRACK-14 part 1 measures the unchanged pane from commit
`4def77254c60a47d6c21a1450bccee25b79638e1` with Claude Code 2.1.296.
The benchmark lives outside `tests/` so normal regression runs stay unchanged.

From the repository root:

```sh
python3 scripts/track-ui-baseline.py --prepare-only
claude plugin test <tree-from-prepare-output>
python3 scripts/track-ui-baseline.py --log <successful-test-log> \
  --output <new-baseline.json> --engine-version <checked-version>
```

The parser refuses an existing output file, a failing receipt, missing cases,
invalid samples or a different production-hooks digest. The scratch copy keeps
production hooks unchanged. It uses only the benchmark and the existing test kit.
Its fixed test command has no model prompt. Scratch copies remain for review;
move them to Trash after use.

The checked-in baseline contains raw samples, render trees and nearest-rank
p50/p95 values for empty, 50-step, 300-step/200-question, busy, rapid-scroll,
resize and closed-busy cases. Each case uses five warmups and at least 40 render
dispatch samples. Rapid scroll also triggers host redraws, giving 80 samples in
this run. Resize alternates 60-by-30 and 30-by-20 pane cell dimensions.

All data is **FIXTURE**. Timing surrounds the real engine/mod render dispatch,
with synthetic state. The six-second mock-clock window reads host drawings at
100 ms intervals and counts timer writes and observed render dispatches.
The busy case must observe a timer-driven redraw; this control failed with the
original state adapter, then passed after host dependency tracking was retained.
The closed case measures timer writes after unmount, not terminal visibility.
It still recorded 15 pulse and six clock writes, with zero render dispatches.
Stopping hidden animation work remains implementation work for a later part.

These measurements do not measure painted frames or key-to-paint latency.
`key_to_paint_ms` stays null and its status stays **UNRESOLVED**. Native terminal
screenshots are also outstanding. This baseline does not establish the ticket's
10 ms added p95 key-to-paint budget or authorize replacing the live UI.

For comparisons, keep the engine, machine and terminal settings fixed. Run the
baseline and candidate repeatedly in interleaved order, retain each receipt and
compare matching cases. Render dispatch is a separate metric from the required
key-to-paint acceptance gate.
