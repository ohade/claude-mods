// TRACK-54: /track export failed on a real profile because the decoded store (14,236,624 bytes) went
// out in one $.fs.write, and the engine rejects a read or write over 4 MiB (d.ts EngineInterface.fs).
// The stand-ins below enforce that limit. A bundle that fits stays the v1 single file; a larger one
// is written in parts no file of which passes the limit, and import reads the parts, verifies them
// and stores large bodies as blob pointers so the result fits the store budget. A repeated export
// to the same path never overwrites the parts the previous manifest names. Written red-first.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, pluginStore, trackCommand } from './kit'
import type { Engine, On } from './kit'

const LIMIT = 4 * 1024 * 1024
const encoder = new TextEncoder()
const bytes = (text: string) => encoder.encode(text).length
const ids = [0, 1, 2, 3, 4, 5].map(n => `11111111-2222-4333-8444-55555555555${n}`)
const record = (n: number, size: number) => ({
  v: 1, savedAt: n + 1,
  ledger: { ...EMPTY, nextQuestionId: 2, questions: [{ id: 1, head: `Question ${n}`, at: 1, turnId: `t${n}`, status: 'deferred', note: String(n).repeat(size) }] },
})

const prepare = (on: On, records: Record<string, unknown>) => {
  atomStore(on, 'ledger', EMPTY)
  const guardStates = Object.fromEntries(ids.map(id => [id, 'closed' as const]))
  const store = pluginStore(on, records, 64 * LIMIT, { guardStates })
  const files = new Map<string, string>()
  // A write numbered `failAt` (counted from the last reset) fails, as a full disk would.
  const faults = { failAt: 0, writes: 0 }
  on('session.id', () => ({ value: SESSION }))
  on('fs.write', (_, e) => {
    faults.writes++
    if (faults.failAt !== 0 && faults.writes === faults.failAt) throw new Error('disk full')
    const text = String(e.text)
    if (bytes(text) > LIMIT) throw new Error(`${bytes(text)} bytes exceeds the ${LIMIT}-byte $.fs.write limit`)
    files.set(e.path, text)
    return { value: undefined }
  })
  on('fs.read', { path: /^(?!\/fixture\/config\/state\/track\/blobs\/[0-9a-f]{64}\.json$)/ }, (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    if (bytes(text) > LIMIT) throw new Error(`${bytes(text)} bytes exceeds the ${LIMIT}-byte $.fs.read limit`)
    return { value: text }
  })
  const pool = blobPool(on)
  return { store, files, pool, faults }
}
const run = async ($: Engine, args: string) => JSON.parse((await trackCommand($, args)).text ?? '{}')
const big = () => Object.fromEntries(ids.map((id, n) => [`s:${id}`, record(n, 900_000)]))

test('an export whose decoded store is over 4 MiB succeeds, and no file it writes passes the limit', async ($, on) => {
  const { files } = prepare(on, big())
  const result = await run($, 'export /backup.json')
  expect(result).toMatchObject({ v: 1, ok: true, records: 6 })
  expect(files.has('/backup.json')).toBe(true)
  expect(files.size).toBeGreaterThan(1)
  for (const text of files.values()) expect(bytes(text)).toBeLessThanOrEqual(LIMIT)
})

test('the parts hold exactly the store\'s records, in key order, and the manifest names each part', async ($, on) => {
  const records = big()
  const { files } = prepare(on, records)
  expect((await run($, 'export /backup.json')).ok).toBe(true)
  const manifest = JSON.parse(files.get('/backup.json')!) as { v: number; records: number; parts: Array<{ name: string; bytes: number; records: number }> }
  expect(manifest.v).toBe(2)
  expect(manifest.records).toBe(6)
  const read = manifest.parts.flatMap(ref => {
    const text = files.get(`/${ref.name}`)!
    expect(bytes(text)).toBe(ref.bytes)
    const part = JSON.parse(text) as { records: unknown[] }
    expect(part.records).toHaveLength(ref.records)
    return part.records
  })
  expect(read).toEqual(Object.keys(records).sort().map(key => ({ key, value: records[key] })))
})

test('a changed part refuses the import by checksum and changes no destination record', async ($, on) => {
  const { store, files } = prepare(on, big())
  expect((await run($, 'export /backup.json')).ok).toBe(true)
  const before = new Map(store.held)
  const part = [...files.keys()].find(path => path !== '/backup.json')!
  files.set(part, files.get(part)!.replace('"note":"0', '"note":"9'))
  const result = await run($, 'import /backup.json')
  expect(result.ok).toBe(false)
  expect(result.reason).toContain('corrupt or incompatible')
  expect(new Map(store.held)).toEqual(before)
})

test('a missing part refuses the import by name and changes no destination record', async ($, on) => {
  const { store, files } = prepare(on, big())
  expect((await run($, 'export /backup.json')).ok).toBe(true)
  for (const id of ids) store.held.delete(`s:${id}`)
  const before = new Map(store.held)
  const part = [...files.keys()].find(path => path !== '/backup.json')!
  files.delete(part)
  const result = await run($, 'import /backup.json')
  expect(result.ok).toBe(false)
  expect(result.reason).toContain(part)
  expect(new Map(store.held)).toEqual(before)
})

test('a split export imports back every record with its exact ledger', async ($, on) => {
  const records = big()
  const { store, pool } = prepare(on, records)
  expect((await run($, 'export /backup.json')).ok).toBe(true)
  for (const id of ids) store.held.delete(`s:${id}`)
  const imported = await run($, 'import /backup.json')
  expect(imported).toMatchObject({ v: 1, ok: true, imported: ids, verified: ids })
  for (const [n, id] of ids.entries()) {
    const logical = await pool.logical(store, `s:${id}`) as { ledger: { questions: Array<{ note: string }> } }
    expect(logical.ledger.questions[0]!.note).toBe(record(n, 900_000).ledger.questions[0]!.note)
  }
})

test('a failed repeat export to the same path leaves the previous bundle whole', async ($, on) => {
  const { store, files, faults } = prepare(on, big())
  expect((await run($, 'export /backup.json')).ok).toBe(true)
  const previous = new Map(files)
  store.held.set(`s:${ids[0]}`, record(0, 950_000))
  faults.writes = 0
  faults.failAt = 2
  expect((await run($, 'export /backup.json')).ok).toBe(false)
  const manifest = JSON.parse(files.get('/backup.json')!) as { parts: Array<{ name: string }> }
  expect(files.get('/backup.json')).toBe(previous.get('/backup.json'))
  for (const ref of manifest.parts) expect(files.get(`/${ref.name}`)).toBe(previous.get(`/${ref.name}`))
})

test('one record too large for any single file is refused by name, and nothing is written', async ($, on) => {
  const { files } = prepare(on, { [`s:${ids[0]}`]: record(0, LIMIT + 1024) })
  const result = await run($, 'export /backup.json')
  expect(result.ok).toBe(false)
  expect(result.reason).toContain(`s:${ids[0]}`)
  expect(result.reason).toContain('too large')
  expect(files.size).toBe(0)
})
