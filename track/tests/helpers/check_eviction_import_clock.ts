// FIXTURE, TRACK-31 T31-1 (2026-10-22): real retention code, in-memory stores.
import assert from 'node:assert/strict'
import { cleanupRecords, ensureCapacity } from '../../hooks/retention'
import type { RetentionStore } from '../../hooks/retention'
import { entryBytes } from '../../hooks/size-index'

const HOUR = 3600000
const now = Date.now()
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const caller = id(99)
const provenance = { source_identity: '/legacy', bundle_checksum: 'fixture', source_session: id(1) }
const body = (session: string, savedAt?: unknown, imported = false) => ({
  v: 1, session_id: session, savedAt, ledger: { v: 1, prompts: [], questions: [], steps: [] },
  padding: 'p'.repeat(4000), ...(imported && { import_provenance: provenance }),
})
const head = (session: string, closedAt?: unknown) => ({ v: 1, session_id: session, closedAt })
const write = { [`s:${caller}`]: body(caller, now) }
const closed = async () => ({ state: 'closed' as const, release: async () => {} })
const memory = (initial: Record<string, unknown>) => {
  const values = new Map(Object.entries(structuredClone(initial)))
  const store: RetentionStore = {
    get: async key => values.get(key), keys: async () => [...values.keys()],
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    delete: async key => { values.delete(key) }, log: () => {},
  }
  return { store, values }
}
const bytesOf = (records: Record<string, unknown>) => {
  const entries = Object.entries(records)
  return 2 + entries.reduce((total, [key, value]) => total + entryBytes(key, value), 0) + Math.max(0, entries.length - 1)
}
const cases: Array<[string, () => Promise<void>]> = []
const check = (name: string, run: () => Promise<void>) => cases.push([name, run])

// Exactly one body frees enough room, independently of which candidate is chosen.
const evictOne = async (fixture: ReturnType<typeof memory>, expected: string, probe = closed) => {
  const before = Object.fromEntries(fixture.values)
  const budget = bytesOf({ ...before, ...write }) - 1000
  const evicted = await ensureCapacity(fixture.store, write, budget, { caller, probe })
  assert.deepEqual(evicted, [expected], 'incorrect eviction: expected the oldest effective clock')
  const retained = Object.fromEntries(Object.entries(before).filter(([key]) => !key.startsWith(`s:${expected}`) && !key.startsWith(`h:${expected}`)))
  assert.deepEqual(Object.fromEntries(fixture.values), retained, 'retained records and clocks must stay byte-identical')
}

check('freshly stamped import survives before an older closed native record', async () => {
  const fixture = memory({
    [`s:${id(1)}`]: body(id(1), now - 30 * 24 * HOUR, true),
    [`h:${id(1)}`]: head(id(1)),
    [`s:${id(2)}`]: body(id(2), now - 2 * HOUR),
    [`h:${id(2)}`]: head(id(2), now - HOUR),
  })
  const beforeCleanup = Date.now()
  await cleanupRecords(fixture.store, caller, closed)
  const stamp = (fixture.values.get(`h:${id(1)}`) as { closedAt: number }).closedAt
  assert.ok(stamp >= beforeCleanup && stamp <= Date.now(), 'cleanup must start a fresh import clock')
  assert.deepEqual(fixture.values.get(`s:${id(1)}`), body(id(1), now - 30 * 24 * HOUR, true))
  await evictOne(fixture, id(2))
})

for (const invalid of [undefined, null, -1, NaN, Infinity, '20']) {
  check(`import with invalid closedAt ${String(invalid)} ranks after dated native history`, async () => {
    await evictOne(memory({
      [`s:${id(1)}`]: body(id(1), 1, true), [`h:${id(1)}`]: head(id(1), invalid),
      [`s:${id(2)}`]: body(id(2), 20), [`h:${id(2)}`]: head(id(2), 30),
    }), id(2))
  })
}

for (const [name, savedAt, closedAt] of [
  ['later savedAt wins over closedAt', 40, 10],
  ['later closedAt wins over savedAt', 10, 40],
  ['only savedAt is valid', 40, -1],
  ['only closedAt is valid', -1, 40],
  ['neither clock is valid', -1, null],
] as const) check(name, async () => {
  await evictOne(memory({
    [`s:${id(1)}`]: body(id(1), savedAt), [`h:${id(1)}`]: head(id(1), closedAt),
    [`s:${id(2)}`]: body(id(2), 20), [`h:${id(2)}`]: head(id(2), 30),
  }), id(2))
})

check('zero is a valid clock', async () => {
  await evictOne(memory({
    [`s:${id(1)}`]: body(id(1), 0), [`h:${id(1)}`]: head(id(1), 0),
    [`s:${id(2)}`]: body(id(2), 20),
  }), id(1))
})

for (const clock of [20, undefined]) check(`equal clocks ${String(clock)} use session id despite reversed insertion`, async () => {
  await evictOne(memory({
    [`s:${id(2)}`]: body(id(2), clock), [`h:${id(2)}`]: head(id(2), clock),
    [`s:${id(1)}`]: body(id(1), clock), [`h:${id(1)}`]: head(id(1), clock),
  }), id(1))
})

check('LIVE and unknown leases stay intact and all acquired guards release', async () => {
  const fixture = memory({
    [`s:${id(1)}`]: body(id(1), 1), [`h:${id(1)}`]: head(id(1), 2),
    [`s:${id(2)}`]: body(id(2), 3), [`h:${id(2)}`]: head(id(2), 4),
    [`s:${id(3)}`]: body(id(3), 5), [`h:${id(3)}`]: head(id(3), 6),
  })
  const probed: string[] = []
  const held = new Set<string>()
  const released: string[] = []
  const probe = async (session: string) => {
    probed.push(session)
    if (session === id(2)) throw new Error('unknown lease')
    held.add(session)
    return { state: session === id(1) ? 'live' as const : 'closed' as const, release: async () => { held.delete(session); released.push(session) } }
  }
  const remove = fixture.store.delete
  fixture.store.delete = async key => {
    if (/^[shr]:/.test(key)) assert.ok(held.has(key.split(':')[1]!), 'deletion must hold the target guard')
    await remove(key)
  }
  const before = Object.fromEntries(fixture.values)
  const evicted = await ensureCapacity(fixture.store, write, bytesOf({ ...before, ...write }) - 1000, { caller, probe })
  assert.deepEqual(evicted, [id(3)])
  assert.deepEqual(Object.fromEntries(fixture.values), Object.fromEntries(Object.entries(before).filter(([key]) => !key.endsWith(id(3)))))
  assert.deepEqual(probed, [id(1), id(2), id(3)])
  assert.deepEqual(released, [id(1), id(3)])
  assert.equal(held.size, 0)
})

let failures = 0
for (const [name, run] of cases) {
  try { await run(); console.log(`PASS ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${String(error)}`) }
}
if (failures) process.exitCode = 1
