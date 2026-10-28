// Phase-A R1 seam: preserve unfinished rows and the 2026-10-08 parked-clock fix.
// FIXTURE: pure production rules, no engine/store or LIVE acceptance claim.
import assert from 'node:assert/strict'
import type { Ledger, Step } from '../../types'
import { MAX_STEPS, capRows, capSteps, hasClock, isLifecycleNote, runningClocks, withStatus } from '../../hooks/ledger-policy'

const step = (id: string, status: Step['status'], extra: Partial<Step> = {}): Step =>
  ({ id, source: 'plan', subject: id, status, ...extra })

assert.equal(MAX_STEPS, 300)
const rows = [step('p1', 'pending'), step('c1', 'pending', { cleared: true }),
  step('d1', 'completed'), step('c2', 'pending', { cleared: true }),
  step('p2', 'in_progress'), step('p3', 'waiting')]
const before = structuredClone(rows)
assert.deepEqual(capRows(rows, 3, row => row.status === 'completed').map(row => row.id), ['p1', 'p2', 'p3'])
assert.deepEqual(rows, before, 'Capacity selection must not mutate source rows')
const unfinished = rows.filter(row => !row.cleared && row.status !== 'completed')
assert.deepEqual(capRows(unfinished, 1, () => false), unfinished, 'Unfinished work may exceed the cap; never silently discard it')
const oversized = [...Array.from({ length: 300 }, (_, i) => step(`p${i}`, 'pending')), step('done', 'completed')]
assert.equal(capSteps(oversized).length, 300)
assert.equal(capSteps(oversized).some(row => row.id === 'done'), false)

const completed = step('same', 'completed', { startedAt: 100, endedAt: 150,
  resultText: 'Verified result', resultTextHash: 'a'.repeat(64), resultRequestId: 'old-result',
  resultTurnId: 'old-turn', resultAt: 150, followUp: true })
const reopened = withStatus(completed, 'in_progress', 200, 'new-turn')
assert.equal(reopened.startedAt, 100, 'Reopening retains the original clock start')
assert.equal(reopened.endedAt, undefined)
assert.equal(reopened.activeTurnId, 'new-turn')
for (const key of ['resultText', 'resultTextHash', 'resultRequestId', 'resultTurnId', 'resultAt', 'followUp']) {
  assert.equal(Object.hasOwn(reopened, key), false, `Reopening must drop ${key}`)
}
assert.equal(withStatus(step('work', 'in_progress', { delegated: true }), 'waiting', 200).delegated, undefined)
assert.equal(withStatus(step('work', 'paused', { note: 'interrupted' }), 'pending', 200).note, undefined)
assert.equal(withStatus(step('work', 'paused', { note: 'Keep this explanation' }), 'pending', 200).note, 'Keep this explanation')

for (const status of ['pending', 'paused', 'waiting'] as const) {
  assert.equal(hasClock(step(status, status, { startedAt: 0 })), false, `${status} is not a running clock`)
}
assert.equal(hasClock(step('legacy', 'completed', { startedAt: 0 })), false)
assert.equal(hasClock(step('finished', 'completed', { startedAt: 0, endedAt: 5 })), true)
assert.equal(hasClock(step('running', 'in_progress', { startedAt: 0 })), true)
const ledger: Ledger = { v: 1, nextQuestionId: 1, prompts: [], questions: [], steps: [
  step('running', 'in_progress', { startedAt: 0 }),
  step('cleared', 'in_progress', { startedAt: 0, cleared: true }),
  step('parked', 'paused', { startedAt: 0 }),
  step('ended', 'completed', { startedAt: 0, endedAt: 5 }),
] }
assert.deepEqual(runningClocks(ledger).map(row => row.id), ['running'])
assert.equal(isLifecycleNote('refused'), true)
assert.equal(isLifecycleNote('Keep this explanation'), false)
console.log('ledger-policy: capacity, status/result ownership and clock checks passed')
