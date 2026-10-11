// FIXTURE, TRACK-21 refuter 4 (2026-10-11): blocked recovery records
// must not consume every expiry slot on each save.
import assert from 'node:assert/strict'
import { cleanupRecords, CLOSED_TTL } from '../../hooks/retention'
import type { RetentionStore } from '../../hooks/retention'
const caller = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const target = '11111111-2222-4333-8444-555555555555'
const values = new Map<string, unknown>([[`s:${target}`, { v: 1, session_id: target, closedAt: Date.now() - CLOSED_TTL - 1000, ledger: {} }]])
for (let n = 0; n < 8; n++) values.set(`cleanup:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, { v: 1, ambiguous: true })
const store: RetentionStore = { keys: async () => [...values.keys()], get: async key => values.get(key),
  set: async (key, value) => { values.set(key, structuredClone(value)) }, delete: async key => { values.delete(key) }, log: () => {} }
await cleanupRecords(store, caller, async session => ({ state: session === target ? 'closed' : 'live', release: async () => {} }))
assert.equal(values.has(`s:${target}`), false, 'eight live pending journals must not starve closed expiry')
assert.equal([...values.keys()].filter(key => key.startsWith('cleanup:')).length, 8, 'all blocked journals remain byte-identical')
console.log('PASS blocked journals leave expiry slots for closed history')
