// FIXTURE: pure selector and SOURCE registration contract; no native Stop execution.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { freshnessCandidates } from '../../hooks/turn-policy'
import type { Activity, Ledger, Step, StepFreshness, Turn } from '../../types'

const activity: Activity = { isWorking: false, agentCalls: [], askCalls: [], background: [] }
const step = (id: string, status: Step['status'], extra: Partial<Step> = {}): Step =>
  ({ id, source: 'plan', subject: 'Work', status, ...extra })
const freshness: StepFreshness = { turnId: 'current', edits: [], bash: [], steps: [], completed: [], waiting: [], held: [], nudged: [] }
const turn: Turn = { currentId: 'current', gatedTurnId: null, freshness }
const ledger = (steps: Step[]): Ledger => ({ v: 1, nextQuestionId: 1, prompts: [], questions: [], steps })
const finished = step('plan:1', 'in_progress', { activeTurnId: 'old', delegated: true, followUp: true })
const expected = { kind: 'finished_delegation', id: 'plan:1', owner_task_ids: [] }

assert.deepEqual(freshnessCandidates(turn, ledger([finished]), activity), [expected], 'older-turn finished delegation remains a candidate')
assert.deepEqual(freshnessCandidates(turn, ledger([finished]), { ...activity, owners: { 'worker-2': ['plan:1'] }, background: ['worker-2'] }),
  [{ ...expected, owner_task_ids: ['worker-2'] }], 'remaining owner receipt is retained after another owner completes')

// The persisted codec accepts only true, but malformed/legacy false values must not select a row.
const falseValue = JSON.parse('false')
for (const excluded of [
  step('plan:1', 'in_progress', { delegated: true }),
  step('plan:1', 'in_progress', { delegated: true, followUp: falseValue }),
  step('plan:1', 'in_progress', { delegated: true, followUp: true, cleared: true }),
  step('plan:1', 'completed', { delegated: true, followUp: true }),
  step('plan:1', 'paused', { delegated: true, followUp: true }),
  step('plan:1', 'in_progress', { delegated: falseValue, followUp: true, activeTurnId: 'old' }),
]) assert.deepEqual(freshnessCandidates(turn, ledger([excluded]), activity), [], 'excluded row does not select finished delegation')

const orderedTurn: Turn = { ...turn, freshness: { ...freshness, waiting: ['plan:3'] } }
assert.deepEqual(freshnessCandidates(orderedTurn, ledger([
  step('plan:3', 'waiting'), finished, step('plan:2', 'in_progress', { activeTurnId: 'current' }),
]), activity), [
  { kind: 'stale_in_progress', id: 'plan:2', owner_task_ids: [] },
  expected,
  { kind: 'missing_waiting_request', id: 'plan:3', subject: 'Work' },
], 'stale precedes finished delegation, which precedes waiting')

// SOURCE contract only: parse the static array without evaluating repository code.
// TRACK-46 slice 5 (2026-11-09, Ohad's standing approval): FRESHNESS_KINDS moved to turn-guidance.ts.
const source = readFileSync(new URL('../../hooks/turn-guidance.ts', import.meta.url), 'utf8')
assert.doesNotMatch(readFileSync(new URL('../../hooks/register.tsx', import.meta.url), 'utf8'), /^(?:export )?const FRESHNESS_KINDS\b/m, 'register.tsx does not re-declare FRESHNESS_KINDS')
const literal = /^export const FRESHNESS_KINDS: FreshnessKind\[\] = (\[[^\]\n]*\])$/m.exec(source)?.[1]
assert.ok(literal, 'static FRESHNESS_KINDS literal exists')
assert.deepEqual(JSON.parse(literal.replace(/'([^']*)'/g, '"$1"')), [
  'premature_completion', 'stale_in_progress', 'finished_delegation', 'missing_waiting_request', 'untracked_edit',
], 'SOURCE freshness priority')
