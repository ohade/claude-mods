// FIXTURE: TRACK-44 corrective Stage A (independent source review REWORK, 2026-11-06T13:57Z).
// The optional subject on missing_waiting_request candidates adds bytes to the Stop snapshot. With the
// R6d shape (150 waiting rows, long ids) the default candidates pass 16 KiB. A fourth argument
// `withSubjects=false` must drop only the subject, keeping every id, its order and kind, so the
// publisher can shed optional repair text before it loses a safety candidate.
// Pure projection of the existing freshnessCandidates; it does not run publishGate or the SDK R6d fixture.
// Run: bun track/tests/helpers/check_track44_candidate_budget.ts   (cwd = worktree root)
import assert from 'node:assert/strict'
import { freshnessCandidates } from '../../hooks/turn-policy'
import type { Activity, FreshnessCandidate, Ledger, Step, StepFreshness, Turn } from '../../types'

const LIMIT = 16 * 1024
const bytes = (rows: unknown): number => Buffer.byteLength(JSON.stringify(rows), 'utf8')
// The fourth argument is new; the cast lets the existing function run and fail on an assertion.
const candidates = freshnessCandidates as unknown as (t: Turn, l: Ledger, a: Activity, withSubjects?: boolean) => FreshnessCandidate[]

const activity: Activity = { isWorking: false, agentCalls: [], askCalls: [], background: [] }
const fixture = (count: number, long: boolean): { turn: Turn; ledger: Ledger } => {
  const steps: Step[] = Array.from({ length: count }, (_, index) =>
    ({ id: `plan:${index + 1}${long ? 'x'.repeat(55) : ''}`, source: 'plan', subject: 'Review the result', status: 'waiting' }))
  const freshness: StepFreshness = {
    turnId: 'current', edits: [], bash: [], steps: [], completed: [], waiting: steps.map(s => s.id), held: [], nudged: [],
    response: { turn_id: 'current', request_id: 'r1', arrow_ids: [] },
  }
  return { turn: { currentId: 'current', gatedTurnId: null, freshness }, ledger: { v: 1, nextQuestionId: 1, prompts: [], questions: [], steps } }
}

const small = fixture(2, false)
assert.deepEqual(candidates(small.turn, small.ledger, activity), [
  { kind: 'missing_waiting_request', id: 'plan:1', subject: 'Review the result' },
  { kind: 'missing_waiting_request', id: 'plan:2', subject: 'Review the result' },
], 'the default call carries the subject')

const big = fixture(150, true)
const full = candidates(big.turn, big.ledger, activity)
assert.equal(full.length, 150, 'every waiting row is a candidate')
assert.ok(bytes(full) > LIMIT, `the default 150-row candidates exceed 16 KiB (got ${bytes(full)} bytes)`)

const lean = candidates(big.turn, big.ledger, activity, false)
assert.ok(lean.every(row => !('subject' in row)), 'withSubjects=false drops the subject field')
assert.deepEqual(lean, full.map(({ subject: _subject, ...rest }) => rest), 'withSubjects=false keeps every id, its order and kind')
assert.ok(bytes(lean) < LIMIT, `the projection fits 16 KiB (got ${bytes(lean)} bytes)`)
console.log('track44 candidate-budget checks passed')
