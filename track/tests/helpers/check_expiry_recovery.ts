// FIXTURE, TRACK-21 refuter 4 (2026-10-11): expired data uses a small
// committed deletion intent; crashes finish it, changed data cancels it.
import assert from 'node:assert/strict'
import { checksumOf } from '../../hooks/checkpoint'
import { entryBytes } from '../../hooks/size-index'
import { recoverCleanup, CLOSED_TTL } from '../../hooks/retention'
import type { RetentionStore } from '../../hooks/retention'
const session = '11111111-2222-4333-8444-555555555555'
const bodyKey = `s:${session}`
const archiveKey = `r:${session}:old`
const headKey = `h:${session}`
const intentKey = `cleanup:${session}`
const body = { v: 1, session_id: session, ledger: { text: 'original' } }
const head = { v: 1, session_id: session, closedAt: Date.now() - CLOSED_TTL - 1000 }
const archive = { v: 1, session_id: session, value: 'archived' }
const entries = await Promise.all([[archiveKey, archive], [headKey, head], [bodyKey, body]].map(async ([key, value]) => ({ key: key as string, checksum: await checksumOf(value), bytes: entryBytes(key as string, value) })))
const intent = { v: 2, mode: 'expiry', session_id: session, closedAt: head.closedAt, entries }
const makeStore = (values: Map<string, unknown>): RetentionStore => ({ get: async key => values.get(key), keys: async () => [...values.keys()],
  set: async (key, value) => { values.set(key, structuredClone(value)) }, delete: async key => { values.delete(key) }, log: () => {} })
let failures = 0
for (const changed of [false, true]) {
  try {
    // The first delete committed before the process crashed. The remaining
    // keys must be preflighted before deleting any of them after a restart.
    const nextBody = changed ? { ...body, ledger: { text: 'new owner value' } } : body
    const values = new Map<string, unknown>([[bodyKey, nextBody], [headKey, head], [intentKey, intent], ['protected', { text: 'keep' }]])
    assert.equal(await recoverCleanup(makeStore(values), session), true)
    assert.equal(values.has(intentKey), false)
    if (changed) {
      assert.deepEqual(values.get(bodyKey), nextBody)
      assert.deepEqual(values.get(headKey), head, 'changed body stops every remaining deletion')
    } else {
      assert.equal(values.has(bodyKey), false)
      assert.equal(values.has(headKey), false)
    }
    assert.deepEqual(values.get('protected'), { text: 'keep' })
    console.log(`PASS expiry recovery ${changed ? 'keeps changed history' : 'finishes after a crash'}`)
  } catch (error) { failures++; console.error(`FAIL expiry recovery changed=${changed}: ${String(error)}`) }
}
if (failures) process.exitCode = 1
