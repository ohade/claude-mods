# TRACK-46 Phase 2 project plan

Started 2026-11-10. Owner: Ohad. Lead: Claude (track-manager). Reviewer: Codex over AMQ
(`track-manager` room).

## Why Phase 2

Stage 1 (slices 1–11) split `register.tsx` down to 276 lines without changing behaviour. A Fable 5.2
review found that the moves were safe but only shifted complexity around. The largest cost was the
helper checks that pin file bytes and layout: 104 of the 115 commits in the refactor range only
re-pointed those checks or refreshed the build identity.

Phase 2 removes that drag and fixes two real design problems. Success is fewer re-point commits per
change and fewer lines. File count is not a goal.

## How each unit runs

1. The lead does the unit under the gates below.
2. The lead stops and asks Codex for a blind review of the unit's diff.
3. The lead reports the unit and Codex's verdict to Ohad, then waits for his go before the next unit.

## Units

| # | Unit | Goal | Size | Proof | Status |
|---|---|---|---|---|---|
| 1 | Retire structure pins | Helper checks stop pinning file bytes, file names, line caps and git history. Behaviour stays covered. | 4–6 h | Inventory table: every removed pin names the behaviour test that covers it and a mutant that test kills, or is marked "structure only" with Ohad's OK. Full suite and remaining helpers green. | done; Codex ACCEPT 2026-11-10. 600 pins removed, 107 kept until fault-proven. Record: `phase2-unit1-pin-disposition.md` |
| 2 | Runner flakiness (TRACK-41) | A green run can be trusted under load. | sized after a probe | Repeated runs under load with no "did not load" line. | pending |
| 3 | Single Stop decider (plan U5, D1 option A) | The command hook decides every Stop block. Module Stop-decision code is removed. | 4–8 h | Failing test first for the moved open-question check. Hook time and snapshot size measured. One live Stop block. | pending |
| 4 | `ledger-store.ts` by job, then one save helper (U4) | Gate publish, blob save, compaction and retention, history, and export/import each get a module. Four save copies become one. | 6–10 h | Behaviour tests unchanged. Live save and restore. The save-helper part waits on TRACK-40 and TRACK-36. | pending |
| 5 | Dead code and tiny-file merge (U2) | Remove six unused declarations in `register.tsx`, move its 55 lines of logic to a module, remove test-only `writeBlob`/`parseBlobPointer`, merge 2–16-line files, turn on unused-local checking. | 2–3 h | Typecheck and suite green. | pending |

Not doing: more handler-module carving, breaking up `paneRender` for size, a DI or ports layer, new
line caps or byte pins, and renaming tests by behaviour (U6) before unit 1 is done.

## Unit 1 detail

Inventory baseline (2026-11-10): 60 `check_*.ts` helpers. 30 read hook source as text. About 219
SHA-256 literals, 168 of them in `check_pane_frame.ts` (64), `check_pane_models.ts` (58) and
`check_pane_viewport.ts` (46). Six helpers hash historical files through `git show <commit>`. About
12 enforce line caps.

Pin classes and the action for each:

- **A. Hashes of historical commits** (`git show <sha>:file`). History cannot change, so these
  guard nothing. Delete.
- **B. Hashes of current source bytes.** These fail on any edit, comments included. Replace with a
  behaviour test when the intent is behaviour. Delete when the intent was "do not touch during the
  refactor".
- **C. Line caps and file-name or owner checks.** Delete unless a cap protects a real limit, and
  state that limit.
- **D. Source-text scans for a rule** (for example "no SDK import outside adapters", "no spawn with
  cwd"). Keep when behaviour cannot test the rule. Prefer an import-based check over text matching.
- **Keep:** the SDK-import rule in `architecture.ts`.

Steps:

1. Build the inventory table: one row per pin, with helper, class, covering test and action.
2. For each B or C pin whose behaviour has no test, write the test first and show it kills a
   deliberate fault.
3. Remove pins in small commits, one helper at a time.
4. Run the full `land.sh`.
5. Codex blind review, then stop for Ohad.
6. Land.

Measure: the re-point commits that a no-op move of one function needs, before and after.

## Gates for every unit

- Failing test first for any behaviour change, with the same test-file SHA-256 at red and green.
- `land.sh`: full suite, helpers, typecheck, build identity, SDK pin.
- Codex ACCEPT before landing.
- Removed checks are named in the commit and in a disposition note.
