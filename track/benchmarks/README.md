# Track pane baseline

TRACK-14 part 1 measures the unchanged pane from commit
`4def77254c60a47d6c21a1450bccee25b79638e1` with Claude Code 2.1.296.
Benchmark bodies use `.case.tsx`: native discovery is recursive, so putting a
`.test.tsx` outside `tests/` does not exclude it. The preparers copy these bodies
to scratch `.test.tsx` files for an explicit gate.

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

## Wrapping and visibility candidate

`before-b856bc0.json` and `after-wrap-cache.json` retain a fresh comparison pair.
Both are FIXTURE dispatch measurements. Their render trees match after removing
only the engine's process-local `press.handle` identifiers. Keep the raw trees
and identifiers for review; this comparison does not prove painted pixels.

Run the deterministic wrapping check separately:

```sh
python3 scripts/prepare-track-wrap-check.py --output-tree <new-scratch-tree>
claude plugin test <same-scratch-tree>
bun test scripts/tests/pane-layout-cache.test.ts
```

The wrap preparer adds a counter and log to a scratch copy of the existing
measurement function. This is **INSTRUMENTED FIXTURE** evidence. Refreshing the
same tree refuses changed check bytes. The check requires reuse of an unchanged
offscreen row, then remeasurement on resize and content change. It uses no timing
threshold or patched global. Cache contract checks also cover removal of unused
entries and reuse of both banner layouts.

The normal regression suite includes four visibility checks: closed, hidden or
not placed, reshown after redraw, and a host that cannot report visibility.
Run the six additional lifecycle checks in a separate scratch tree prepared by
the baseline command above:

```sh
cp track/benchmarks/pane-timer-order.case.tsx <scratch-tree>/tests/pane-timer-order.test.tsx
cp track/benchmarks/pane-visibility.case.tsx <scratch-tree>/tests/pane-visibility.test.tsx
cp track/benchmarks/pane-slow-visibility.case.tsx <scratch-tree>/tests/pane-slow-visibility.test.tsx
cp track/benchmarks/pane-hung-visibility.case.tsx <scratch-tree>/tests/pane-hung-visibility.test.tsx
claude plugin test <scratch-tree>
```

This runs 17 checks: seven unchanged dispatch benchmarks, six lifecycle checks,
three slow-host checks, and one hung-request check. Do not feed this combined
log to the seven-case benchmark parser.
The lifecycle checks require resumption without a redraw, rendering and timer
progress despite a hanging host, and zero writes or cancellations from an old
callback after closing and reopening. Shown and hidden delayed responses are
tested for both pulse and clock timers. Checks stay byte-identical across the
recorded failing and passing runs; refresh only production hooks between them.

Supported hosts stop hidden animation writes. A one-second visibility check
restarts eligible timers while the pane stays open. Rendering never waits on
visibility. A timer lookup that throws or exceeds 50 milliseconds logs a
warning and keeps legacy animation. One unresolved raw lookup is shared across
close/reopen cycles; an old generation's visibility answer never controls its
replacement timers. Late answers do not reset the timeout warning flag.
A host that never answers keeps legacy animation running even while hidden,
bounded to one raw request and one warning. Closing and reopening cannot recover
that visibility channel until the host answers; real-host acceptance must check it.
All four follow-up checks failed before the fix: 10 ms hidden-host writes,
10 ms warning spam, late 75 ms warning spam, and the four-reopen request count.
The first slow-host fixture was invalid: the engine refused its test-side timer
call. Its results are discarded. The repaired fixture releases host responses
from the test driver after virtual time passes; production was restored before
its fresh failing run. All four repaired checks stay unchanged for the passing run.
The unchanged
dispatch benchmark has no visibility host, so its closed-busy case still records
legacy timer writes. It cannot prove hidden-stop in the real terminal. Native
visibility acceptance, screenshots and key-to-paint remain open before landing.

## Repeated comparison after the visibility follow-up

The six `pairN-before.json` / `pairN-after.json` files retain raw samples,
trees and native receipt hashes. Claude Code 2.1.296 ran each in a fresh process:
pair 1 before/after, pair 2 after/before, pair 3 before/after. Each run passed
7/7. Before uses the original hooks; after uses the reviewed 50 ms visibility
candidate before the final deadline/slot construction-order cleanup.
The table is **FIXTURE pane render dispatch p95**, in milliseconds, before →
after, rounded to three decimals. Raw nearest-rank values remain in the JSON.

| Case | Pair 1 | Pair 2 | Pair 3 |
|---|---:|---:|---:|
| Empty | 2.342 → 1.194 | 1.266 → 1.159 | 1.157 → 1.329 |
| 50 steps | 3.030 → 1.648 | 2.700 → 1.677 | 2.778 → 1.730 |
| Maximum | 11.982 → 2.472 | 11.776 → 2.419 | 11.674 → 2.181 |
| Busy | 3.262 → 1.706 | 3.229 → 1.520 | 4.020 → 1.881 |
| Rapid scroll | 13.630 → 2.291 | 14.171 → 2.302 | 14.226 → 2.299 |
| Resize | 13.594 → 15.121 | 13.838 → 13.335 | 14.629 → 14.014 |
| Closed busy | 3.876 → 2.691 | 3.908 → 1.680 | 2.891 → 1.475 |

Empty and resize each worsen in one pair and improve in two. These runs do not
show a consistent regression in either case, or establish that differences are
noise. Large-list and scroll dispatch improve in each pair. All 21 paired trees
match after deleting only process-local `press.handle`; raw trees are retained.
These results do not measure painted pixels or key-to-paint latency.
