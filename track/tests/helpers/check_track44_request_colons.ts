// FIXTURE: TRACK-44 corrective Stage A (independent source review REWORK, 2026-11-06T13:57Z).
// A colon inside the request must not join the title. With visible `Deploy` and `Deploy production`,
// `👉 Deploy: production: go?` names `Deploy`; the request's `: ` is a delimiter, never a missing colon
// in a title. A genuinely stored colon title still matches; normalized duplicate titles name nothing;
// the two-argument id call is unchanged. Pure matcher only; no native Stop execution.
// Run: bun track/tests/helpers/check_track44_request_colons.ts   (cwd = worktree root)
import assert from 'node:assert/strict'
import { waitingArrowIds } from '../../hooks/turn-policy'
import { visibleSteps } from '../../hooks/steps'
import type { Step } from '../../types'

const step = (id: string, status: Step['status'], subject: string): Step => ({ id, source: 'plan', subject, status })
const steps: Step[] = [
  step('plan:1', 'waiting', 'Deploy'),
  step('plan:2', 'waiting', 'Deploy production'),
  step('plan:3', 'waiting', 'TRACK-30: choose the threshold'),
  step('plan:4', 'pending', 'Ship it'),
  step('plan:5', 'pending', 'Ship it!'),
]
const inventory = visibleSteps(steps).map(s => ({ id: s.id, subject: s.subject }))
const ids = new Set(inventory.map(s => s.id))
// The cast keeps the call shape explicit; the function itself already takes the third argument.
const arrows = (text: string): string[] =>
  (waitingArrowIds as unknown as (t: string, i: ReadonlySet<string>, v: typeof inventory) => string[])(text, ids, inventory)

assert.deepEqual(arrows('👉 Deploy: production: go?'), ['plan:1'],
  'the request colon cannot turn `Deploy` into the title `Deploy production`')
assert.deepEqual(arrows('👉 Deploy production: go?'), ['plan:2'], 'the longer title is still named by its own pointer')
assert.deepEqual(arrows('👉 TRACK-30: choose the threshold: 20?'), ['plan:3'], 'a stored title containing ": " is still accepted')
assert.deepEqual(arrows('👉 Ship it: now?'), [], 'two titles equal after normalization name nothing')
assert.deepEqual(waitingArrowIds('👉 plan:2: go?', ids), ['plan:2'], 'the two-argument call keeps id matching')
assert.deepEqual(waitingArrowIds('👉 Deploy: production: go?', ids), [], 'the two-argument call does not match titles')
console.log('track44 request-colon checks passed')
