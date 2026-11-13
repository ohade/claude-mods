// TRACK-35 unit 1 (2026-10-22): a content-addressed blob is returned only when its file
// matches the reference's checksum and byte count; an invalid reference never reaches fs.
import assert from 'node:assert/strict'
import { readBlob } from '../../hooks/blob-store'
import type { BlobFs } from '../../hooks/blob-store'

const dir = '/store/blobs'
const helloSum = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
const accentSum = '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c'

// Adds a checksum getter that is valid on first read and a traversal afterwards.
const withShiftingChecksum = <T extends object>(fields: T): T & { checksum: string } => {
  let reads = 0
  const get = () => reads++ === 0 ? helloSum : '../../etc/passwd'
  return Object.defineProperty({ ...fields }, 'checksum', { enumerable: true, get }) as T & { checksum: string }
}

// In-memory fs that records every call.
const fakeFs = () => {
  const files = new Map<string, string>()
  const calls: string[] = []
  const fs: BlobFs = {
    read: async path => { calls.push(`read ${path}`); return files.get(path) },
  }
  return { fs, files, calls }
}

const checks: Array<[string, () => Promise<void>]> = [
  ['readBlob returns the text stored under its sha-256 name', async () => {
    const { fs, files } = fakeFs()
    files.set(`${dir}/${helloSum}.json`, 'hello')
    assert.equal(await readBlob(fs, dir, { checksum: helloSum, bytes: 5 }), 'hello')
  }],
  ['non-ascii text records utf-8 bytes, not string length', async () => {
    const { fs, files } = fakeFs()
    files.set(`${dir}/${accentSum}.json`, 'é')
    assert.equal(await readBlob(fs, dir, { checksum: accentSum, bytes: 2 }), 'é')
  }],
  ['corrupted file on disk reads as undefined', async () => {
    const { fs, files } = fakeFs()
    files.set(`${dir}/${helloSum}.json`, 'jello')
    assert.equal(await readBlob(fs, dir, { checksum: helloSum, bytes: 5 }), undefined, 'torn blob accepted')
  }],
  ['byte-length mismatch reads as undefined', async () => {
    const { fs, files } = fakeFs()
    files.set(`${dir}/${helloSum}.json`, 'hello')
    assert.equal(await readBlob(fs, dir, { checksum: helloSum, bytes: 6 }), undefined)
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
  ['readBlob reads each ref field once and uses that copy', async () => {
    const { fs, files, calls } = fakeFs()
    files.set(`${dir}/${helloSum}.json`, 'hello')
    const text = await readBlob(fs, dir, withShiftingChecksum({ bytes: 5 }))
    assert.ok(calls.every(call => call === `read ${dir}/${helloSum}.json`), `ref re-read after validation: ${calls.join(', ')}`)
    assert.ok(text === undefined || text === 'hello')
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
