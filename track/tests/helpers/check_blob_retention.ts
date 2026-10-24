// TRACK-42 unit 1 (2026-10-24): the referenced-checksum collector must find
// every maximal run of exactly 64 lowercase hex characters in any store value.
import assert from 'node:assert/strict'
import { BLOB_MIN_AGE_SECONDS, referencedChecksums } from '../../hooks/blob-retention'

const a = 'a'.repeat(64)
const b = '0123456789abcdef'.repeat(4)
const c = 'c'.repeat(64)
const d = 'd'.repeat(64)
const e = 'e'.repeat(64)
const f = 'f'.repeat(64)
const sorted = (set: Set<string>) => [...set].sort()

assert.equal(BLOB_MIN_AGE_SECONDS, 604800)

// Nested objects and arrays.
assert.deepEqual(sorted(referencedChecksums([{ x: { y: [a, { z: b }] } }, [[c]]])), sorted(new Set([a, b, c])))

// A checksum inside a JSON-encoded string, and inside prose.
const encoded = JSON.stringify({ blob: { checksum: d } })
assert.deepEqual(sorted(referencedChecksums([{ body: encoded }])), [d])
assert.deepEqual(sorted(referencedChecksums([`see ${e}.json for details, then ${f}`])), sorted(new Set([e, f])))

// A checksum used as an object key.
assert.deepEqual(sorted(referencedChecksums([{ [a]: 1, nested: { [b]: [] } }])), sorted(new Set([a, b])))

// Uppercase runs and non-maximal / over-long lowercase runs are not collected.
assert.equal(referencedChecksums([a.toUpperCase(), 'a'.repeat(63), 'a'.repeat(65), 'b'.repeat(128)]).size, 0)
// A 64-run bounded by non-hex characters is collected.
assert.deepEqual(sorted(referencedChecksums([`x${a}x`])), [a])

// null, numbers, booleans, undefined do not throw.
assert.equal(referencedChecksums([null, undefined, 1, 0, NaN, true, false, { n: null, u: undefined }, [null]]).size, 0)

// A repeated object reference and a cycle do not loop.
const shared = { sum: a }
assert.deepEqual(sorted(referencedChecksums([shared, shared, [shared, shared]])), [a])
const cyclic: Record<string, unknown> = { sum: b }
cyclic.self = cyclic
assert.deepEqual(sorted(referencedChecksums([cyclic])), [b])

// Accepts any iterable, including a generator.
function* values() { yield { v: c } }
assert.deepEqual(sorted(referencedChecksums(values())), [c])

console.log('check_blob_retention: ok')
