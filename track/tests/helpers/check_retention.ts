// FIXTURE, TRACK-21 (2026-10-11): an interrupted multi-record expiry must
// retain enough durable data for a fresh cleanup call to restore its rollback.
import assert from 'node:assert/strict'
import { CLOSED_TTL, cleanupRecords } from '../../hooks/retention'
import type { RetentionStore } from '../../hooks/retention'

const session = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const caller = '11111111-2222-4333-8444-555555555555'
const body = { v: 1, session_id: session, closedAt: Date.now() - CLOSED_TTL - 1000, ledger: { questions: ['keep'] } }
const head = { v: 1, session_id: session, closedAt: body.closedAt, revision: 2 }
const values = new Map<string, unknown>([[`s:${session}`, body], [`h:${session}`, head]])
let guardHeld = false
let failHead = true
let failRollback = true
const store: RetentionStore = {
  keys: async () => [...values.keys()],
  get: async key => values.get(key),
  set: async (key, value) => {
    if (key === `s:${session}` && failRollback) { failRollback = false; throw new Error('rollback temporarily unavailable') }
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
await assert.rejects(cleanupRecords(store, caller, probe), /rollback pending/)
assert.equal(guardHeld, false)
// The next call has no module-memory rollback state. Recovery is durable.
await cleanupRecords(store, caller, probe)
assert.deepEqual(values.get(`s:${session}`), body)
assert.deepEqual(values.get(`h:${session}`), head)
assert.equal(guardHeld, false)
console.log('PASS fresh cleanup restores an interrupted expiry under a retained target guard')
