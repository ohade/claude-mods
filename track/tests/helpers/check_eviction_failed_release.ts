// FIXTURE, TRACK-31 L13 (2026-10-22): a failed release is cleanup, never CLOSED authority.
import assert from 'node:assert/strict'
import { ensureCapacity } from '../../hooks/retention'
import type { Guard, RetentionStore } from '../../hooks/retention'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const accepted = id(1)
const rejected = id(2)
const dependent = id(3)
const fallback = id(4)
const source = id(5)
const shared = id(6)
const borrowedSource = id(7)
const caller = id(99)
const body = (session: string, savedAt: number) => ({ session_id: session, savedAt, padding: 'p'.repeat(4000) })
const archive = (session: string, origin: string) => ({ session_id: session, kind: 'session-switch', value: { source_session: origin } })
const owns = (key: string, session: string) => key === `s:${session}` || key === `h:${session}` || key.startsWith(`r:${session}:`)
const bytesOf = (records: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(records)).length
type FailureOrder = 'unlock-live' | 'before-unlock' | 'unlock-closed'
type Acquisition = { session: string; attempts: number; successes: number; guard: Guard }

const exercise = async (order: FailureOrder, withFallback = true): Promise<void> => {
  const initial: Record<string, unknown> = {
    [`s:${accepted}`]: body(accepted, 1),
    [`r:${accepted}:shared`]: archive(accepted, shared),
    [`r:${accepted}:borrowed`]: archive(accepted, borrowedSource),
    [`s:${rejected}`]: body(rejected, 2),
    [`r:${rejected}:prior`]: archive(rejected, accepted),
    [`r:${rejected}:shared`]: archive(rejected, shared),
    [`r:${rejected}:borrowed`]: archive(rejected, borrowedSource),
    [`r:${rejected}:source`]: archive(rejected, source),
    [`r:${rejected}:ambiguous`]: archive(rejected, 'ambiguous'),
    [`s:${dependent}`]: body(dependent, 3),
    [`r:${dependent}:source`]: { ...archive(dependent, source), rows: 'r'.repeat(4000) },
    ...(withFallback && { [`s:${fallback}`]: body(fallback, 4) }),
  }
  const values = new Map(Object.entries(structuredClone(initial)))
  const replacement = { [`s:${caller}`]: body(caller, 5) }
  const needed = withFallback ? fallback : dependent
  const enough = Object.fromEntries(Object.entries(initial).filter(([key]) => !owns(key, accepted) && !owns(key, needed)))
  const budget = bytesOf({ ...enough, ...replacement }) + 1
  for (const victim of [accepted, needed]) {
    const onlyOne = Object.fromEntries(Object.entries(initial).filter(([key]) => !owns(key, victim)))
    assert.ok(bytesOf({ ...onlyOne, ...replacement }) >= budget, 'fixture must require both accepted candidates')
  }

  const held = new Map<string, Guard>()
  const ownerLive = new Set<string>()
  const acquired: Acquisition[] = []
  const probed: string[] = []
  const deleted: string[] = []
  const violations: string[] = []
  const logs: string[] = []
  let borrowedReleases = 0
  const borrowed: Guard = { state: 'closed', release: async () => { borrowedReleases++; held.delete(borrowedSource) } }
  held.set(borrowedSource, borrowed)
  const heldGuards = new Map([[borrowedSource, borrowed]])
  let failed: Acquisition | undefined
  let priorHeldAtDependent = false
  const probe = async (session: string): Promise<Guard> => {
    probed.push(session)
    if (session === dependent) priorHeldAtDependent = held.has(accepted) && held.has(shared) && held.get(borrowedSource) === borrowed
    if (held.has(session) || ownerLive.has(session)) return { state: 'live', release: async () => {} }
    const acquisition: Acquisition = { session, attempts: 0, successes: 0, guard: { state: 'closed', release: async () => {
      acquisition.attempts++
      if (session === source && failed === undefined) {
        failed = acquisition
        if (order !== 'before-unlock') held.delete(session)
        if (order === 'unlock-live') ownerLive.add(session)
        throw new Error(`injected ${order} source release error`)
      }
      // Finishing an old failed release must not unlock a newer acquisition.
      if (held.get(session) === acquisition.guard) held.delete(session)
      acquisition.successes++
    } } }
    acquired.push(acquisition)
    held.set(session, acquisition.guard)
    return acquisition.guard
  }
  const store: RetentionStore = {
    get: async key => values.get(key),
    keys: async () => [...values.keys()],
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    delete: async key => {
      if (/^[shr]:/.test(key)) {
        deleted.push(key)
        const target = key.split(':')[1]!
        if (!held.has(target) || ownerLive.has(target)) violations.push(`target not currently CLOSED: ${key}`)
        const value = values.get(key) as { value?: { source_session?: string } } | undefined
        const origin = value?.value?.source_session
        if (origin !== undefined && (!held.has(origin) || ownerLive.has(origin))) violations.push(`archive source not currently CLOSED: ${key}`)
        if (target === rejected) violations.push(`rejected history deleted: ${key}`)
      }
      values.delete(key)
    },
    log: message => { logs.push(message) },
  }
  let evicted: string[] | undefined
  let failure: unknown
  try { evicted = await ensureCapacity(store, replacement, budget, { caller, probe, heldGuards }) }
  catch (error) { failure = error }

  // Outside callbacks: production catches store and probe failures deliberately.
  assert.deepEqual(violations, [], 'failed-release guard must never authorize unsafe reuse/deletion after unlocking')
  assert.equal(probed.filter(session => session === source).length, 2, 'later source use must obtain a fresh probe after any failed release')
  assert.ok(priorHeldAtDependent, 'rejected cleanup must preserve accepted, shared and borrowed CLOSED guards')
  assert.equal(JSON.stringify(Object.fromEntries([...values].filter(([key]) => owns(key, rejected)))),
    JSON.stringify(Object.fromEntries(Object.entries(initial).filter(([key]) => owns(key, rejected)))), 'rejected history must remain byte-identical')
  if (order !== 'unlock-closed') {
    assert.equal(JSON.stringify(Object.fromEntries([...values].filter(([key]) => owns(key, dependent)))),
      JSON.stringify(Object.fromEntries(Object.entries(initial).filter(([key]) => owns(key, dependent)))), 'dependent history and archives must remain byte-identical')
  }
  if (!withFallback) {
    assert.match(String(failure), /capacity:/, 'without a safe fallback, capacity must refuse')
    assert.deepEqual(deleted, [], 'refusal must not delete any history')
    assert.deepEqual(Object.fromEntries(values), initial, 'refusal must preserve every history byte')
  } else {
    assert.equal(failure, undefined, 'safe CLOSED candidates must make capacity')
    const victims = [accepted, order === 'unlock-closed' ? dependent : fallback]
    assert.deepEqual(evicted, victims, 'only candidates with current CLOSED guards may make capacity')
    assert.deepEqual(deleted.sort(), Object.keys(initial).filter(key => victims.some(session => owns(key, session))).sort())
    assert.deepEqual(Object.fromEntries(values), Object.fromEntries(Object.entries(initial).filter(([key]) => !victims.some(session => owns(key, session)))),
      'safe eviction must finish its intents and keep other history')
  }
  assert.ok(failed !== undefined, 'fixture must inject a source release failure')
  assert.equal(failed.attempts, 2, 'failed release must remain available for outer-finally cleanup retry')
  assert.ok(acquired.every(acquisition => acquisition.successes === 1), 'every acquired guard identity must release successfully once')
  assert.equal(acquired.filter(acquisition => acquisition.session === source).length, order === 'unlock-closed' ? 2 : 1,
    'fresh CLOSED source acquisition must have a distinct guard identity')
  assert.equal(probed.filter(session => session === accepted).length, 1, 'accepted guard must stay trusted')
  assert.equal(probed.filter(session => session === shared).length, 1, 'shared accepted guard must stay trusted')
  assert.equal(probed.filter(session => session === borrowedSource).length, 0, 'borrowed CLOSED source must not be re-probed')
  assert.equal(borrowedReleases, 0, 'eviction must never release the importer borrowed guard')
  assert.deepEqual([...heldGuards], [[borrowedSource, borrowed]], 'caller guard map must stay unchanged')
  assert.deepEqual([...held], [[borrowedSource, borrowed]], 'outer finally must drain every owned guard')
  assert.ok(logs.some(message => message.includes(`guard release failed for ${source}`) && message.includes(`injected ${order} source release error`)),
    'failed cleanup must log its session and original cause')
  await borrowed.release()
}

let failures = 0
for (const [order, withFallback] of [['unlock-live', true], ['unlock-live', false], ['before-unlock', true], ['unlock-closed', true]] as const) {
  try { await exercise(order, withFallback); console.log(`PASS failed-release authority: ${order}, fallback=${withFallback}`) }
  catch (error) { failures++; console.error(`FAIL failed-release authority: ${order}, fallback=${withFallback}: ${String(error)}`) }
}
if (failures) process.exitCode = 1
