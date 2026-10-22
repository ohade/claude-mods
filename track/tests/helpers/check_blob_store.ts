// TRACK-35 unit 1 (2026-10-22): content-addressed blob files must be
// write-once, verified on write and read, and swept only when unreferenced.
import assert from 'node:assert/strict'
import { parseBlobPointer, readBlob, sweepBlobs, writeBlob } from '../../hooks/blob-store'
import type { BlobFs } from '../../hooks/blob-store'

const dir = '/store/blobs'
const helloSum = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
const accentSum = '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c'
const otherSum = 'b'.repeat(64)

// Adds a checksum getter that is valid on first read and a traversal afterwards.
const withShiftingChecksum = <T extends object>(fields: T): T & { checksum: string } => {
  let reads = 0
  const get = () => reads++ === 0 ? helloSum : '../../etc/passwd'
  return Object.defineProperty({ ...fields }, 'checksum', { enumerable: true, get }) as T & { checksum: string }
}

// In-memory fs that records every call. `tear` lets a case corrupt writes.
const fakeFs = (tear?: (text: string) => string) => {
  const files = new Map<string, string>()
  const calls: string[] = []
  const fs: BlobFs = {
    read: async path => { calls.push(`read ${path}`); return files.get(path) },
    write: async (path, text) => { calls.push(`write ${path}`); files.set(path, tear ? tear(text) : text) },
    list: async listed => {
      calls.push(`list ${listed}`)
      return [...files.keys()].filter(path => path.startsWith(`${listed}/`)).map(path => path.slice(listed.length + 1))
    },
    remove: async path => { calls.push(`remove ${path}`); files.delete(path) },
  }
  return { fs, files, calls }
}

const checks: Array<[string, () => Promise<void>]> = [
  ['round trip stores the text under its sha-256 name', async () => {
    const { fs, files } = fakeFs()
    const ref = await writeBlob(fs, dir, 'hello')
    assert.deepEqual(ref, { checksum: helloSum, bytes: 5 })
    assert.deepEqual([...files.keys()], [`${dir}/${helloSum}.json`])
    assert.equal(await readBlob(fs, dir, ref), 'hello')
  }],
  ['rewriting the same text is a no-op with the same ref', async () => {
    const { fs, files, calls } = fakeFs()
    const first = await writeBlob(fs, dir, 'hello')
    const writes = calls.filter(call => call.startsWith('write ')).length
    const second = await writeBlob(fs, dir, 'hello')
    assert.deepEqual(second, first)
    assert.equal(files.size, 1)
    assert.equal(calls.filter(call => call.startsWith('write ')).length, writes, 'second write touched the file')
  }],
  ['non-ascii text records utf-8 bytes, not string length', async () => {
    const { fs } = fakeFs()
    const ref = await writeBlob(fs, dir, 'é')
    assert.deepEqual(ref, { checksum: accentSum, bytes: 2 })
    assert.equal(await readBlob(fs, dir, ref), 'é')
  }],
  ['torn write throws blob read-back mismatch', async () => {
    const { fs } = fakeFs(text => text.slice(0, -1))
    await assert.rejects(writeBlob(fs, dir, 'hello'), (error: Error) => error.message.startsWith('blob read-back mismatch'), 'read-back mismatch not thrown')
  }],
  ['corrupted file on disk reads as undefined', async () => {
    const { fs, files } = fakeFs()
    const ref = await writeBlob(fs, dir, 'hello')
    files.set(`${dir}/${helloSum}.json`, 'jello')
    assert.equal(await readBlob(fs, dir, ref), undefined, 'torn blob accepted')
  }],
  ['byte-length mismatch reads as undefined', async () => {
    const { fs } = fakeFs()
    const ref = await writeBlob(fs, dir, 'hello')
    assert.equal(await readBlob(fs, dir, { ...ref, bytes: 6 }), undefined)
  }],
  ['missing file reads as undefined', async () => {
    const { fs } = fakeFs()
    assert.equal(await readBlob(fs, dir, { checksum: helloSum, bytes: 5 }), undefined)
  }],
  ['invalid refs never reach the file system', async () => {
    const { fs, calls } = fakeFs()
    const invalid = [
      { checksum: '../x', bytes: 1 },
      { checksum: helloSum.toUpperCase(), bytes: 5 },
      { checksum: helloSum.slice(1), bytes: 5 },
      { checksum: helloSum, bytes: -1 },
      { checksum: helloSum, bytes: 1.5 },
      { checksum: `${helloSum}/../x`, bytes: 5 },
      { checksum: `../${helloSum}`, bytes: 5 },
      { checksum: `${helloSum}0`, bytes: 5 },
      { checksum: `${helloSum}\n`, bytes: 5 },
    ]
    for (const ref of invalid) assert.equal(await readBlob(fs, dir, ref), undefined, `invalid ref accepted: ${JSON.stringify(ref)}`)
    assert.deepEqual(calls, [], 'invalid ref reached fs')
  }],
  ['sweep removes only unreferenced blob names', async () => {
    const { fs, files } = fakeFs()
    const unreferenced = ['f'.repeat(64), 'c'.repeat(64), '0'.repeat(64)]
    const nonBlobs = ['notes.txt', 'abc.json', `${'A'.repeat(64)}.json`, `${'c'.repeat(64)}.json.bak`, `x${'c'.repeat(64)}.json`]
    for (const name of [...nonBlobs, `${helloSum}.json`, ...unreferenced.map(sum => `${sum}.json`)])
      files.set(`${dir}/${name}`, 'x')
    const removed = await sweepBlobs(fs, dir, new Set([helloSum, otherSum]))
    assert.deepEqual(removed, unreferenced.map(sum => `${sum}.json`).sort())
    assert.ok(files.has(`${dir}/${helloSum}.json`), 'referenced blob swept')
    for (const name of nonBlobs) assert.ok(files.has(`${dir}/${name}`), `non-blob ${name} swept`)
    assert.equal(files.size, nonBlobs.length + 1)
  }],
  ['parseBlobPointer accepts valid records and rejects malformed ones', async () => {
    const valid = { v: 1, checksum: helloSum, bytes: 5, savedAt: 10 }
    assert.deepEqual(parseBlobPointer(valid), valid)
    const full = { ...valid, closedAt: 20, imported: true }
    assert.deepEqual(parseBlobPointer(full), full)
    const rejected: Array<[string, unknown]> = [
      ['extra key', { ...valid, extra: 1 }],
      ['bad checksum', { ...valid, checksum: '../x' }],
      ['uppercase checksum', { ...valid, checksum: helloSum.toUpperCase() }],
      ['checksum with trailing path', { ...valid, checksum: `${helloSum}/../x` }],
      ['checksum with leading path', { ...valid, checksum: `../${helloSum}` }],
      ['65-char checksum', { ...valid, checksum: `${helloSum}0` }],
      ['checksum with trailing newline', { ...valid, checksum: `${helloSum}\n` }],
      ['negative bytes', { ...valid, bytes: -1 }],
      ['non-integer bytes', { ...valid, bytes: 1.5 }],
      ['NaN savedAt', { ...valid, savedAt: NaN }],
      ['Infinity savedAt', { ...valid, savedAt: Infinity }],
      ['Infinity closedAt', { ...valid, closedAt: Infinity }],
      ['negative closedAt', { ...valid, closedAt: -1 }],
      ['non-boolean imported', { ...valid, imported: 'yes' }],
      ['wrong version', { ...valid, v: 2 }],
      ['missing savedAt', { v: 1, checksum: helloSum, bytes: 5 }],
      ['null', null],
      ['array', [valid]],
    ]
    for (const [label, value] of rejected) assert.equal(parseBlobPointer(value), undefined, `accepted ${label}`)
  }],
  ['readBlob reads each ref field once and uses that copy', async () => {
    const { fs, calls } = fakeFs()
    await writeBlob(fs, dir, 'hello')
    calls.length = 0
    const text = await readBlob(fs, dir, withShiftingChecksum({ bytes: 5 }))
    assert.ok(calls.every(call => call === `read ${dir}/${helloSum}.json`), `ref re-read after validation: ${calls.join(', ')}`)
    assert.ok(text === undefined || text === 'hello')
  }],
  ['parseBlobPointer reads each field once and uses that copy', async () => {
    const parsed = parseBlobPointer(withShiftingChecksum({ v: 1, bytes: 5, savedAt: 10 }))
    assert.ok(parsed === undefined || parsed.checksum === helloSum, `pointer re-read after validation: ${parsed?.checksum}`)
  }],
  ['parseBlobPointer rejects inherited fields', async () => {
    const valid = { v: 1, checksum: helloSum, bytes: 5, savedAt: 10 }
    assert.equal(parseBlobPointer(Object.create(valid)), undefined, 'accepted inherited fields')
    assert.deepEqual(parseBlobPointer(Object.assign(Object.create(null), valid)), valid, 'rejected null-prototype record')
  }],
  ['parseBlobPointer ignores a polluted Object.prototype', async () => {
    const prototype = Object.prototype as Record<string, unknown>
    try {
      prototype.savedAt = 10
      assert.equal(parseBlobPointer({ v: 1, checksum: helloSum, bytes: 5 }), undefined, 'accepted polluted savedAt')
    } finally {
      delete prototype.savedAt
    }
  }],
  ['writeBlob refuses a damaged existing blob and keeps it', async () => {
    for (const damagedText of ['jello', '']) {
      const { fs, files, calls } = fakeFs()
      const path = `${dir}/${helloSum}.json`
      files.set(path, damagedText)
      await assert.rejects(writeBlob(fs, dir, 'hello'), {
        name: 'Error',
        message: `existing blob differs from its name; it was kept: ${path}`,
      }, 'damaged existing blob was not refused')
      assert.equal(files.get(path), damagedText, 'damaged existing blob was changed')
      assert.equal(calls.filter(call => call.startsWith('write ')).length, 0, 'damaged existing blob was written')
    }
  }],
]

for (const [name, check] of checks) {
  try {
    await check()
    console.log(`PASS ${name}`)
  } catch (error) {
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
