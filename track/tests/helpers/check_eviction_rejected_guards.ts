// FIXTURE, TRACK-31 L13 (2026-10-22): real ensureCapacity with in-memory flock ownership.
import assert from 'node:assert/strict'
import { ensureCapacity } from '../../hooks/retention'
import type { RetentionStore } from '../../hooks/retention'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const first = id(1)
const rejected = id(2)
const last = id(3)
const sharedSource = id(4)
const newSource = id(5)
const blockedSource = id(6)
const caller = id(99)
const body = (session: string, savedAt: number) => ({ session_id: session, savedAt, padding: 'p'.repeat(4000) })
const archive = (session: string, source: unknown) => ({ session_id: session, kind: 'session-switch', value: { source_session: source } })
const owns = (key: string, session: string) => key === `s:${session}` || key === `h:${session}` || key.startsWith(`r:${session}:`)
const bytesOf = (records: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(records)).length
type Rejection = 'identity' | 'ambiguous' | 'live' | 'probe-error' | 'release-error'

const exercise = async (rejection: Rejection): Promise<void> => {
  const initial: Record<string, unknown> = {
    [`s:${first}`]: body(first, 1),
    [`r:${first}:shared`]: archive(first, sharedSource),
    [`s:${rejected}`]: body(rejection === 'identity' ? caller : rejected, 2),
    // Reuse both a prior candidate's own guard and its archive-source guard.
    [`r:${rejected}:prior`]: archive(rejected, first),
    [`r:${rejected}:shared`]: archive(rejected, sharedSource),
    [`r:${rejected}:new`]: archive(rejected, newSource),
    [`r:${rejected}:blocked`]: archive(rejected, rejection === 'live' || rejection === 'probe-error' ? blockedSource : 'ambiguous'),
    [`s:${last}`]: body(last, 3),
  }
  const values = new Map(Object.entries(structuredClone(initial)))
  const replacement = { [`s:${caller}`]: body(caller, 4) }
  const remaining = Object.fromEntries(Object.entries(initial).filter(([key]) => !owns(key, first) && !owns(key, last)))
  const budget = bytesOf({ ...remaining, ...replacement }) + 1
  assert.ok(bytesOf({ ...initial, ...replacement }) >= budget, 'fixture must require eviction')
  for (const victim of [first, last]) {
    const withoutOne = Object.fromEntries(Object.entries(initial).filter(([key]) => !owns(key, victim)))
    assert.ok(bytesOf({ ...withoutOne, ...replacement }) >= budget, 'fixture must require both accepted candidates')
  }

  const held = new Set<string>()
  const acquired: string[] = []
  const released: string[] = []
  const releaseAttempts: string[] = []
  const probed: string[] = []
  const logs: string[] = []
  const deletionViolations: string[] = []
  const deleted: string[] = []
  let heldAtLastProbe: string[] | undefined
  let releaseFailed = false
  const probe = async (session: string) => {
    probed.push(session)
    if (session === last) heldAtLastProbe = [...held].sort()
    if (session === blockedSource && rejection === 'probe-error') throw new Error('injected source probe error')
    // A second flock writer cannot acquire a session already held by this call.
    if (held.has(session) || session === blockedSource && rejection === 'live') {
      return { state: 'live' as const, release: async () => {} }
    }
    held.add(session)
    acquired.push(session)
    return { state: 'closed' as const, release: async () => {
      releaseAttempts.push(session)
      if (rejection === 'release-error' && session === rejected && !releaseFailed) {
        releaseFailed = true
        throw new Error('injected rejected target release error')
      }
      if (!held.delete(session)) deletionViolations.push(`double release: ${session}`)
      released.push(session)
    } }
  }
  const store: RetentionStore = {
    get: async key => values.get(key),
    keys: async () => [...values.keys()],
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    delete: async key => {
      if (/^[shr]:/.test(key)) {
        deleted.push(key)
        const target = key.split(':')[1]!
        if (!held.has(target)) deletionViolations.push(`target not held during delete: ${key}`)
        if (target === first && !held.has(sharedSource)) deletionViolations.push(`archive source not held during delete: ${key}`)
        if (target === rejected) deletionViolations.push(`rejected candidate deleted: ${key}`)
      }
      values.delete(key)
    },
    log: message => { logs.push(message) },
  }

  const evicted = await ensureCapacity(store, replacement, budget, { caller, probe })
  // Assert outside callbacks: production deliberately catches probe/store errors.
  assert.deepEqual(heldAtLastProbe, [first, sharedSource, ...(rejection === 'release-error' ? [rejected] : [])].sort(),
    'rejected candidate must release only its new CLOSED guards before the next candidate probe')
  assert.deepEqual(evicted, [first, last], 'capacity must be made by both accepted candidates')
  assert.deepEqual(deletionViolations, [], 'accepted deletion must keep target and archive-source guards')
  assert.deepEqual(deleted.sort(), Object.keys(initial).filter(key => owns(key, first) || owns(key, last)).sort())
  assert.deepEqual(Object.fromEntries(values), remaining, 'rejected history must stay intact and intents must finish')
  assert.equal(held.size, 0, 'all acquired guards must eventually release')
  assert.deepEqual([...released].sort(), [...acquired].sort(), 'each acquisition must release exactly once')
  assert.equal(probed.filter(session => session === first).length, 1, 'prior accepted guard must be reused')
  assert.equal(probed.filter(session => session === sharedSource).length, 1, 'shared archive-source guard must be reused')
  assert.ok(logs.some(message => message.includes(`eviction keeps ${rejected}`)), 'rejection must be logged')
  if (rejection === 'identity') assert.ok(!acquired.includes(newSource), 'identity rejection must precede source acquisition')
  else assert.ok(acquired.includes(newSource), 'fixture must acquire a new archive-source guard before rejection')
  if (rejection === 'probe-error') assert.ok(logs.some(message => message.includes('injected source probe error')), 'probe error cause must be logged')
  if (rejection === 'release-error') {
    assert.equal(releaseAttempts.filter(session => session === rejected).length, 2, 'failed release must retain cleanup retry without trusted CLOSED authority')
    assert.ok(logs.some(message => message.includes('guard release failed') && message.includes(rejected) && message.includes('injected rejected target release error')),
      'failed cleanup must log the affected guard and original cause')
  }
}

let failures = 0
for (const rejection of ['identity', 'ambiguous', 'live', 'probe-error', 'release-error'] as const) {
  try { await exercise(rejection); console.log(`PASS rejected guard cleanup: ${rejection}`) }
  catch (error) { failures++; console.error(`FAIL rejected guard cleanup: ${rejection}: ${String(error)}`) }
}
if (failures) process.exitCode = 1
