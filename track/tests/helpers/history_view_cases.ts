// FIXTURE: the same read-routing cases run against the original and extracted owner.
import assert from 'node:assert/strict'
import type { Ledger } from '../../types'
import type { HistoryRun } from '../../hooks/history-receipts'

type View = { root?: unknown; rootHash?: string; durable?: Ledger }
type Reads = { read: (store: string, id: string) => Promise<HistoryRun>; legacy: (key: string) => Promise<unknown> }
type Reader = (reads: Reads, store: string, id: string) => Promise<View | 'legacy'>
const id = 'history-view-owner'
const root = { seq: 4, generation: 'generation', checkpoint: null }
const valid = (ledger_text: unknown = null): HistoryRun => ({ kind: 'ok', response: { state: 'valid', root, root_sha256: 'root-hash', ledger_text } })

export const checkHistoryView = async (reader: Reader): Promise<void> => {
  const calls: string[] = []
  const run = async (receipt: HistoryRun, values: Record<string, unknown> = {}): Promise<View | 'legacy'> => {
    calls.length = 0
    return reader({ read: async (store, session) => { calls.push(`read:${store}:${session}`); return receipt },
      legacy: async key => { calls.push(key); return values[key] } }, 'store', id)
  }
  const absent: HistoryRun = { kind: 'ok', response: { state: 'absent' } }
  assert.deepEqual(await run(absent), {}, 'absent history without legacy data is an empty view')
  assert.deepEqual(calls, [`read:store:${id}`, `s:${id}`, `h:${id}`])
  for (const value of [null, false, 0, '', {}]) {
    assert.equal(await run(absent, { [`s:${id}`]: value }), 'legacy', 'every defined legacy body keeps the legacy route')
    assert.deepEqual(calls, [`read:store:${id}`, `s:${id}`], 'a legacy body short-circuits the head read')
  }
  assert.equal(await run(absent, { [`h:${id}`]: {} }), 'legacy', 'a legacy head alone keeps the legacy route')
  for (const [receipt, message] of [
    [{ kind: 'refused', reason: 'read refused' }, 'read refused'],
    [{ kind: 'pending', cause: 'lost receipt' }, 'v3 history read failed: lost receipt'],
  ] as const) {
    await assert.rejects(run(receipt), { message }, 'failed history reads never consult legacy data')
    assert.deepEqual(calls, [`read:store:${id}`])
  }
  const empty = await run(valid(), { [`s:${id}`]: {} })
  assert.deepEqual(empty, { root, rootHash: 'root-hash' }, 'a valid root without body never consults legacy')
  assert.notEqual(empty, 'legacy')
  assert.equal((empty as View).root, root, 'the root object is retained')
  assert.deepEqual(calls, [`read:store:${id}`])
  const ledger = { v: 1, nextQuestionId: 1, prompts: [], questions: [{ id: 7, head: 'Question', at: 1, turnId: null, status: 'answered', answerText: 'Answer' }],
    steps: [{ id: 'p1', source: 'plan', subject: 'Step', status: 'waiting', note: 'User action' }] }
  const before = JSON.stringify(ledger)
  const decoded = await run(valid(JSON.stringify(ledger))) as View
  assert.equal(decoded.durable?.session_id, id)
  assert.equal(decoded.durable?.questions[0]?.session_id, id, 'question ownership is established on decoded rows')
  assert.equal(decoded.durable?.questions[0]?.answerText, 'Answer')
  assert.equal(decoded.durable?.nextQuestionId, 8, 'stored-codec high water remains in force')
  assert.equal(decoded.durable?.steps[0]?.session_id, id)
  assert.equal(decoded.durable?.steps[0]?.status, 'waiting')
  assert.equal(decoded.durable?.steps[0]?.note, 'User action')
  assert.equal(JSON.stringify(ledger), before)
  const incompatible = [
    { state: 'damaged' }, { root: undefined }, { root: [] }, { root: { ...root, seq: 1.5 } },
    { root_sha256: null }, { ledger_text: undefined }, { ledger_text: {} },
  ]
  for (const change of incompatible) {
    const receipt = valid() as Extract<HistoryRun, { kind: 'ok' }>
    await assert.rejects(run({ ...receipt, response: { ...receipt.response, ...change } }, { [`s:${id}`]: {} }),
      { message: 'v3 history read receipt is incompatible' }, 'damaged history must never fall back to legacy')
    assert.deepEqual(calls, [`read:store:${id}`])
  }
  await assert.rejects(run(valid('{')), error => error instanceof Error && error.message === 'v3 history damaged: saved ledger is not JSON' && error.cause instanceof SyntaxError)
  await assert.rejects(run(valid('null')), { message: 'v3 history damaged: saved ledger is incompatible' })
  await assert.rejects(run(valid(JSON.stringify({ ...ledger, session_id: 'foreign' }))), { message: 'ledger identity is ambiguous; original rows were kept' })
  for (const seq of [0, -1]) {
    const receipt = valid() as Extract<HistoryRun, { kind: 'ok' }>
    assert.deepEqual(await run({ ...receipt, response: { ...receipt.response, root: { ...root, seq } } }),
      { root: { ...root, seq }, rootHash: 'root-hash' }, 'the move does not add sequence validation')
  }
  const failure = new Error('storage failed')
  await assert.rejects(reader({ read: async () => absent, legacy: async () => { throw failure } }, 'store', id), error => error === failure)
  await assert.rejects(reader({ read: async () => { throw failure }, legacy: async () => undefined }, 'store', id), error => error === failure)
}
