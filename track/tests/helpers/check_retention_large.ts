// FIXTURE, TRACK-21 refuter 4 (2026-10-11): no full-body journal fits
// a 1.2 MB closed body alongside 1.8 MB of protected data.
import assert from 'node:assert/strict'
import { cleanupRecords, CLOSED_TTL } from '../../hooks/retention'
import type { RetentionStore } from '../../hooks/retention'
const caller = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const target = '11111111-2222-4333-8444-555555555555'
const originalNow = Date.now
let now = 10000000000
Date.now = () => now
try {
  const body = { v: 1, session_id: target, ledger: { text: 'x'.repeat(1200000) } }
  const protectedValue = { text: 'p'.repeat(1800000) }
  const values = new Map<string, unknown>([[`s:${target}`, body], ['protected', protectedValue]])
  const store: RetentionStore = { get: async key => values.get(key), keys: async () => [...values.keys()],
    set: async (key, value) => { values.set(key, structuredClone(value)); assert.ok(new TextEncoder().encode(JSON.stringify(Object.fromEntries(values))).length < 4 * 1024 * 1024, 'each write fits the physical budget') },
    delete: async key => { values.delete(key) }, log: () => {} }
  const closed = async () => ({ state: 'closed' as const, release: async () => {} })
  await cleanupRecords(store, caller, closed)
  assert.deepEqual((values.get(`s:${target}`) as any).ledger, body.ledger)
  assert.equal((values.get(`h:${target}`) as any)?.closedAt ?? (values.get(`s:${target}`) as any)?.closedAt, now, 'large closed history must start its TTL')
  now += CLOSED_TTL
  await cleanupRecords(store, caller, closed)
  assert.equal(values.has(`s:${target}`), false, 'large closed history must expire at its TTL')
  assert.deepEqual(values.get('protected'), protectedValue)
} finally { Date.now = originalNow }
console.log('PASS large closed session stamps and expires in a nearly full store')
