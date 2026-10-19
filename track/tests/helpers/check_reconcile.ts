// TRACK-21 (2026-10-11): three-way reconciliation must use row values, and
// must apply acknowledged deletions instead of resurrecting withdrawn rows.
import assert from 'node:assert/strict'
import { reconcileLedger } from '../../hooks/reconcile'
import type { Ledger, Step } from '../../types'

const session = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const empty: Ledger = { v: 1, nextQuestionId: 1, prompts: [], questions: [], steps: [] }
const planned = (id: string, sourceId: string): Step => ({ id, sourceId, source: 'plan', subject: sourceId, status: 'pending' })
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
// TRACK-26 (2026-10-19): distinct logical generations must not produce
// duplicate local tool/pane ids when stale writers replace or insert rows.
for (const inserting of [false, true]) checks.push([
  `${inserting ? 'after-insert' : 'replacement'} writers with reused step ids conflict without mutating either version`, () => {
    const anchor = planned('plan:1', 'original-generation')
    const base = { ...empty, steps: inserting ? [anchor] : [] }
    const id = inserting ? 'plan:2' : 'plan:1'
    const durable = { ...base, steps: [...base.steps, planned(id, 'left-generation')] }
    const local = { ...base, steps: [...base.steps, planned(id, 'right-generation')] }
    const before = JSON.stringify([durable, local])
    assert.throws(() => reconcileLedger(base, durable, local, session), /reconcile conflict: duplicate step id/)
    assert.equal(JSON.stringify([durable, local]), before)
  },
])
checks.push(['concurrent new rows with distinct step ids still merge', () => {
  const anchor = planned('plan:1', 'original-generation')
  const base = { ...empty, steps: [anchor] }
  const merged = reconcileLedger(base,
    { ...base, steps: [anchor, planned('plan:2', 'left-generation')] },
    { ...base, steps: [anchor, planned('plan:3', 'right-generation')] }, session)
  assert.deepEqual(merged.steps.map(row => row.id).sort(), ['plan:1', 'plan:2', 'plan:3'])
}])
let failures = 0
for (const [name, check] of checks) {
  try { check(); console.log(`PASS ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${String(error)}`) }
}
if (failures > 0) process.exitCode = 1
