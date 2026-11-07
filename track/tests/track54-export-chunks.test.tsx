// TRACK-54: /track export failed on a real profile because the decoded store (14,236,624 bytes) went
// out in one $.fs.write, and the engine rejects a read or write over 4 MiB (d.ts EngineInterface.fs).
// The stand-ins below enforce that limit. A bundle that fits stays the v1 single file; a larger one
// is written in parts no file of which passes the limit, and import reads the parts and verifies
// them. Importing a split bundle whose records exceed the store budget is a separate defect (the
// import writes bodies inline); these tests stop at the bundle. Written red-first.
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
  on('session.id', () => ({ value: SESSION }))
  on('fs.write', (_, e) => {
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
  return { store, files, pool }
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

test('one record too large for any single file is refused by name, and nothing is written', async ($, on) => {
  const { files } = prepare(on, { [`s:${ids[0]}`]: record(0, LIMIT + 1024) })
  const result = await run($, 'export /backup.json')
  expect(result.ok).toBe(false)
  expect(result.reason).toContain(`s:${ids[0]}`)
  expect(result.reason).toContain('too large')
  expect(files.size).toBe(0)
})
