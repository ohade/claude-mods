// FIXTURE, phase 2 identity contract (2026-10-26): a local display-number
// collision must repair the stable-source cache and leave both inputs intact.
import assert from 'node:assert/strict'
import { reconcileLedger } from '../../hooks/reconcile'
import type { Ledger } from '../../types'

const SESSION = 'aaaaaaaa-0000-4000-8000-000000000002'
const X = '11111111-0000-4000-8000-000000000002:Q1'
const Y = '22222222-0000-4000-8000-000000000002:Q1'
const empty: Ledger = { v: 1, session_id: SESSION, nextQuestionId: 1, prompts: [], questions: [], steps: [] }
const collision = () => {
  const durable: Ledger = { ...empty, nextQuestionId: 2, restoredIds: { [X]: 1 }, questions: [{
    session_id: SESSION, sourceId: X, id: 1, head: 'X saved question', at: 1, turnId: 'X-turn',
    status: 'answered', answerText: 'X complete saved answer', note: 'Keep every X field',
  }] }
  const local: Ledger = { ...empty, nextQuestionId: 2, restoredIds: { [Y]: 1 }, questions: [{
    session_id: SESSION, sourceId: Y, id: 1, head: 'Y saved question', at: 2, turnId: 'Y-turn',
    status: 'deferred', note: 'Keep every Y field while allocating Q2',
  }] }
  return { durable, local }
}

const checks: Array<[string, () => void]> = [
  ['I1 source cache names the final display number after X:Q1/Y:Q1 merge', () => {
    const { durable, local } = collision()
    const expectedX = structuredClone(durable.questions[0]!)
    const expectedY = { ...local.questions[0]!, id: 2 }
    const merged = reconcileLedger(empty, durable, local, SESSION)
    assert.deepEqual(merged.questions, [expectedX, expectedY], 'I1 distinct display numbers preserve complete X and Y rows')
    assert.deepEqual(merged.restoredIds, { [X]: 1, [Y]: 2 }, 'I1 restoredIds[Y] must equal the final Y id (Q2)')
    assert.equal(merged.nextQuestionId, 3, 'I1 the next question cannot reuse Q2')
  }],
  ['I2 complete durable and local input objects survive collision reconciliation unchanged', () => {
    const { durable, local } = collision()
    const before = JSON.stringify({ durable, local })
    reconcileLedger(empty, durable, local, SESSION)
    assert.equal(JSON.stringify({ durable, local }), before, 'I2 reconcileLedger must not mutate either caller ledger')
  }],
]

let failures = 0
for (const [name, check] of checks) {
  try { check(); console.log(`PASS ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${String(error)}`) }
}
console.log(`${checks.length - failures}/${checks.length} restore identity checks passed`)
if (failures > 0) process.exitCode = 1
