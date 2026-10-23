// FIXTURE: supported store export/import preserves and verifies raw legacy records.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, pluginStore, trackCommand } from './kit'
import type { Engine, On } from './kit'

const OLD = '11111111-2222-4333-8444-555555555555'
const legacy = { v: 1, savedAt: 1, ledger: { ...EMPTY, nextQuestionId: 2, questions: [{ id: 1, head: 'Legacy question 😀', at: 1, turnId: 'old', status: 'deferred', note: 'unfinished' }] } }
const prepare = (on: On, records: Record<string, unknown> = {}, options: Parameters<typeof pluginStore>[3] = {}) => {
  atomStore(on, 'ledger', EMPTY)
  const store = pluginStore(on, records, undefined, options)
  const files = new Map<string, string>()
  on('session.id', () => ({ value: SESSION }))
  on('fs.write', (_, e) => { files.set(e.path, String(e.text)); return { value: undefined } })
  on('fs.read', { path: /^(?!\/fixture\/config\/state\/track\/blobs\/[0-9a-f]{64}\.json$)/ }, (_, e) => ({ value: files.get(e.path) ?? '' }))
  const pool = blobPool(on)
  return { store, files, pool }
}
const exported = async ($: Engine) => JSON.parse((await trackCommand($, 'export /backup.json')).text ?? '{}')

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
  const { files, store } = prepare(on, { [`s:${OLD}`]: legacy }, { guardStates: { [OLD]: 'closed' } })
  await exported($)
  store.held.delete(`s:${OLD}`)
  const first = JSON.parse((await trackCommand($, 'import /backup.json')).text ?? '{}')
  expect(first).toMatchObject({ v: 1, ok: true, imported: [OLD], verified: [OLD] })
  const saved = store.held.get(`s:${OLD}`) as { generation: string }
  const bundle = JSON.parse(files.get('/backup.json')!)
  expect(saved.generation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  const checkpoint = { v: 1, ok: true, source_session: OLD, revision: 1,
    checksum: '4e3669fae00884b78e0bc0a200063b5ba19d62d915c842643d5720121c9a4604',
    counts: { questions: 1, answers: 0, steps: 0 } }
  const expected = { ...legacy, session_id: OLD, generation: saved.generation, checkpoint,
    ledger: { ...legacy.ledger, session_id: OLD, questions: legacy.ledger.questions.map(q => ({ ...q, session_id: OLD })) },
    import_provenance: { source_identity: bundle.source_identity, bundle_checksum: bundle.checksum, source_session: OLD } }
  expect(saved).toEqual(expected)
  expect(store.held.get(`h:${OLD}`)).toEqual({ v: 1, session_id: OLD, generation: saved.generation, checkpoint })
  const second = JSON.parse((await trackCommand($, 'import /backup.json')).text ?? '{}')
  expect(second).toMatchObject({ ok: true, imported: [], verified: [OLD] })
  expect(store.held.get(`s:${OLD}`)).toEqual(expected)
  expect(files.has('/backup.json')).toBe(true)
})

test('a live foreign lease refuses import without changing the source bundle', async ($, on) => {
  const { files, store } = prepare(on, { [`s:${OLD}`]: legacy })
  await exported($)
  const source = files.get('/backup.json')
  store.held.delete(`s:${OLD}`)
  const result = JSON.parse((await trackCommand($, 'import /backup.json')).text ?? '{}')
  expect(result.ok).toBe(false)
  expect(result.reason).toContain('live or unknown')
  expect(store.held.has(`s:${OLD}`)).toBe(false)
  expect(files.get('/backup.json')).toBe(source)
})

test('corrupt or conflicting migration data changes no destination record', async ($, on) => {
  const { files, store } = prepare(on, { [`s:${OLD}`]: legacy })
  await exported($)
  const bundle = JSON.parse(files.get('/backup.json') ?? '{}')
  files.set('/bad.json', JSON.stringify({ ...bundle, checksum: '0'.repeat(64) }))
  const corrupt = JSON.parse((await trackCommand($, 'import /bad.json')).text ?? '{}')
  expect(corrupt.ok).toBe(false)
  expect(store.held.get(`s:${OLD}`)).toEqual(legacy)
  const different = { ...legacy, savedAt: 2 }
  store.held.set(`s:${OLD}`, different)
  const conflict = JSON.parse((await trackCommand($, 'import /backup.json')).text ?? '{}')
  expect(conflict.ok).toBe(false)
  expect(conflict.reason).toContain('conflict')
  expect(store.held.get(`s:${OLD}`)).toEqual(different)
})

for (const present of [false, true]) {
  test(`a closed retention-only marker permits import with the legacy body ${present ? 'present' : 'missing'}`, async ($, on) => {
    const { files, store, pool } = prepare(on, { [`s:${OLD}`]: legacy }, { guardStates: { [OLD]: 'closed' } })
    await exported($)
    const source = files.get('/backup.json')
    if (!present) store.held.delete(`s:${OLD}`)
    store.held.set(`h:${OLD}`, { v: 1, session_id: OLD, retentionOnly: true, closedAt: 123 })

    const first = JSON.parse((await trackCommand($, 'import /backup.json')).text ?? '{}')
    expect(first).toMatchObject({ ok: true, imported: present ? [] : [OLD], verified: [OLD] })
    const saved = store.held.get(`s:${OLD}`) as { generation: string; checkpoint: unknown; ledger: unknown }
    const logical = await pool.logical(store, `s:${OLD}`) as { ledger: unknown }
    expect(logical.ledger).toEqual({ ...legacy.ledger, session_id: OLD, questions: legacy.ledger.questions.map(q => ({ ...q, session_id: OLD })) })
    expect(saved.generation).toMatch(/^[0-9a-f-]{36}$/)
    expect(store.held.get(`h:${OLD}`)).toEqual({ v: 1, session_id: OLD, generation: saved.generation, checkpoint: saved.checkpoint })
    const second = JSON.parse((await trackCommand($, 'import /backup.json')).text ?? '{}')
    expect(second).toMatchObject({ ok: true, imported: [], verified: [OLD] })
    expect(store.held.get(`s:${OLD}`)).toEqual(saved)
    expect(files.get('/backup.json')).toBe(source)
  })
}

test('a retention-only marker cannot bypass a live owner lease', async ($, on) => {
  const { files, store } = prepare(on, { [`s:${OLD}`]: legacy })
  await exported($)
  const source = files.get('/backup.json')
  const marker = { v: 1, session_id: OLD, retentionOnly: true, closedAt: 123 }
  store.held.set(`h:${OLD}`, marker)
  const result = JSON.parse((await trackCommand($, 'import /backup.json')).text ?? '{}')
  expect(result.ok).toBe(false)
  expect(result.reason).toContain('live or unknown')
  expect(store.held.get(`s:${OLD}`)).toEqual(legacy)
  expect(store.held.get(`h:${OLD}`)).toEqual(marker)
  expect(files.get('/backup.json')).toBe(source)
})

test('a retention-only marker cannot authorize overwriting a different body', async ($, on) => {
  const { store } = prepare(on, { [`s:${OLD}`]: legacy }, { guardStates: { [OLD]: 'closed' } })
  await exported($)
  const changed = { ...legacy, savedAt: 2 }
  const marker = { v: 1, session_id: OLD, retentionOnly: true, closedAt: 123 }
  store.held.set(`s:${OLD}`, changed)
  store.held.set(`h:${OLD}`, marker)
  const result = JSON.parse((await trackCommand($, 'import /backup.json')).text ?? '{}')
  expect(result.ok).toBe(false)
  expect(result.reason).toContain('conflict')
  expect(store.held.get(`s:${OLD}`)).toEqual(changed)
  expect(store.held.get(`h:${OLD}`)).toEqual(marker)
})

for (const extra of [{ generation: 'not-a-generation' }, { retentionOnly: false }, { session_id: SESSION }]) {
  test(`a malformed retention marker stays protected: ${JSON.stringify(extra)}`, async ($, on) => {
    const { store } = prepare(on, { [`s:${OLD}`]: legacy }, { guardStates: { [OLD]: 'closed' } })
    await exported($)
    const marker = { v: 1, session_id: OLD, retentionOnly: true, closedAt: 123, ...extra }
    store.held.set(`h:${OLD}`, marker)
    const result = JSON.parse((await trackCommand($, 'import /backup.json')).text ?? '{}')
    expect(result.ok).toBe(false)
    expect(store.held.get(`s:${OLD}`)).toEqual(legacy)
    expect(store.held.get(`h:${OLD}`)).toEqual(marker)
  })
}
