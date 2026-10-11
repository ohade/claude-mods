// FIXTURE, TRACK-21 refuter 6 (2026-10-11): B's expiry must not delete
// session-switch memory from a live or unknown A, including crash recovery.
import assert from 'node:assert/strict'
import { checksumOf } from '../../hooks/checkpoint'
import { entryBytes } from '../../hooks/size-index'
import { CLOSED_TTL, cleanupRecords } from '../../hooks/retention'
import type { RetentionStore } from '../../hooks/retention'

const source = '11111111-2222-4333-8444-555555555555'
const destination = '22222222-3333-4444-8555-666666666666'
const caller = '33333333-4444-4555-8666-777777777777'
const archiveKey = `r:${destination}:session-switch-original`
let failures = 0
for (const pending of [false, true]) for (const state of ['live', 'closed', 'unknown', 'error'] as const) {
  const head = { v: 1, session_id: destination, closedAt: Date.now() - CLOSED_TTL - 1000 }
  const body = { v: 1, session_id: destination, ledger: { questions: [] } }
  const archive = { v: 1, session_id: destination, kind: 'session-switch', value: {
    source_session: state === 'unknown' ? null : source,
    ledger: { ...(state !== 'unknown' && { session_id: source }), questions: [{ head: 'A unsaved row' }] },
  } }
  const entries: Array<[string, unknown]> = [[archiveKey, archive], [`h:${destination}`, head], [`s:${destination}`, body]]
  const values = new Map(entries)
  if (pending) values.set(`cleanup:${destination}`, { v: 2, mode: 'expiry', session_id: destination, closedAt: head.closedAt,
    entries: await Promise.all(entries.map(async ([key, value]) => ({ key, checksum: await checksumOf(value), bytes: entryBytes(key, value) }))) })
  const held = new Set<string>()
  const probes: string[] = []
  const store: RetentionStore = {
    get: async key => values.get(key), keys: async () => [...values.keys()],
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    delete: async key => {
      if (key === archiveKey && state === 'closed') {
        assert.equal(held.has(destination), true, 'destination guard stays held')
        assert.equal(held.has(source), true, 'source guard stays held through deletion')
      }
      values.delete(key)
    }, log: () => {},
  }
  try {
    await cleanupRecords(store, caller, async session => {
      probes.push(session)
      if (session === source && state === 'error') throw new Error('source lease probe unavailable')
      held.add(session)
      return { state: session === source && state !== 'closed' ? 'live' : 'closed', release: async () => { held.delete(session) } }
    }).catch(error => {
      if (state !== 'error') throw error
      assert.match(String(error), /source lease probe unavailable/)
    })
    if (state === 'closed') {
      assert.equal(values.has(archiveKey), false)
      assert.equal(values.has(`s:${destination}`), false)
      assert.equal(values.has(`h:${destination}`), false)
    } else {
      assert.deepEqual(values.get(archiveKey), archive)
      assert.deepEqual(values.get(`s:${destination}`), body)
      assert.deepEqual(values.get(`h:${destination}`), head)
    }
    if (state !== 'unknown') assert.equal(probes.includes(source), true, 'source lease is checked')
    assert.equal(held.size, 0, 'all guards are released')
    console.log(`PASS switch archive pending=${pending} source=${state}`)
  } catch (error) { failures++; console.error(`FAIL switch archive pending=${pending} source=${state}: ${String(error)}`) }
}
if (failures) process.exitCode = 1
