// FIXTURE, TRACK-21 (2026-10-11): verified-work metadata must not defeat hourly throttling.
import assert from 'node:assert/strict'
import { cleanupRecords } from '../../hooks/retention'
import type { RetentionStore } from '../../hooks/retention'
const caller = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const target = '11111111-2222-4333-8444-555555555555'
const originalNow = Date.now
let now = 10000000000
Date.now = () => now
try {
  for (const state of ['live', 'closed'] as const) {
    const record = { v: 1, session_id: target, closedAt: now, ledger: {} }
    const values = new Map<string, unknown>([[`s:${target}`, record]])
    const store: RetentionStore = { get: async key => values.get(key), keys: async () => [...values.keys()],
      set: async (key, value) => { values.set(key, structuredClone(value)) }, delete: async key => { values.delete(key) }, log: () => {} }
    let probes = 0
    const probe = async () => { probes++; return { state, release: async () => {} } }
    await cleanupRecords(store, caller, probe)
    for (let n = 0; n < 4; n++) await cleanupRecords(store, caller, probe)
    assert.equal(probes, 1, `${state} no-op attempts must be throttled for an hour`)
    assert.equal((values.get('cleanup') as any).lastCleanup, undefined)
    now += 3599999
    await cleanupRecords(store, caller, probe)
    assert.equal(probes, 1)
    now++
    await cleanupRecords(store, caller, probe)
    assert.equal(probes, 2)
    assert.deepEqual(values.get(`s:${target}`), record)
  }
} finally { Date.now = originalNow }
console.log('PASS hourly attempts without claiming verified cleanup work')
