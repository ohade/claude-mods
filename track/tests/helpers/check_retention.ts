// FIXTURE, TRACK-21 (2026-10-11): an interrupted multi-record expiry must
// keep a durable intent so a fresh cleanup call can finish the deletion.
import assert from 'node:assert/strict'
import { CLOSED_TTL, cleanupRecords } from '../../hooks/retention'
import type { RetentionStore } from '../../hooks/retention'

const session = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const caller = '11111111-2222-4333-8444-555555555555'
const body = { v: 1, session_id: session, closedAt: Date.now() - CLOSED_TTL - 1000, ledger: { questions: ['keep'] } }
const head = { v: 1, session_id: session, closedAt: body.closedAt, revision: 2 }
const values = new Map<string, unknown>([[`s:${session}`, body], [`h:${session}`, head]])
values.set(`r:${session}:old`, { v: 1, session_id: session, value: 'expired archive' } as any)
let guardHeld = false
let failHead = true
const store: RetentionStore = {
  keys: async () => [...values.keys()],
  get: async key => values.get(key),
  set: async (key, value) => {
    if (key.startsWith(`s:${session}`) || key.startsWith(`h:${session}`)) assert.equal(guardHeld, true)
    values.set(key, JSON.parse(JSON.stringify(value)))
  },
  delete: async key => {
    if (key === `h:${session}` && failHead) { failHead = false; throw new Error('head deletion refused') }
    if (key.startsWith(`s:${session}`) || key.startsWith(`h:${session}`)) assert.equal(guardHeld, true)
    values.delete(key)
  },
  log: () => {},
}
const probe = async () => {
  guardHeld = true
  return { state: 'closed' as const, release: async () => { guardHeld = false } }
}
await assert.rejects(cleanupRecords(store, caller, probe), /head deletion refused/)
assert.equal(values.has(`r:${session}:old`), false)
assert.equal(values.has(`cleanup:${session}`), true)
assert.equal(guardHeld, false)
// The next call has no module-memory state. Recovery finishes committed expiry.
await cleanupRecords(store, caller, probe)
assert.equal(values.has(`s:${session}`), false)
assert.equal(values.has(`h:${session}`), false)
assert.equal(values.has(`cleanup:${session}`), false)
assert.equal(guardHeld, false)
console.log('PASS fresh cleanup finishes interrupted expiry under a retained target guard')
