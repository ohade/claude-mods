// FIXTURE: the extracted boundary preserves question identity and compatibility exports.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import type { Ledger } from '../../types'

assert.ok(existsSync(new URL('../../hooks/question-identity.ts', import.meta.url)), 'missing question identity boundary: question-identity.ts')

const boundary = await import('../../hooks/question-identity')
const compatibility = await import('../../hooks/reconcile')
for (const name of ['questionHighWater', 'legacySourceId', 'reconcileQuestionIdentity'] as const) {
  assert.strictEqual(compatibility[name], boundary[name], `${name} compatibility export`)
}

const question = (id: number): Ledger['questions'][number] => ({
  id, head: `Question ${id}`, at: id, turnId: null, status: 'open',
})
const rows = { questions: [question(40)], withdrawn: [{ id: 90, head: 'gone' }] }
assert.equal(boundary.questionHighWater({ nextQuestionId: 30, ...rows }), 91)
assert.equal(boundary.questionHighWater({ nextQuestionId: 100, ...rows }), 100)
assert.equal(boundary.questionHighWater({ nextQuestionId: 1, questions: [] }), 1)
assert.equal(boundary.legacySourceId('archive', { ...question(7), sourceId: 'stable' }), 'stable')
assert.equal(boundary.legacySourceId('archive', question(7)), 'archive:Q7')

const visible = [{ ...question(9), sourceId: 'stable' }]
const hints = { unrelated: 700, stable: 2 }
const restores: NonNullable<Ledger['restores']> = [{
  by: 'restore', from: 'archive', steps: 0,
  questions: [{ ...question(2), sourceId: 'stable' }, question(7)],
}]
const before = JSON.stringify({ visible, hints, restores })
assert.deepEqual(boundary.reconcileQuestionIdentity(visible, hints, restores), {
  restoredIds: { unrelated: 700, stable: 9 },
  restores: [{ ...restores[0], questions: [{ ...restores[0]!.questions[0], id: 9 }, restores[0]!.questions[1]] }],
})
assert.equal(JSON.stringify({ visible, hints, restores }), before)
assert.deepEqual(boundary.reconcileQuestionIdentity([], undefined, undefined), {})
const cleared = { ...question(9), sourceId: 'stable', cleared: true as const }
assert.deepEqual(boundary.reconcileQuestionIdentity([cleared], { stable: 2 }, undefined), { restoredIds: { stable: 2 } })
assert.deepEqual(boundary.reconcileQuestionIdentity([cleared, cleared], undefined, undefined), {})

for (const duplicate of [
  [{ ...question(9), sourceId: 'a' }, { ...question(9), sourceId: 'b' }],
  [{ ...question(9), sourceId: 'a' }, { ...question(10), sourceId: 'a' }],
]) {
  const refusalHints = { a: 2, unrelated: 700 }
  const refusalRestores = structuredClone(restores)
  const original = JSON.stringify({ duplicate, refusalHints, refusalRestores })
  assert.throws(() => boundary.reconcileQuestionIdentity(duplicate, refusalHints, refusalRestores),
    /question identity is ambiguous; original rows were kept/)
  assert.equal(JSON.stringify({ duplicate, refusalHints, refusalRestores }), original)
}
console.log('question-identity-boundary: invariants satisfied (FIXTURE)')
