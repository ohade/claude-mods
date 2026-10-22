// TRACK-31 (2026-10-20): when a write would pass the store budget, evict the
// oldest CLOSED sessions through the expiry intent path until the write fits.
import { expect, test } from 'claude-code/testing'
import { cleanupRecords, ensureCapacity, recoverCleanup } from '../hooks/retention'
import { checksumOf } from '../hooks/checkpoint'
import type { RetentionStore } from '../hooks/retention'
import { entryBytes } from '../hooks/size-index'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

const CAPACITY = 'capacity: protected or unexpired history fills the UTF-8 store budget; nothing was pruned'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const CALLER = id(99)
type Lease = 'live' | 'closed' | 'error'
type Eviction = { caller: string; protect?: string[]; probe: (session: string) => Promise<{ state: 'closed' | 'live'; release: () => Promise<void> }> }
// The eviction options are the behaviour under test; the alias keeps the call
// reaching that behaviour even where the parameter does not exist yet.
const evicting = ensureCapacity as unknown as (store: RetentionStore, replacements: Record<string, unknown>, budget: number, eviction: Eviction) => Promise<unknown>

const memory = (initial: Record<string, unknown>, options: { failDelete?: string } = {}) => {
  const held = new Map<string, unknown>(Object.entries(JSON.parse(JSON.stringify(initial))))
  let failDelete = options.failDelete
  const logs: string[] = []
  const store: RetentionStore = {
    get: async key => held.get(key),
    set: async (key, value) => { held.set(key, JSON.parse(JSON.stringify(value))) },
    delete: async key => {
      if (key === failDelete) { failDelete = undefined; throw new Error(`interrupted deleting ${key}`) }
      held.delete(key)
    },
    keys: async () => [...held.keys()],
    log: message => { logs.push(message) },
  }
  return { held, store, logs }
}

const leases = (states: Record<string, Lease>) => {
  const probed: string[] = []
  const released: string[] = []
  const probe = async (session: string) => {
    probed.push(session)
    if (states[session] === 'error') throw new Error('lease ambiguous')
    return { state: states[session] === 'closed' ? 'closed' as const : 'live' as const, release: async () => { released.push(session) } }
  }
  return { probe, probed, released }
}

// Same arithmetic as the capacity check: JSON object text of all entries.
const bytesOf = (records: Record<string, unknown>): number => {
  const entries = Object.entries(records).filter(([, value]) => value !== undefined)
  return 2 + entries.reduce((total, [key, value]) => total + entryBytes(key, value), 0) + Math.max(0, entries.length - 1)
}
const body = (session: string, pad: number, savedAt?: number) => ({ v: 1, session_id: session, ...(savedAt !== undefined && { savedAt }), ledger: EMPTY, padding: 'p'.repeat(pad) })
const without = (records: Record<string, unknown>, ...sessions: string[]) =>
  Object.fromEntries(Object.entries(records).filter(([key]) => !sessions.some(session => key === `s:${session}` || key === `h:${session}` || key.startsWith(`r:${session}:`))))
const write = { [`s:${CALLER}`]: body(CALLER, 500, 5000) }

// T31-1 (2026-10-22): imported savedAt is historical; cleanup starts a fresh clock.
test('TRACK-31 a freshly stamped import outlives an older closed native record', async () => {
  const now = Date.now()
  const imported = { ...body(id(1), 4000, now - 30 * 86400000), import_provenance: { source_identity: '/legacy', bundle_checksum: 'fixture', source_session: id(1) } }
  const initial = {
    [`s:${id(1)}`]: imported,
    [`h:${id(1)}`]: { v: 1, session_id: id(1) },
    [`s:${id(2)}`]: body(id(2), 4000, now - 7200000),
    [`h:${id(2)}`]: { v: 1, session_id: id(2), closedAt: now - 3600000 },
  }
  const { held, store } = memory(initial)
  const { probe } = leases({ [id(1)]: 'closed', [id(2)]: 'closed' })
  await cleanupRecords(store, CALLER, probe)
  expect((held.get(`h:${id(1)}`) as { closedAt: number }).closedAt).toBeGreaterThanOrEqual(now)
  expect(held.get(`s:${id(1)}`)).toEqual(imported)
  const stamped = Object.fromEntries(held)
  await expect(evicting(store, write, bytesOf({ ...stamped, ...write }) - 1000, { caller: CALLER, probe })).resolves.toEqual([id(2)])
  expect(Object.fromEntries(held)).toEqual(without(stamped, id(2)))
})

for (const closedAt of [undefined, null, -1, '20']) test(`TRACK-31 an import with invalid closedAt ${String(closedAt)} ranks last`, async () => {
  const initial = {
    [`s:${id(1)}`]: { ...body(id(1), 4000, 1), import_provenance: { source_identity: '/legacy', bundle_checksum: 'fixture', source_session: id(1) } },
    [`h:${id(1)}`]: { v: 1, session_id: id(1), closedAt },
    [`s:${id(2)}`]: body(id(2), 4000, 20),
    [`h:${id(2)}`]: { v: 1, session_id: id(2), closedAt: 30 },
  }
  const { held, store } = memory(initial)
  const { probe } = leases({ [id(1)]: 'closed', [id(2)]: 'closed' })
  const before = Object.fromEntries(held)
  await expect(evicting(store, write, bytesOf({ ...before, ...write }) - 1000, { caller: CALLER, probe })).resolves.toEqual([id(2)])
  expect(Object.fromEntries(held)).toEqual(without(before, id(2)))
})

for (const [name, savedAt, closedAt] of [
  ['later save', 40, 10], ['later close', 10, 40], ['save only', 40, -1],
  ['close only', -1, 40], ['neither clock', -1, null],
] as const) test(`TRACK-31 ranking uses ${name}`, async () => {
  const initial = {
    [`s:${id(1)}`]: body(id(1), 4000, savedAt), [`h:${id(1)}`]: { v: 1, session_id: id(1), closedAt },
    [`s:${id(2)}`]: body(id(2), 4000, 20), [`h:${id(2)}`]: { v: 1, session_id: id(2), closedAt: 30 },
  }
  const { held, store } = memory(initial)
  const { probe } = leases({ [id(1)]: 'closed', [id(2)]: 'closed' })
  await expect(evicting(store, write, bytesOf({ ...initial, ...write }) - 1000, { caller: CALLER, probe })).resolves.toEqual([id(2)])
  expect(Object.fromEntries(held)).toEqual(without(initial, id(2)))
})

for (const clock of [0, 20, undefined]) test(`TRACK-31 equal ${String(clock)} clocks use session id despite reversed key order`, async () => {
  const initial = { [`s:${id(2)}`]: body(id(2), 4000, clock), [`s:${id(1)}`]: body(id(1), 4000, clock) }
  const { held, store } = memory(initial)
  const { probe } = leases({ [id(1)]: 'closed', [id(2)]: 'closed' })
  await expect(evicting(store, write, bytesOf({ ...initial, ...write }) - 1000, { caller: CALLER, probe })).resolves.toEqual([id(1)])
  expect(Object.fromEntries(held)).toEqual(without(initial, id(1)))
})

test('TRACK-31 under budget nothing is probed, evicted or written', async () => {
  const initial = { [`s:${id(1)}`]: body(id(1), 1000, 10) }
  const { held, store } = memory(initial)
  const { probe, probed } = leases({ [id(1)]: 'closed' })
  await evicting(store, write, bytesOf({ ...initial, ...write }) + 1, { caller: CALLER, probe })
  expect(probed).toEqual([])
  expect(Object.fromEntries(held)).toEqual(initial)
})

test('TRACK-31 evicts oldest closed sessions first and stops once the write fits', async () => {
  // Key order and size order both disagree with age order.
  const initial = {
    [`s:${id(1)}`]: body(id(1), 3000),                                   // neither clock: last
    [`s:${id(2)}`]: body(id(2), 3000, 30),                               // newest saved
    [`h:${id(3)}`]: { v: 1, session_id: id(3), retentionOnly: true, closedAt: 20 }, // head clock only
    [`r:${id(3)}:legacy-head-x`]: { v: 1, session_id: id(3), kind: 'legacy-head', value: 'q'.repeat(1500) },
    [`s:${id(4)}`]: body(id(4), 1000, 10),                               // oldest saved
  }
  const { held, store } = memory(initial)
  const { probe, released } = leases({ [id(1)]: 'closed', [id(2)]: 'closed', [id(3)]: 'closed', [id(4)]: 'closed' })
  const budget = bytesOf({ ...without(initial, id(4), id(3)), ...write }) + 1
  expect(bytesOf({ ...without(initial, id(4)), ...write })).toBeGreaterThanOrEqual(budget)
  await expect(evicting(store, write, budget, { caller: CALLER, probe })).resolves.toEqual([id(4), id(3)])
  expect(Object.fromEntries(held)).toEqual(without(initial, id(4), id(3)))
  expect(released.sort()).toEqual([id(3), id(4)].sort())
})

test('TRACK-31 a live, ambiguous or unknown lease is never evicted', async () => {
  const initial = {
    [`s:${id(1)}`]: body(id(1), 2000, 1),
    [`s:${id(2)}`]: body(id(2), 2000, 2),
    [`s:${id(3)}`]: body(id(3), 2000, 3),
    [`s:${id(4)}`]: body(id(4), 2000, 40),
  }
  const { held, store } = memory(initial)
  const { probe, released } = leases({ [id(1)]: 'live', [id(2)]: 'error', [id(4)]: 'closed' })
  const budget = bytesOf({ ...without(initial, id(4)), ...write }) + 1
  await expect(evicting(store, write, budget, { caller: CALLER, probe })).resolves.toEqual([id(4)])
  expect(Object.fromEntries(held)).toEqual(without(initial, id(4)))
  expect(released.sort()).toEqual([id(1), id(3), id(4)].sort())
})

test('TRACK-31 the saving session and a session with pending cleanup are never evicted', async () => {
  const pending = { v: 1, session_id: id(2), entries: [] }
  const initial = {
    [`h:${CALLER}`]: { v: 1, session_id: CALLER, retentionOnly: true, closedAt: 1 },
    [`s:${id(2)}`]: body(id(2), 2000, 2),
    [`cleanup:${id(2)}`]: pending,
    [`s:${id(3)}`]: body(id(3), 2000, 30),
  }
  const { held, store } = memory(initial)
  const { probe, probed } = leases({ [CALLER]: 'closed', [id(2)]: 'closed', [id(3)]: 'closed' })
  const budget = bytesOf({ ...without(initial, id(3)), ...write }) + 1
  await expect(evicting(store, write, budget, { caller: CALLER, probe })).resolves.toEqual([id(3)])
  expect(Object.fromEntries(held)).toEqual(without(initial, id(3)))
  expect(probed).not.toContain(CALLER)
  expect(probed).not.toContain(id(2))
})

test('TRACK-31 with nothing evictable the existing capacity error is thrown and nothing is deleted', async () => {
  const initial = {
    [`s:${CALLER}`]: body(CALLER, 2000, 1),
    [`s:${id(1)}`]: body(id(1), 2000, 2),
    [`s:${id(2)}`]: body(id(2), 2000, 3),
    [`cleanup:${id(2)}`]: { v: 1, session_id: id(2), entries: [] },
    [`s:${id(3)}`]: { v: 1, session_id: id(9), savedAt: 4, ledger: EMPTY }, // ambiguous identity
  }
  const { held, store } = memory(initial)
  const { probe } = leases({ [CALLER]: 'closed', [id(1)]: 'live', [id(2)]: 'closed', [id(3)]: 'closed' })
  const replacement = { [`s:${CALLER}`]: body(CALLER, 2500, 5) }
  await expect(evicting(store, replacement, bytesOf({ ...initial, ...replacement }) - 10, { caller: CALLER, probe })).rejects.toThrow(CAPACITY)
  expect(Object.fromEntries(held)).toEqual(initial)
})

test('TRACK-31 an eviction interrupted after its intent is finished by the existing recovery path', async () => {
  const victim = id(4)
  const initial = {
    [`r:${victim}:legacy-head-x`]: { v: 1, session_id: victim, kind: 'legacy-head', value: 'q'.repeat(1500) },
    [`h:${victim}`]: { v: 1, session_id: victim, retentionOnly: true, closedAt: Date.now() - 1000 },
    [`s:${victim}`]: body(victim, 2000, Date.now() - 2000),
    [`s:${id(5)}`]: body(id(5), 2000, Date.now()),
  }
  const { held, store, logs } = memory(initial, { failDelete: `h:${victim}` })
  const { probe } = leases({ [victim]: 'closed', [id(5)]: 'live' })
  const budget = bytesOf({ ...without(initial, victim), ...write }) + 1
  // Round 1: the interrupted candidate is logged and kept; the remaining (live) one is not evictable.
  await expect(evicting(store, write, budget, { caller: CALLER, probe })).rejects.toThrow(CAPACITY)
  expect(logs.some(line => line.startsWith(`track: eviction keeps ${victim}: `) && line.includes('interrupted deleting'))).toBe(true)
  // Crash state: the durable intent is published and the body is still present.
  expect(held.has(`cleanup:${victim}`)).toBe(true)
  expect(held.has(`r:${victim}:legacy-head-x`)).toBe(false)
  expect(held.has(`s:${victim}`)).toBe(true)
  held.set('cleanup', { v: 1, lastAttempt: Date.now(), cursor: '' })
  await cleanupRecords(store, CALLER, probe)
  expect([...held.keys()].filter(key => key.includes(victim))).toEqual([])
  expect(held.get(`s:${id(5)}`)).toEqual(initial[`s:${id(5)}`])
})

test('TRACK-31 a save past the budget evicts the oldest closed session and keeps both indexes consistent', async ($, on) => {
  const sessions = [id(1), id(2), id(3), id(4)]
  const initial: Record<string, unknown> = { cleanup: { v: 1, lastAttempt: Date.now(), cursor: '' } }
  const saved: Record<string, unknown> = {}
  const states: Record<string, 'live' | 'closed'> = {}
  sessions.forEach((session, index) => {
    const savedAt = 4000 - index * 1000 // id(4) is the oldest
    initial[`s:${session}`] = body(session, 800000, savedAt)
    saved[session] = { at: savedAt, bytes: 800100, unfinished: false }
    states[session] = 'closed'
  })
  initial.saved = saved
  atomStore(on, 'ledger', EMPTY)
  const store = pluginStore(on, initial, undefined, { guardStates: states })
  on('session.id', () => ({ value: SESSION }))
  const result = JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result))
  expect(result.ok).toBe(true)
  expect(store.held.has(`s:${id(4)}`)).toBe(false)
  expect(store.held.has(`cleanup:${id(4)}`)).toBe(false)
  for (const session of [id(1), id(2), id(3)]) expect(store.held.get(`s:${session}`)).toEqual(initial[`s:${session}`])
  const index = store.held.get('saved') as Record<string, unknown>
  expect(Object.keys(index).sort()).toEqual([id(1), id(2), id(3), SESSION].sort())
  const sizes = (store.held.get('capacitySizes') as { sizes: Record<string, number> }).sizes
  expect(Object.hasOwn(sizes, `s:${id(4)}`)).toBe(false)
  expect(Object.hasOwn(sizes, `s:${SESSION}`)).toBe(true)
})

// Round 1 (2026-10-20), refuter finding 1: one failing candidate must not stop eviction.
test('TRACK-31 a candidate whose eviction throws is kept and the next candidate is evicted', async () => {
  const [b, c, source] = [id(1), id(2), id(7)]
  const initial = {
    [`s:${b}`]: body(b, 2000, 1),
    [`r:${b}:session-switch-x`]: { v: 1, session_id: b, kind: 'session-switch', value: { source_session: source, ledger: { session_id: source } } },
    [`s:${c}`]: body(c, 2000, 2),
  }
  const { held, store, logs } = memory(initial)
  const { probe, released } = leases({ [b]: 'closed', [c]: 'closed', [source]: 'error' })
  const budget = bytesOf({ ...without(initial, c), ...write }) + 1
  await expect(evicting(store, write, budget, { caller: CALLER, probe })).resolves.toEqual([c])
  expect(Object.fromEntries(held)).toEqual(without(initial, c))
  expect(logs.some(line => line.startsWith(`track: eviction keeps ${b}: `))).toBe(true)
  expect(released).toContain(b)
})

// Round 1, refuter finding 2: no deletion when evicting every candidate cannot make room.
test('TRACK-31 a write larger than every evictable byte throws the capacity error and deletes nothing', async () => {
  const initial = { [`s:${id(1)}`]: body(id(1), 2000, 1), [`s:${id(2)}`]: body(id(2), 2000, 2) }
  const { held, store } = memory(initial)
  const { probe } = leases({ [id(1)]: 'closed', [id(2)]: 'closed' })
  const huge = { [`s:${CALLER}`]: body(CALLER, 20000, 5000) }
  await expect(evicting(store, huge, bytesOf(huge) - 10, { caller: CALLER, probe })).rejects.toThrow(CAPACITY)
  expect(Object.fromEntries(held)).toEqual(initial)
})

// Round 1, refuter finding 3: pins for existing exclusions.
test('TRACK-31 sessions with conflict-recovery records are never evicted', async () => {
  const initial = {
    [`s:${id(1)}`]: body(id(1), 2000, 1),
    [`r:${id(1)}:conflict-x`]: { v: 1, session_id: id(1), kind: 'conflict', value: 'c' },
    [`s:${id(2)}`]: body(id(2), 2000, 2),
    [`r:${id(2)}:cleanup-conflict-x`]: { v: 1, session_id: id(2), kind: 'cleanup-conflict', value: 'c' },
    [`s:${id(3)}`]: body(id(3), 2000, 3),
  }
  const { held, store } = memory(initial)
  const { probe, probed } = leases({ [id(1)]: 'closed', [id(2)]: 'closed', [id(3)]: 'closed' })
  const budget = bytesOf({ ...without(initial, id(3)), ...write }) + 1
  await expect(evicting(store, write, budget, { caller: CALLER, probe })).resolves.toEqual([id(3)])
  expect(Object.fromEntries(held)).toEqual(without(initial, id(3)))
  expect(probed).not.toContain(id(1))
  expect(probed).not.toContain(id(2))
})

test('TRACK-31 a protected (migration target) session is never evicted', async () => {
  const initial = { [`s:${id(1)}`]: body(id(1), 2000, 1), [`s:${id(2)}`]: body(id(2), 2000, 2) }
  const { held, store } = memory(initial)
  const { probe, probed } = leases({ [id(1)]: 'closed', [id(2)]: 'closed' })
  const budget = bytesOf({ ...without(initial, id(2)), ...write }) + 1
  await expect(evicting(store, write, budget, { caller: CALLER, protect: [id(1)], probe })).resolves.toEqual([id(2)])
  expect(Object.fromEntries(held)).toEqual(without(initial, id(2)))
  expect(probed).not.toContain(id(1))
})

test('TRACK-31 a recent expiry intent is still refused for a non-owner; only an eviction intent skips the TTL', async () => {
  const victim = id(6)
  const record = body(victim, 10, Date.now())
  const entries = [{ key: `s:${victim}`, checksum: await checksumOf(record), bytes: entryBytes(`s:${victim}`, record) }]
  const expiry = { v: 2, mode: 'expiry', session_id: victim, closedAt: Date.now() - 1000, entries }
  const recent = memory({ [`s:${victim}`]: record, [`cleanup:${victim}`]: expiry })
  const { probe } = leases({ [victim]: 'closed' })
  await expect(recoverCleanup(recent.store, victim, { probe })).rejects.toThrow('cleanup expiry pending: ambiguous durable intent')
  expect(Object.fromEntries(recent.held)).toEqual({ [`s:${victim}`]: record, [`cleanup:${victim}`]: expiry })
  const eviction = { ...expiry, mode: 'eviction' }
  const evicted = memory({ [`s:${victim}`]: record, [`cleanup:${victim}`]: eviction })
  await expect(recoverCleanup(evicted.store, victim, { probe })).resolves.toBe(true)
  expect(Object.fromEntries(evicted.held)).toEqual({})
})

// Lead takeover, refuter round 2 (medium): a live candidate never counts as
// freeable space, so a write that fits only if a live session also went
// deletes nothing.
test('TRACK-31 a write that fits only by also evicting a live session throws and deletes nothing', async () => {
  const [closed, live] = [id(1), id(2)]
  const initial = { [`s:${closed}`]: body(closed, 2000, 1), [`s:${live}`]: body(live, 2000, 2) }
  const { held, store } = memory(initial)
  const { probe, released } = leases({ [closed]: 'closed', [live]: 'live' })
  const budget = bytesOf(write) + 1
  expect(bytesOf({ ...without(initial, closed), ...write })).toBeGreaterThanOrEqual(budget)
  await expect(evicting(store, write, budget, { caller: CALLER, probe })).rejects.toThrow(CAPACITY)
  expect(Object.fromEntries(held)).toEqual(initial)
  expect(released.sort()).toEqual([closed, live].sort())
})

// Lead takeover, refuter round 3. This probe models writer-lock.py guard mode:
// a second guard on a session whose CLOSED guard is still held reports live.
const flockLeases = (states: Record<string, Lease>) => {
  const locked = new Set<string>()
  const released: string[] = []
  const probe = async (session: string) => {
    if (states[session] === 'error') throw new Error('lease ambiguous')
    if (states[session] !== 'closed' || locked.has(session)) return { state: 'live' as const, release: async () => { released.push(session) } }
    locked.add(session)
    return { state: 'closed' as const, release: async () => { released.push(session); locked.delete(session) } }
  }
  return { probe, released, locked }
}
const switchArchive = (owner: string, source: unknown) => ({ v: 1, session_id: owner, kind: 'session-switch', value: { source_session: source, ledger: { session_id: source } } })

test('TRACK-31 a /clear chain evicts both sessions when the newer one archives the older one', async () => {
  const [older, newer] = [id(1), id(2)]
  const initial = { [`s:${older}`]: body(older, 2000, 1), [`s:${newer}`]: body(newer, 2000, 2), [`r:${newer}:session-switch-x`]: switchArchive(newer, older) }
  const { held, store } = memory(initial)
  const { probe, locked } = flockLeases({ [older]: 'closed', [newer]: 'closed' })
  await expect(evicting(store, write, bytesOf(write) + 1, { caller: CALLER, probe })).resolves.toEqual([older, newer])
  expect(Object.fromEntries(held)).toEqual({})
  expect([...locked]).toEqual([])
})

test('TRACK-31 a switch source that is unknown, the saving session, or live keeps older history when the write cannot fit', async () => {
  for (const source of ['not-a-session', CALLER, id(7)]) {
    const [older, newer] = [id(1), id(2)]
    const initial = { [`s:${older}`]: body(older, 2000, 1), [`s:${newer}`]: body(newer, 2000, 2), [`r:${newer}:session-switch-x`]: switchArchive(newer, source) }
    const { held, store } = memory(initial)
    const { probe, locked } = flockLeases({ [older]: 'closed', [newer]: 'closed', [CALLER]: 'live', [id(7)]: 'live' })
    await expect(evicting(store, write, bytesOf(write) + 1, { caller: CALLER, probe })).rejects.toThrow(CAPACITY)
    expect(Object.fromEntries(held)).toEqual(initial)
    expect([...locked]).toEqual([])
  }
})

test('TRACK-31 each evicted record is deleted while its session guard is held', async () => {
  const [a, b, c] = [id(1), id(2), id(3)]
  const initial = {
    [`s:${a}`]: body(a, 2000, 1), [`h:${a}`]: { v: 1, session_id: a, retentionOnly: true, closedAt: 1 },
    [`s:${b}`]: body(b, 2000, 2), [`r:${b}:legacy-head-x`]: { v: 1, session_id: b, kind: 'legacy-head', value: 'q'.repeat(500) },
    [`s:${c}`]: body(c, 2000, 3),
  }
  const { held, store } = memory(initial)
  const { probe, locked } = flockLeases({ [a]: 'closed', [b]: 'closed', [c]: 'closed' })
  const unguarded: string[] = []
  const remove = store.delete
  store.delete = async key => {
    if (/^[shr]:/.test(key) && !locked.has(key.split(':')[1])) unguarded.push(key)
    await remove(key)
  }
  await expect(evicting(store, write, bytesOf({ [`s:${c}`]: initial[`s:${c}`], ...write }) + 1, { caller: CALLER, probe })).resolves.toEqual([a, b])
  expect(unguarded).toEqual([])
  expect(Object.keys(Object.fromEntries(held))).toEqual([`s:${c}`])
  expect([...locked]).toEqual([])
})

// Refuter round 4 pins for existing behaviour.
test('TRACK-31 a deletion-time failure keeps that candidate and eviction continues with the next ones', async () => {
  const [a, b, c] = [id(1), id(2), id(3)]
  const initial = { [`s:${a}`]: body(a, 2000, 1), [`h:${a}`]: { v: 1, session_id: a, retentionOnly: true, closedAt: 1 }, [`s:${b}`]: body(b, 2000, 2), [`s:${c}`]: body(c, 2000, 3) }
  const { held, store } = memory(initial, { failDelete: `h:${a}` })
  const { probe, locked } = flockLeases({ [a]: 'closed', [b]: 'closed', [c]: 'closed' })
  // Fits once two of the three 2000-byte sessions are gone.
  const budget = bytesOf({ [`s:${a}`]: initial[`s:${a}`], [`h:${a}`]: initial[`h:${a}`], ...write }) + 600
  await expect(evicting(store, write, budget, { caller: CALLER, probe })).resolves.toEqual([b, c])
  expect(held.has(`s:${a}`)).toBe(true)
  expect([...locked]).toEqual([])
})

test('TRACK-31 a switch source guard taken at confirmation is held through deletion, not probed again', async () => {
  const [older, newer, source] = [id(1), id(2), id(7)]
  const initial = { [`s:${older}`]: body(older, 2000, 1), [`s:${newer}`]: body(newer, 2000, 2), [`r:${newer}:session-switch-x`]: switchArchive(newer, source) }
  const { held, store } = memory(initial)
  const { probe: flock, locked } = flockLeases({ [older]: 'closed', [newer]: 'closed', [source]: 'closed' })
  // The source's owner returns as soon as the evictor lets go of it.
  let sourceProbes = 0
  const probe = async (session: string) => {
    if (session !== source) return flock(session)
    if (++sourceProbes > 1) return { state: 'live' as const, release: async () => {} }
    return flock(session)
  }
  await expect(evicting(store, write, bytesOf(write) + 1, { caller: CALLER, probe })).resolves.toEqual([older, newer])
  expect(Object.fromEntries(held)).toEqual({})
  expect(sourceProbes).toBe(1)
  expect([...locked]).toEqual([])
})
