// FIXTURE: supported store export/import preserves and verifies raw legacy records.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

const OLD = '11111111-2222-4333-8444-555555555555'
const legacy = { v: 1, savedAt: 1, ledger: { ...EMPTY, nextQuestionId: 2, questions: [{ id: 1, head: 'Legacy question 😀', at: 1, turnId: 'old', status: 'deferred', note: 'unfinished' }] } }
const prepare = (on: any, records: Record<string, unknown> = {}, options: Parameters<typeof pluginStore>[3] = {}) => {
  atomStore(on, 'ledger', EMPTY)
  const store = pluginStore(on, records, undefined, options)
  const files = new Map<string, string>()
  on('session.id', () => ({ value: SESSION }))
  on('fs.write', (_, e) => { files.set(e.path, String(e.text)); return { value: undefined } })
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  return { store, files }
}
const exported = async ($: any) => JSON.parse((await $.command.run({ command: 'track', args: 'export /backup.json' })).text ?? '{}')

test('export reads the installed identity through store operations and preserves exact legacy values', async ($, on) => {
  const { files, store } = prepare(on, { [`s:${OLD}`]: legacy, closedByPerson: true })
  const result = await exported($)
  expect(result.ok).toBe(true)
  const bundle = JSON.parse(files.get('/backup.json') ?? '{}')
  expect(bundle.records).toEqual([{ key: `s:${OLD}`, value: legacy }])
  expect(bundle.checksum).toMatch(/^[a-f0-9]{64}$/)
  expect(store.held.get(`s:${OLD}`)).toEqual(legacy)
})

test('export refuses an unowned snapshot instead of publishing records while another writer owns the session', async ($, on) => {
  const { files, store } = prepare(on, { [`s:${OLD}`]: legacy }, { leaseFailure: 'another loaded Track instance owns this session' })
  const result = await exported($)
  expect(result.ok).toBe(false)
  expect(result.reason).toContain('another loaded Track instance')
  expect(files.has('/backup.json')).toBe(false)
  expect(store.held.get(`s:${OLD}`)).toEqual(legacy)
})

test('import copies and reads back each missing legacy record and repeat import is safe', async ($, on) => {
  const { files, store } = prepare(on, { [`s:${OLD}`]: legacy })
  await exported($)
  store.held.delete(`s:${OLD}`)
  const first = JSON.parse((await $.command.run({ command: 'track', args: 'import /backup.json' })).text ?? '{}')
  expect(first).toMatchObject({ v: 1, ok: true, imported: [OLD], verified: [OLD] })
  expect(store.held.get(`s:${OLD}`)).toEqual(legacy)
  const second = JSON.parse((await $.command.run({ command: 'track', args: 'import /backup.json' })).text ?? '{}')
  expect(second).toMatchObject({ ok: true, imported: [], verified: [OLD] })
  expect(files.has('/backup.json')).toBe(true)
})

test('corrupt or conflicting migration data changes no destination record', async ($, on) => {
  const { files, store } = prepare(on, { [`s:${OLD}`]: legacy })
  await exported($)
  const bundle = JSON.parse(files.get('/backup.json') ?? '{}')
  files.set('/bad.json', JSON.stringify({ ...bundle, checksum: '0'.repeat(64) }))
  const corrupt = JSON.parse((await $.command.run({ command: 'track', args: 'import /bad.json' })).text ?? '{}')
  expect(corrupt.ok).toBe(false)
  expect(store.held.get(`s:${OLD}`)).toEqual(legacy)
  const different = { ...legacy, savedAt: 2 }
  store.held.set(`s:${OLD}`, different)
  const conflict = JSON.parse((await $.command.run({ command: 'track', args: 'import /backup.json' })).text ?? '{}')
  expect(conflict.ok).toBe(false)
  expect(conflict.reason).toContain('conflict')
  expect(store.held.get(`s:${OLD}`)).toEqual(different)
})
