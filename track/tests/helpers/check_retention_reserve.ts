// FIXTURE, TRACK-21 (2026-10-11): a full save budget must still allow closed history to age.
import assert from 'node:assert/strict'
import { cleanupRecords, CLOSED_TTL } from '../../hooks/retention'
import type { RetentionStore } from '../../hooks/retention'
const caller = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const target = '11111111-2222-4333-8444-555555555555'
const originalNow = Date.now
let now = 10000000000
Date.now = () => now
try {
  const body = { v: 1, session_id: target, ledger: { text: 'x'.repeat(700000) } }
  const values = new Map<string, unknown>([[`s:${target}`, body], ['protected', { text: 'p'.repeat(2300000) }]])
  const protectedBefore = structuredClone(values.get('protected'))
  let maxBytes = 0
  const store: RetentionStore = { get: async key => values.get(key), keys: async () => [...values.keys()],
    set: async (key, value) => { values.set(key, structuredClone(value)); const bytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(values))).length; maxBytes = Math.max(maxBytes, bytes); assert.ok(bytes < 4 * 1024 * 1024, 'every write must stay within physical rollback reserve') },
    delete: async key => { values.delete(key) }, log: () => {} }
  const closed = async () => ({ state: 'closed' as const, release: async () => {} })
  await cleanupRecords(store, caller, closed)
  assert.deepEqual((values.get(`s:${target}`) as any).ledger, body.ledger)
  assert.ok((values.get(`s:${target}`) as any).closedAt === now || (values.get(`h:${target}`) as any)?.closedAt === now, 'first closed sighting must stamp despite the full save budget')
  now += CLOSED_TTL
  await cleanupRecords(store, caller, closed)
  assert.equal(values.has(`s:${target}`), false)
  assert.deepEqual(values.get('protected'), protectedBefore)
  assert.ok(maxBytes < 4 * 1024 * 1024)
} finally { Date.now = originalNow }
console.log('PASS full-store closure, expiry and physical rollback reserve')
