// TRACK-21 (2026-10-11): three-way reconciliation must use row values, and
// must apply acknowledged deletions instead of resurrecting withdrawn rows.
import assert from 'node:assert/strict'
import { reconcileLedger } from '../../hooks/reconcile'
import type { Ledger } from '../../types'

const session = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const empty: Ledger = { v: 1, nextQuestionId: 1, prompts: [], questions: [], steps: [] }
const checks: Array<[string, () => void]> = [
  ['property order does not create a conflicting row', () => {
    const row = { id: 1, head: 'same', status: 'open' as const, at: 1, turnId: null }
    const reordered = { turnId: null, at: 1, status: 'open' as const, head: 'same', id: 1 }
    const merged = reconcileLedger(undefined, { ...empty, questions: [row] }, { ...empty, questions: [reordered] }, session)
    assert.equal(merged.questions.length, 1)
    assert.equal(merged.questions[0].head, 'same')
  }],
  ['a durable withdrawn-row deletion is not resurrected', () => {
    const base = { ...empty, withdrawn: [{ id: 1, head: 'withdrawn', at: 1 }] } as Ledger
    const merged = reconcileLedger(base, { ...empty, withdrawn: [] }, base, session)
    assert.deepEqual(merged.withdrawn, [])
  }],
]
let failures = 0
for (const [name, check] of checks) {
  try { check(); console.log(`PASS ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${String(error)}`) }
}
if (failures > 0) process.exitCode = 1
