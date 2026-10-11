// FIXTURE, TRACK-21 (2026-10-11): compare indexed capacity against actual
// UTF-8 JSON bytes, including shared callers and interrupted index updates.
import assert from 'node:assert/strict'
import { indexedStore, SIZE_INDEX, entryBytes } from '../../hooks/size-index'
import type { RetentionStore } from '../../hooks/retention'

const values = new Map<string, unknown>([['s:foreign', { text: 'שלום 🌍'.repeat(50) }]])
const reads: string[] = []
let refuse = false
const raw: RetentionStore = {
  get: async key => { reads.push(key); return values.get(key) }, keys: async () => [...values.keys()],
  set: async (key, value) => { if (refuse && key === 's:caller') { refuse = false; throw new Error('data write refused') }; values.set(key, structuredClone(value)) },
  delete: async key => { values.delete(key) }, log: () => {},
}
const first = indexedStore(raw)
const second = indexedStore(raw)
const verifyBytes = async () => {
  const sizes = await first.sizes!()
  const measured = 2 + [...sizes.values()].reduce((total, bytes) => total + bytes, 0) + Math.max(0, sizes.size - 1)
  const actual = new TextEncoder().encode(JSON.stringify(Object.fromEntries(values))).length
  assert.equal(measured, actual, 'size index must equal actual UTF-8 store bytes')
}
await verifyBytes()
reads.length = 0
await second.set('s:caller', { text: 'new caller' })
await verifyBytes()
assert.equal(reads.includes('s:foreign'), false, 'warm capacity checks must not reread foreign bodies')
await first.delete('s:caller')
await verifyBytes()
// A fresh process recovers exactly one crash-left key, not every body.
const index = values.get(SIZE_INDEX) as any
values.set(SIZE_INDEX, { ...index, pending: 's:foreign' })
values.set('s:foreign', { text: 'longer revised value'.repeat(500) })
await verifyBytes()
assert.equal((values.get(SIZE_INDEX) as any).pending, undefined)
assert.equal((values.get(SIZE_INDEX) as any).sizes['s:foreign'], entryBytes('s:foreign', values.get('s:foreign')))
refuse = true
await assert.rejects(second.set('s:caller', { text: 'refused' }), /data write refused/)
assert.equal(values.has('s:caller'), false)
await verifyBytes()
assert.equal((values.get(SIZE_INDEX) as any).pending, undefined)
console.log('PASS exact UTF-8 sizes, shared warm reads, crash recovery and refused writes')
