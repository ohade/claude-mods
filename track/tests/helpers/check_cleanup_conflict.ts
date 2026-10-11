// FIXTURE, TRACK-21 (2026-10-11): rollback must not overwrite an unexpected
// later value after read-back detects a store mutation.
import assert from 'node:assert/strict'
import { cleanupRecords } from '../../hooks/retention'
import type { RetentionStore } from '../../hooks/retention'
const session = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const key = `h:${session}`
const body = { v: 1, ledger: { questions: ['original'] } }
const values = new Map<string, unknown>([[`s:${session}`, body]])
let later: unknown
let corrupt = true
const store: RetentionStore = {
  keys: async () => [...values.keys()], get: async key => values.get(key),
  set: async (name, value) => {
    values.set(name, JSON.parse(JSON.stringify(value)))
    if (name === key && corrupt) {
      corrupt = false
      later = { ...(value as object), changedByStore: true }
      values.set(name, later)
    }
  },
  delete: async key => { values.delete(key) }, log: () => {},
}
const probe = async () => ({ state: 'closed' as const, release: async () => {} })
await assert.rejects(cleanupRecords(store, '11111111-2222-4333-8444-555555555555', probe))
assert.deepEqual(values.get(key), later)
assert.deepEqual(values.get(`s:${session}`), body)
await assert.rejects(cleanupRecords(store, '11111111-2222-4333-8444-555555555555', probe), /could not verify/)
assert.deepEqual(values.get(key), later)
console.log('PASS cleanup rollback keeps an unexpected later value and its durable journal')
