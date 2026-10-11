// FIXTURE, TRACK-21 (2026-10-11): controlled time proves expiry boundaries,
// conservative liveness, fair bounded work, and interruption metadata.
import assert from 'node:assert/strict'
import { cleanupRecords, CLOSED_TTL } from '../../hooks/retention'
import type { RetentionStore } from '../../hooks/retention'

const HOUR = 3600000
const caller = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
let now = 100 * CLOSED_TTL
const originalNow = Date.now
Date.now = () => now
const makeStore = (initial: Record<string, unknown> = {}) => {
  const values = new Map(Object.entries(initial))
  const store: RetentionStore = {
    keys: async () => [...values.keys()], get: async key => values.get(key),
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    delete: async key => { values.delete(key) }, log: () => {},
  }
  return { store, values }
}
const closed = async () => ({ state: 'closed' as const, release: async () => {} })
const cases: Array<[string, () => Promise<void>]> = []
const check = (name: string, run: () => Promise<void>) => cases.push([name, run])

check('first CLOSED starts seven full days; exact boundary expires body/head/recovery together', async () => {
  const record = { v: 1, session_id: id(1), checkpoint: { revision: 7 }, ledger: { question: 'keep' } }
  const { store, values } = makeStore({ [`s:${id(1)}`]: record, [`h:${id(1)}`]: record, [`r:${id(1)}:old`]: record })
  const start = now
  await cleanupRecords(store, caller, closed)
  assert.equal((values.get(`h:${id(1)}`) as any).closedAt, start)
  assert.deepEqual(values.get(`s:${id(1)}`), record)
  assert.deepEqual((values.get(`s:${id(1)}`) as any).checkpoint, { revision: 7 })
  now = start + CLOSED_TTL - 1
  await cleanupRecords(store, caller, closed)
  assert.equal(values.has(`s:${id(1)}`), true)
  values.delete('cleanup')
  now = start + CLOSED_TTL
  await cleanupRecords(store, caller, closed)
  for (const prefix of ['s', 'h', 'r']) assert.equal([...values.keys()].some(key => key.startsWith(`${prefix}:${id(1)}`)), false)
})
// Design amended by lead, refuter M5: only the owner clears its clock.
for (const state of ['live', 'unknown'] as const) check(`${state} leaves the foreign record byte-identical`, async () => {
  const record = { v: 1, session_id: id(2), closedAt: now - CLOSED_TTL, ledger: { question: 'keep' } }
  const { store, values } = makeStore({ [`s:${id(2)}`]: record })
  await cleanupRecords(store, caller, async () => {
    if (state === 'unknown') throw new Error('probe refused')
    return { state: 'live', release: async () => {} }
  })
  assert.deepEqual(values.get(`s:${id(2)}`), record)
})
check('hour throttle and backwards time do not probe; exact next hour can probe', async () => {
  const start = now
  const { store } = makeStore({ [`s:${id(3)}`]: { v: 1, ledger: {} }, cleanup: { v: 1, lastCleanup: start } })
  let probes = 0
  const probe = async () => { probes++; return closed() }
  now = start + HOUR - 1; await cleanupRecords(store, caller, probe)
  now = start - HOUR; await cleanupRecords(store, caller, probe)
  assert.equal(probes, 0)
  now = start + HOUR; await cleanupRecords(store, caller, probe)
  assert.equal(probes, 1)
})
check('three eight-record passes visit all twenty owners and never the caller', async () => {
  const initial: Record<string, unknown> = { [`s:${caller}`]: { v: 1, ledger: {} } }
  for (let n = 1; n <= 20; n++) initial[`s:${id(n)}`] = { v: 1, ledger: {} }
  const { store, values } = makeStore(initial)
  const visited: string[] = []
  for (let pass = 0; pass < 3; pass++) {
    const before = visited.length
    await cleanupRecords(store, caller, async session => { visited.push(session); return closed() })
    assert.equal(visited.length - before, 8)
    now += HOUR
  }
  assert.equal(new Set(visited).size, 20)
  assert.equal(visited.includes(caller), false)
  assert.deepEqual(values.get(`s:${caller}`), initial[`s:${caller}`])
})
check('elapsed budget stops starting new targets after one slow probe', async () => {
  const { store } = makeStore(Object.fromEntries([1, 2, 3].map(n => [`s:${id(n)}`, { v: 1, ledger: {} }])))
  let probes = 0
  await cleanupRecords(store, caller, async () => { probes++; now += 300; return closed() })
  assert.equal(probes, 1)
})
check('failed mutation cannot publish lastCleanup', async () => {
  const { store, values } = makeStore({ [`s:${id(4)}`]: { v: 1, ledger: {} } })
  const set = store.set
  store.set = async (key, value) => { if (key === `h:${id(4)}`) throw new Error('write refused'); return set(key, value) }
  await assert.rejects(cleanupRecords(store, caller, closed), /write refused/)
  assert.equal((values.get('cleanup') as any)?.lastCleanup, undefined)
  assert.deepEqual(values.get(`s:${id(4)}`), { v: 1, ledger: {} })
})
check('durable rollback recovery obeys the same elapsed work budget', async () => {
  const initial: Record<string, unknown> = {}
  for (let n = 1; n <= 3; n++) initial[`cleanup:${id(n)}`] = { v: 1, session_id: id(n), entries: [{ key: `s:${id(n)}`, before: { v: 1, ledger: {} } }] }
  const { store, values } = makeStore(initial)
  let probes = 0
  await cleanupRecords(store, caller, async () => { probes++; now += 300; return closed() })
  assert.equal(probes, 1)
  assert.equal([...values.keys()].filter(key => key.startsWith('cleanup:')).length, 2)
})
let failures = 0
try {
  for (const [name, run] of cases) {
    try { await run(); console.log(`PASS ${name}`) }
    catch (error) { failures++; console.error(`FAIL ${name}: ${String(error)}`) }
  }
} finally { Date.now = originalNow }
if (failures) process.exitCode = 1
