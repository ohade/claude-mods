# Failure intake

How a Track failure is reported and triaged. Contract: failure-intake r3 with errata E-I1 to E-I4.

## What the reporter sends

1. The session id.
2. The output of `mcp__track__diagnose`, taken in that same session, from the main loop. A subagent
   call is refused with `track: diagnose is main-loop only`. A session whose rows Track does not own
   yet is refused with `track: diagnose needs an admitted owner`.
3. The UTC window of the failure.
4. The exact block or error text as it appeared on screen.

A report without the bundle gets one request for it.

`/track status` also prints one line, `track: loaded <fingerprint8|unknown> (disk <commit8|unknown>)`,
for a quick look. It is not a substitute for the bundle.

## What the bundle holds

`diagnose` returns JSON text: `v`, `identity`, `observed_disk`, `session_id`, `ledger`, `turn`,
`activity`, `pending`, `gate`, `claims`, `ring` and `truncated`. It holds only ids, statuses,
counts, flags and event codes. It never holds prompt or answer text, an excerpt, a question head, a
pending label, a raw error string or the raw gate snapshot. The whole answer is at most 32 KiB of
UTF-8. When something had to be cut, `truncated` is true and the cut array is flagged beside it
(`ring_truncated`, `background_ids_truncated` and so on).

- `identity` is the build the running module loaded: `{ loaded: <source_fingerprint> }`, or
  `{ loaded: 'unknown', reason }` when the bundled identity module is the placeholder or carries
  invalid metadata. It comes from the module's static import of `hooks/build-identity.ts`, so it is
  bound when the module loads and never refreshed. Disk is never consulted for it.
- `observed_disk` is `git rev-parse HEAD` of the mod folder at the time of the call. It is evidence
  of drift only, never of the loaded code. It is absent when Git fails.
- `ring` is the newest 50 events, oldest first, each at most 512 bytes:
  `{ at, code, turn_id?, meta }`. It lives in memory only. A reload or restart loses every earlier
  event, and a new identity does not bring back an earlier failure.
- `gate` is the last Stop snapshot this module published for this owner, projected to counts and
  kinds. It is null when none was published for this owner.
- `claims` lists the shared Stop claim names this session and turn can own, each with `present`.
  Claim files are checked by stat only; no directory is listed and no other session is shown.

Event codes: `save.failed`, `writer.lease_failed`, `writer.lock_cleanup_failed`,
`writer.completion_unconfirmed`, `identity.mint_unavailable`, `transcript.baseline_unrecorded`,
`resume.conflict`, `history.collect_skipped`, `stop.snapshot_unavailable`, `stop.claim_stderr`,
`stop.nudge`, `stop.block.module` and `stop.inventory_applied`.

Visibility gap: a block decided only by the command hook (`stop-gate.py`) has no path back to the
module. It shows in the bundle only indirectly, through the held claims in `claims`. The reason that
hook returned is not visible to `diagnose`.

## How the triager works through it

1. Compare `identity.loaded` with the source fingerprint that the landing receipt maps to the
   deployed commit (`scripts/land.sh --status` and the receipt's `identity` field). If they differ,
   the session ran a build other than live.
2. Read `observed_disk`. A HEAD that differs from the loaded build means the checkout moved after
   the module loaded.
3. Reproduce on the identified commit.
4. Write a failing test first, then fix.

## Worked example 1: metal_manager, session 35cdb031 (AMQ 6975287a, 18:43Z)

The report: the context-handoff mod's automatic run timed out at 180 s. Afterwards the Track Stop
gate asked for a step because the turn changed files, while the run denied `track_steps` and
`mark_step`. The report did not say which Track build was loaded, what the turn had recorded, or
what the gate snapshot held.

With the bundle, the triager compares `identity.loaded` with the landing receipt, then reads
`turn.freshness`: one or more `edits`, zero `steps`, and the `untracked_edit` kind among
`gate.candidate_kinds`. The ring shows a `stop.block.module` event with kind `untracked_edit` and
the turn id. It shows the event codes and counts, never the text that was written.

## Worked example 2: the handoff-gate failure (handoff.log 19:28:38-19:28:49Z, session ca403af7)

The handoff log shows `manual-queued` at 19:28:38.048Z for the end of turn b29a79bc, then
`stop-blocked` with Track's "this turn changed files but no step was created or marked" at
19:28:43.376Z, then `manual-cancelled ... (stop-blocked)` at 19:28:43.394Z. Track's freshness gate
counted the handoff snapshot's Write as an edit, and the handoff mod cancels on any Stop block. It
is the same class as example 1.

The fix is not part of the intake unit. Intake makes the class diagnosable: the bundle shows the
edit count, the empty step count and the held kinds, and the ring shows `stop.block.module` with
kind `untracked_edit` and turn id b29a79bc.
