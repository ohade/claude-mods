// FIXTURE, TRACK-21 refuter 5 (2026-10-11): owner recovery preserves remaining
// history; foreign expiry recovery must stop starting deletes at its budget.
import assert from 'node:assert/strict'
import { checksumOf } from '../../hooks/checkpoint'
import { entryBytes } from '../../hooks/size-index'
import { cleanupRecords, recoverCleanup, CLOSED_TTL } from '../../hooks/retention'
import type { RetentionStore } from '../../hooks/retention'

const session = '11111111-2222-4333-8444-555555555555'
const caller = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const bodyKey = `s:${session}`
const headKey = `h:${session}`
const intentKey = `cleanup:${session}`
const body = { v: 1, session_id: session, ledger: { questions: ['kept'] } }
const originalNow = Date.now
const start = originalNow()
const head = { v: 1, session_id: session, closedAt: start - CLOSED_TTL - 1000 }
const entries = await Promise.all([[headKey, head], [bodyKey, body]].map(async ([key, value]) => ({ key: key as string, checksum: await checksumOf(value), bytes: entryBytes(key as string, value) })))
const intent = { v: 2, mode: 'expiry', session_id: session, closedAt: head.closedAt, entries }
const storeOf = (values: Map<string, unknown>): RetentionStore => ({
  get: async key => values.get(key), keys: async () => [...values.keys()],
  set: async (key, value) => { values.set(key, structuredClone(value)) },
  delete: async key => { values.delete(key) }, log: () => {},
})
let failures = 0
try {
  const values = new Map<string, unknown>([[bodyKey, body], [headKey, head], [intentKey, intent]])
  assert.equal(await recoverCleanup(storeOf(values), session, { owner: true }), true)
  assert.deepEqual(values.get(bodyKey), body, 'the live returning owner keeps its body')
  assert.deepEqual(values.get(headKey), head, 'the live returning owner keeps its head')
  assert.equal(values.has(intentKey), false)
  console.log('PASS returning owner cancels expiry without deleting remaining history')
} catch (error) { failures++; console.error(`FAIL returning owner expiry: ${String(error)}`) }
try {
  const currentHead = { v: 1, session_id: session, retentionOnly: true, changedByStore: true }
  const recovery = { v: 1, session_id: session, entries: [{ key: headKey, missing: true, after: head }] }
  const values = new Map<string, unknown>([[bodyKey, body], [headKey, currentHead], [intentKey, recovery]])
  await assert.rejects(recoverCleanup(storeOf(values), session), /could not verify/)
  assert.deepEqual(values.get(intentKey), recovery, 'foreign recovery keeps the journal')
  assert.equal(await recoverCleanup(storeOf(values), session, { owner: true }), true)
  assert.deepEqual(values.get(bodyKey), body)
  assert.deepEqual(values.get(headKey), currentHead)
  assert.equal(values.has(intentKey), false)
  const archives = [...values.entries()].filter(([key]) => key.startsWith(`r:${session}:cleanup-conflict-`))
  assert.equal(archives.length, 1)
  assert.deepEqual((archives[0]![1] as any).value, { recovery, values: [{ key: headKey, value: currentHead }] })
  console.log('PASS only the owner archives a mismatched journal and preserves current values')
} catch (error) { failures++; console.error(`FAIL returning owner stamp: ${String(error)}`) }
try {
  let now = start
  Date.now = () => now
  const values = new Map<string, unknown>([[bodyKey, body], [headKey, head], [intentKey, intent]])
  const store = storeOf(values)
  const deleted: string[] = []
  store.delete = async key => {
    deleted.push(key)
    values.delete(key)
    if (key === headKey) now += 251
  }
  let released = 0
  await assert.rejects(cleanupRecords(store, caller, async () => ({ state: 'closed', release: async () => { released++ } })), /budget/)
  assert.deepEqual(deleted, [headKey], 'after one slow delete no later delete starts')
  assert.deepEqual(values.get(bodyKey), body)
  assert.deepEqual(values.get(intentKey), intent)
  assert.equal(released, 1)
  console.log('PASS pending foreign expiry observes the elapsed budget between deletes')
} catch (error) { failures++; console.error(`FAIL pending expiry budget: ${String(error)}`) }
finally { Date.now = originalNow }
if (failures) process.exitCode = 1
