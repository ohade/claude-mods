// FIXTURE: TRACK-44 (Plane dev-velocity TRACK #44, Ohad 2026-10-24). After completed steps are
// cleared, the pane numbers rows by position, so a reply cannot find the permanent id the Stop gate
// asks for. The request line may name the waiting step by its visible title, or a unique prefix of
// it; permanent ids keep working. Design choice: option 1, an ASSUMPTION while Ohad is away.
// Pure matcher and selector only; no native Stop execution.
// Run: bun track/tests/helpers/check_track44_waiting_title.ts   (cwd = worktree root)
import assert from 'node:assert/strict'
import { freshnessCandidates, waitingArrowIds } from '../../hooks/turn-policy'
import { visibleSteps } from '../../hooks/steps'
import type { Activity, Ledger, Step, StepFreshness, Turn } from '../../types'

const step = (id: string, status: Step['status'], subject: string, extra: Partial<Step> = {}): Step =>
  ({ id, source: 'plan', subject, status, ...extra })
const steps: Step[] = [
  // Cleared, with the same title as plan:7: it must not make that title ambiguous.
  step('plan:1', 'completed', 'Approve the compact-crafter install', { cleared: true }),
  step('plan:7', 'waiting', 'Approve the compact-crafter install'),
  step('plan:8', 'in_progress', 'Approve the compact-crafter plan review'),
  step('plan:9', 'waiting', 'TRACK-30: choose the threshold'),
  step('plan:10', 'pending', 'Unrelated cleanup'),
  step('plan:11', 'pending', 'Deploy'),
  step('plan:12', 'pending', 'Deploy staging'),
]
const inventory = visibleSteps(steps).map(s => ({ id: s.id, subject: s.subject }))
const ids = new Set(inventory.map(s => s.id))
// The third argument is new; the cast keeps this file runnable before the signature changes.
const arrows = (text: string): string[] =>
  (waitingArrowIds as unknown as (t: string, i: ReadonlySet<string>, v: typeof inventory) => string[])(text, ids, inventory)

assert.deepEqual(arrows('👉 Approve the compact-crafter install: yes or no?'), ['plan:7'], 'the exact visible title covers the waiting id')
assert.deepEqual(arrows('👉 Approve the compact-crafter in: approve?'), ['plan:7'], 'a unique title prefix covers the waiting id')
assert.deepEqual(arrows('👉 Approve the compact-crafter: which one?'), [], 'a prefix shared by two visible steps covers nothing')
assert.deepEqual(arrows('👉 Deploy: go?'), ['plan:11'], 'an exact title wins over a longer title it prefixes')
assert.deepEqual(arrows('👉 TRACK-30: choose the threshold: pick a number'), ['plan:9'], 'a title containing ": " is matched as a known title')
assert.deepEqual(arrows('👉 Approve the compact-crafter install: reply: yes'), ['plan:7'], 'a colon inside the request does not change the title')
assert.deepEqual(arrows('👉 plan:9: pick a number'), ['plan:9'], 'the permanent id still works')
assert.deepEqual(arrows('```\n👉 Approve the compact-crafter install: yes\n```'), [], 'a fenced pointer does not count')
assert.deepEqual(arrows('👉 Approve the compact-crafter install:'), [], 'an empty request does not count')
assert.deepEqual(arrows('👉 Approve the compact-crafter install'), [], 'a pointer with no request does not count')
assert.deepEqual(arrows('Approve the compact-crafter install: yes'), [], 'an ordinary mention does not count')
assert.deepEqual(arrows('👉 Unrelated cleanup: ok?'), ['plan:10'], 'an unrelated title covers only its own row')
assert.deepEqual(waitingArrowIds('👉 plan:7: yes?', ids), ['plan:7'], 'the two-argument call keeps id matching')
assert.deepEqual(waitingArrowIds('👉 Approve the compact-crafter install: yes?', ids), [], 'the two-argument call does not match titles')

// The selector: a valid title request removes the missing-request candidate; anything else keeps it,
// and the candidate carries the step's subject so the gate can name it.
const activity: Activity = { isWorking: false, agentCalls: [], askCalls: [], background: [] }
const ledger: Ledger = { v: 1, nextQuestionId: 1, prompts: [], questions: [], steps }
const turnWith = (text: string): Turn => {
  const freshness: StepFreshness = {
    turnId: 'current', edits: [], bash: [], steps: [], completed: [], waiting: ['plan:7', 'plan:9'], held: [], nudged: [],
    response: { turn_id: 'current', request_id: 'r1', arrow_ids: arrows(text) },
  }
  return { currentId: 'current', gatedTurnId: null, freshness }
}
assert.deepEqual(freshnessCandidates(turnWith('👉 Approve the compact-crafter install: yes?\n👉 TRACK-30: choose the threshold: 20?'), ledger, activity), [],
  'both waiting rows named by title: no missing-request candidate')
assert.deepEqual(freshnessCandidates(turnWith('👉 Approve the compact-crafter: which?'), ledger, activity), [
  { kind: 'missing_waiting_request', id: 'plan:7', subject: 'Approve the compact-crafter install' },
  { kind: 'missing_waiting_request', id: 'plan:9', subject: 'TRACK-30: choose the threshold' },
], 'an ambiguous prefix leaves both candidates, each with its subject')
assert.deepEqual(freshnessCandidates(turnWith('👉 Unrelated cleanup: ok?'), ledger, activity).map(c => c.id), ['plan:7', 'plan:9'],
  'an unrelated title does not cover a waiting row')
console.log('track44 waiting-title checks passed')
