// FIXTURE: TRACK-31 L3, real capacity eviction with caller-owned guard identities.
import assert from 'node:assert/strict'
import { ensureCapacity } from '../../hooks/retention'
import type { RetentionStore } from '../../hooks/retention'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const victim = id(1)
const source = id(2)
const blocked = id(3)
const caller = id(99)
type Scenario = 'success' | 'rejected' | 'callback-error' | 'under-budget' | 'live-borrow'
type HeldGuard = { state: 'closed' | 'live'; release: () => Promise<void> }
const body = (session: string) => ({ session_id: session, savedAt: 1, padding: 'p'.repeat(4000) })

const exercise = async (scenario: Scenario): Promise<void> => {
  const initial: Record<string, unknown> = {
    [`s:${victim}`]: body(victim),
    [`r:${victim}:source`]: { session_id: victim, kind: 'session-switch', value: { source_session: source } },
    ...(scenario === 'rejected' && {
      [`r:${victim}:blocked`]: { session_id: victim, kind: 'session-switch', value: { source_session: blocked } },
    }),
  }
  const values = new Map(Object.entries(structuredClone(initial)))
  const held = new Set([source])
  const acquired: string[] = []
  const released: string[] = []
  const probed: string[] = []
  const violations: string[] = []
  const callbacks: string[] = []
  let borrowedReleases = 0
  const borrowed: HeldGuard = { state: scenario === 'live-borrow' ? 'live' : 'closed', release: async () => {
    borrowedReleases++
    held.delete(source)
  } }
  const heldGuards = new Map([[source, borrowed]])
  const entriesBefore = [...heldGuards]
  const borrowedStateBefore = borrowed.state
  const store: RetentionStore = {
    get: async key => values.get(key),
    keys: async () => [...values.keys()],
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    delete: async key => {
      if (/^[shr]:/.test(key)) {
        if (!held.has(victim) || !held.has(source)) violations.push(`guard missing during deletion: ${key}`)
        if (scenario === 'live-borrow' || scenario === 'rejected') violations.push(`unsafe deletion: ${key}`)
      }
      values.delete(key)
    },
    log: () => {},
  }
  const options = {
    caller, heldGuards,
    probe: async (session: string): Promise<HeldGuard> => {
      probed.push(session)
      // The importer already owns source's flock: another probe reports LIVE.
      if (held.has(session) || session === blocked) return { state: 'live', release: async () => { released.push(`live:${session}`) } }
      held.add(session)
      acquired.push(session)
      return { state: 'closed', release: async () => {
        if (!held.delete(session)) violations.push(`double release: ${session}`)
        released.push(session)
      } }
    },
    afterEviction: async (session: string) => {
      callbacks.push(session)
      if (!held.has(source) || !held.has(victim)) violations.push('guards missing at eviction callback')
      if (scenario === 'callback-error') throw new Error('injected afterEviction error')
    },
  }
  let result: string[] | undefined
  let failure: unknown
  try { result = await ensureCapacity(store, { [`s:${caller}`]: body(caller) }, scenario === 'under-budget' ? 20000 : 5000, options) }
  catch (error) { failure = error }

  if (scenario === 'success') {
    assert.equal(failure, undefined, 'borrowed CLOSED source must authorize eviction without re-probing its held lock')
    assert.deepEqual(result, [victim])
  } else if (scenario === 'callback-error') {
    assert.match(String(failure), /injected afterEviction error/, 'borrowed CLOSED source must reach the failing callback')
  } else if (scenario === 'under-budget') {
    assert.equal(failure, undefined)
    assert.deepEqual(result, [])
    assert.deepEqual(probed, [], 'under-budget check must not probe')
  } else {
    assert.match(String(failure), /capacity:/, 'rejected or LIVE source must refuse capacity')
  }
  assert.equal(borrowedReleases, 0, 'eviction must never release a borrowed guard')
  assert.deepEqual([...heldGuards], entriesBefore, 'eviction must not mutate the caller guard map')
  assert.equal(heldGuards.get(source), borrowed, 'caller guard identity must remain unchanged')
  assert.equal(borrowed.state, borrowedStateBefore, 'caller guard state must remain unchanged')
  assert.deepEqual(violations, [], 'deletions and callbacks must hold all CLOSED guards')
  assert.deepEqual(released.filter(session => !session.startsWith('live:')).sort(), [...acquired].sort(), 'every inner CLOSED acquisition must release exactly once')
  assert.deepEqual([...held], [source], 'only the importer-owned guard must remain held')
  if (scenario === 'success' || scenario === 'callback-error') {
    assert.deepEqual([...values], [], 'successful deletion must finish its intent')
    assert.deepEqual(callbacks, [victim])
    assert.deepEqual(probed, [victim], 'borrowed source must not be re-probed')
  } else assert.deepEqual(Object.fromEntries(values), initial, 'refusal or early return must preserve history bytes')
  if (scenario === 'rejected') assert.deepEqual(probed, [victim, blocked], 'rejection must preserve the borrowed guard while releasing the candidate')
  if (scenario === 'live-borrow') assert.deepEqual(probed, [victim, source], 'a supplied LIVE guard must not authorize deletion')
  await borrowed.release()
  assert.equal(borrowedReleases, 1, 'only the importer releases its borrowed guard')
}

let failures = 0
for (const scenario of ['success', 'rejected', 'callback-error', 'under-budget', 'live-borrow'] as const) {
  try { await exercise(scenario); console.log(`PASS borrowed guards: ${scenario}`) }
  catch (error) { failures++; console.error(`FAIL borrowed guards: ${scenario}: ${String(error)}`) }
}
if (failures) process.exitCode = 1
