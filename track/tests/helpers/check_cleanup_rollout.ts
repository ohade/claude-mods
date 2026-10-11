// FIXTURE, TRACK-21 refuter 7 (2026-10-11): source checks precede expiry
// intent creation; blocked recovery is hourly; owner cancellation tolerates
// backwards wall time without relaxing the journal's structural validation.
import assert from 'node:assert/strict'
import { checksumOf } from '../../hooks/checkpoint'
import { entryBytes } from '../../hooks/size-index'
import { CLOSED_TTL, cleanupRecords, recoverCleanup } from '../../hooks/retention'
import type { RetentionStore } from '../../hooks/retention'

const source = '11111111-2222-4333-8444-555555555555'
const session = '22222222-3333-4444-8555-666666666666'
const caller = '33333333-4444-4555-8666-777777777777'
const intentKey = `cleanup:${session}`
const originalNow = Date.now
const start = originalNow()
let now = start
Date.now = () => now
const head = { v: 1, session_id: session, closedAt: start - CLOSED_TTL - 1000 }
const body = { v: 1, session_id: session, ledger: { questions: ['B row'] } }
const archiveKey = `r:${session}:session-switch-source`
const archive = { v: 1, session_id: session, kind: 'session-switch', value: { source_session: source, ledger: { session_id: source, questions: ['A row'] } } }
const entries: Array<[string, unknown]> = [[archiveKey, archive], [`h:${session}`, head], [`s:${session}`, body]]
const intent = { v: 2, mode: 'expiry', session_id: session, closedAt: head.closedAt,
  entries: await Promise.all(entries.map(async ([key, value]) => ({ key, checksum: await checksumOf(value), bytes: entryBytes(key, value) }))) }
const storeOf = (values: Map<string, unknown>): RetentionStore => ({
  get: async key => values.get(key), keys: async () => [...values.keys()],
  set: async (key, value) => { values.set(key, structuredClone(value)) }, delete: async key => { values.delete(key) }, log: () => {},
})
let failures = 0
try {
  for (const sourceState of ['live', 'closed'] as const) {
    try {
      const values = new Map(entries)
      const store = storeOf(values)
      const held = new Set<string>()
      const set = store.set
      store.set = async (key, value) => {
        if (key === intentKey) assert.equal(held.has(source), true, 'source guard held before expiry intent is published')
        return set(key, value)
      }
      await cleanupRecords(store, caller, async target => {
        if (target !== source || sourceState === 'closed') held.add(target)
        return { state: target === source ? sourceState : 'closed', release: async () => { held.delete(target) } }
      })
      assert.equal(values.has(intentKey), false, 'blocked fresh expiry never leaves an import-blocking journal')
      assert.equal(values.has(archiveKey), sourceState === 'live')
      assert.equal(values.has(`s:${session}`), sourceState === 'live')
      assert.equal(held.size, 0)
      console.log(`PASS fresh expiry preflight source=${sourceState}`)
    } catch (error) { failures++; console.error(`FAIL fresh expiry source=${sourceState}: ${String(error)}`) }
  }
  try {
    now = start
    const values = new Map([...entries, [intentKey, intent]] as Array<[string, unknown]>)
    const store = storeOf(values)
    let probes = 0
    let sourceClosed = false
    const probe = async (target: string) => { probes++; return { state: target === source && !sourceClosed ? 'live' as const : 'closed' as const, release: async () => {} } }
    await cleanupRecords(store, caller, probe)
    const firstProbes = probes
    assert.equal(firstProbes, 2)
    now++
    await cleanupRecords(store, caller, probe)
    assert.equal(probes, firstProbes, 'blocked expiry does not probe on every save')
    assert.deepEqual(values.get(intentKey), intent)
    sourceClosed = true
    now = start + 3600000
    await cleanupRecords(store, caller, probe)
    assert.equal(probes, firstProbes + 2)
    assert.equal(values.has(intentKey), false)
    assert.equal(values.has(`s:${session}`), false)
    console.log('PASS blocked pending expiry retries at the next hourly attempt')
  } catch (error) { failures++; console.error(`FAIL blocked pending throttle: ${String(error)}`) }
  try {
    now = head.closedAt - 1000
    const values = new Map([...entries, [intentKey, intent]] as Array<[string, unknown]>)
    const store = storeOf(values)
    await assert.rejects(recoverCleanup(store, session), /ambiguous durable intent/)
    assert.equal(await recoverCleanup(store, session, { owner: true }), true)
    assert.equal(values.has(intentKey), false)
    for (const [key, value] of entries) assert.deepEqual(values.get(key), value)
    const malformed = { ...intent, entries: [{ ...intent.entries[0], checksum: 'invalid' }] }
    values.set(intentKey, malformed)
    await assert.rejects(recoverCleanup(store, session, { owner: true }), /ambiguous durable intent/)
    assert.deepEqual(values.get(intentKey), malformed)
    console.log('PASS backwards time permits only structurally valid owner cancellation')
  } catch (error) { failures++; console.error(`FAIL backwards owner clock: ${String(error)}`) }
} finally { Date.now = originalNow }
if (failures) process.exitCode = 1
