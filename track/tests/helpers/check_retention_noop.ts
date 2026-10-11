// FIXTURE, TRACK-21 (2026-10-11): a cursor visit is not a verified mutation.
import assert from 'node:assert/strict'
import { cleanupRecords } from '../../hooks/retention'
import type { RetentionStore } from '../../hooks/retention'

const caller = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const target = '11111111-2222-4333-8444-555555555555'
for (const state of ['live', 'closed'] as const) {
  const record = { v: 1, session_id: target, closedAt: Date.now(), ledger: {} }
  const values = new Map<string, unknown>([[`s:${target}`, record]])
  const store: RetentionStore = {
    get: async key => values.get(key), keys: async () => [...values.keys()],
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    delete: async key => { values.delete(key) }, log: () => {},
  }
  await cleanupRecords(store, caller, async () => ({ state, release: async () => {} }))
  assert.equal((values.get('cleanup') as any)?.lastCleanup, undefined, `${state} no-op cannot advance lastCleanup`)
  assert.deepEqual(values.get(`s:${target}`), record)
}
console.log('PASS live and unchanged closed visits do not acknowledge cleanup work')
