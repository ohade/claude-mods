// FIXTURE: TRACK-35 own-save contracts, frozen before product S. The real blobPool and
// pluginStore providers run beneath SDK middleware. This is not host atomicity or LIVE proof.
import { expect, test } from 'claude-code/testing'
import { EMPTY, atomStore, blobPool, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'
import { describeCheckpoint } from '../hooks/checkpoint'
import type { Ledger } from '../types'

const CONFIG = '/fixture/config'
const BLOBS = `${CONFIG}/state/track/blobs`
const GENERATION = '99999999-8888-4777-8666-555555555555'
const UNAVAILABLE = 'fixture blob helper unavailable'
const SENTINEL = `${BLOBS}/${'f'.repeat(64)}.json`
const SENTINEL_TEXT = 'original blob sentinel: café 🧭'
const encoder = new TextEncoder()
const utf8 = (text: string) => encoder.encode(text).length
const sha256 = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))), b => b.toString(16).padStart(2, '0')).join('')
const idOf = (family: number) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(family).padStart(12, '0')}`
const foreignOf = (family: number, n: number) => `cccccccc-0000-4000-8000-${String(family * 100 + n).padStart(12, '0')}`
const rawBytes = (key: string, value: unknown) => utf8(JSON.stringify({ [key]: value })) + 1

// Canonical fingerprints compare every field while keeping multi-megabyte diagnostics bounded.
// This does not normalize ledger rows or obtain expected values from production code.
const fingerprint = async (value: unknown) => {
  if (value === undefined) return { absent: true }
  const text = JSON.stringify(value, (_, entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry)
  return { bytes: utf8(text), checksum: await sha256(text) }
}
const expectRows = async (actual: unknown, expected: Ledger) =>
  expect(await fingerprint(actual)).toEqual(await fingerprint(expected))
const fileEntries = (files: Map<string, string>) => [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
const expectFiles = async (actual: Map<string, string>, expected: Map<string, string>) =>
  expect(await fingerprint(fileEntries(actual))).toEqual(await fingerprint(fileEntries(expected)))

const ledgerFor = (id: string): Ledger => ({
  v: 1, nextQuestionId: 2, prompts: [],
  questions: [{ id: 1, head: 'Saved café question 🧭', at: 1, turnId: 'saved-turn', status: 'deferred', note: 'Keep résumé context', session_id: id }],
  steps: [{ id: 'plan:1', source: 'plan', subject: 'Continue café work 🧭', status: 'in_progress', note: 'Keep this row', startedAt: 2, activeTurnId: 'saved-turn', session_id: id }],
  session_id: id,
})
const largeLedgerFor = (id: string): Ledger => ({
  ...ledgerFor(id), nextQuestionId: 76,
  questions: Array.from({ length: 75 }, (_, n) => ({
    id: n + 1, head: `Question ${String(n + 1).padStart(2, '0')} `.padEnd(200, 'q'),
    at: n + 1, turnId: 'bounded-turn', status: 'deferred', note: 'n'.repeat(100), session_id: id,
  })),
})
const localStep = (id: string): Ledger['steps'][number] => ({
  id: 'plan:local', source: 'plan', subject: 'New local pending work 🧭', status: 'pending', note: 'Keep the local addition', session_id: id,
})

const setup = (on: On, id: string, expected: Ledger, records: Record<string, unknown> = {}, files = new Map<string, string>(), guardStates: Record<string, 'live' | 'closed'> = {}) => {
  const controls = { mode: 'ok' as 'ok' | 'unavailable' | 'exit' | 'truncated' | 'receipt' | 'readback', config: true, failKey: '', applied: 0, lastPath: '' }
  const observed: Array<{ checksum: string; text: string }> = []
  const storeWrites: string[] = []
  // Different matchers are required: registrations nest in order, first outermost.
  on('process.run', { argv: /blob-fs\.py$/ }, async (_, e, next) => {
    const text = String(e.init?.stdin ?? '')
    observed.push({ checksum: e.argv[4] ?? '', text })
    if (controls.mode === 'unavailable') return { deny: UNAVAILABLE }
    const result = await next(e)
    if (result.deny !== undefined) return result
    if (result.value.exitCode === 0) controls.lastPath = `${BLOBS}/${await sha256(text)}.json`
    if (controls.mode === 'exit') return { ...result, value: { ...result.value, exitCode: 1, stderr: 'fixture helper exit fault' } }
    if (controls.mode === 'truncated') return { ...result, value: { ...result.value, isStdoutTruncated: true } }
    if (controls.mode === 'receipt') return { ...result, value: { ...result.value, stdout: JSON.stringify({ ok: true, checksum: '0'.repeat(64), bytes: utf8(text) + 1 }) } }
    return result
  })
  on('env.get', (_, e) => ({ value: controls.config && e.name === 'CLAUDE_CONFIG_DIR' ? CONFIG : undefined }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) return { deny: `ENOENT: missing blob ${e.path}` }
    if (controls.mode === 'readback' && e.path === controls.lastPath) return { value: `${text.slice(0, -1)}!` }
    return { value: text }
  })
  on('fs.write', (_, e) => { files.set(e.path, String(e.text)); return { value: undefined } })
  const pool = blobPool(on, { configDir: CONFIG, files, readProviders: 'external' })
  on('store.set', { key: /^(?:s:|h:|saved$)/ }, async (_, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined) return result
    storeWrites.push(e.key)
    if (e.key === controls.failKey) {
      controls.failKey = ''
      controls.applied++
      // FIXTURE: preserve one-shot state; this does not test SDK catch/restart durability.
      try {
        throw new Error(`fixture applied-then-threw ${e.key}`)
      } catch (error) {
        return { deny: error instanceof Error ? error.message : String(error) }
      }
    }
    return result
  })
  const memory = atomStore(on, 'ledger', expected)
  atomStore(on, 'turn', { currentId: 'saved-turn', gatedTurnId: null, eventOrder: 0 })
  on('session.id', () => ({ value: id }))
  on('classic.SessionStart', () => ({}))
  const store = pluginStore(on, records, undefined, { guardStates })
  const lines = logs(on)
  return { store, memory, pool, controls, lines, files, observed, storeWrites }
}

const checkpoint = async ($: Engine, id: string) =>
  JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: id } as never)).result ?? '{}'))
const candidateFor = async (actual: Ledger, expected: Ledger) => {
  await expectRows(actual, expected)
  const text = JSON.stringify(actual)
  const ref = { checksum: await sha256(text), bytes: utf8(text) }
  return { text, ref, path: `${BLOBS}/${ref.checksum}.json` }
}
const seedPointer = async (id: string, expected: Ledger, files: Map<string, string>) => {
  const text = JSON.stringify(expected)
  const ref = { checksum: await sha256(text), bytes: utf8(text) }
  files.set(`${BLOBS}/${ref.checksum}.json`, text)
  const stamp = await describeCheckpoint(expected, id)
  const body = { v: 1, session_id: id, generation: GENERATION, savedAt: 1000, ledger: expected, checkpoint: stamp }
  const pointer = Object.fromEntries(Object.entries(body).map(([name, value]) =>
    name === 'v' ? [name, 2] : name === 'ledger' ? ['ledger_blob', ref] : [name, value]))
  const head = { v: 1, session_id: id, generation: GENERATION, checkpoint: stamp }
  const entry = { at: 1000, bytes: rawBytes(`s:${id}`, pointer), unfinished: true }
  return { pointer, head, entry, records: { [`s:${id}`]: pointer, [`h:${id}`]: head, saved: { [id]: entry } } }
}

const expectOwnV2 = async (fixture: ReturnType<typeof setup>, id: string, expected: Ledger, receipt: any) => {
  expect(receipt).toMatchObject({ v: 1, ok: true, source_session: id,
    counts: { questions: expected.questions.length, answers: 0, steps: expected.steps.length } })
  expect(receipt.reason).toBeUndefined()
  const raw = fixture.store.held.get(`s:${id}`) as Record<string, any>
  expect(raw?.v).toBe(2)
  expect(Object.hasOwn(raw, 'ledger')).toBe(false)
  const candidate = await candidateFor(fixture.memory.value, expected)
  expect(raw.ledger_blob).toEqual(candidate.ref)
  expect(fixture.files.get(candidate.path)).toBe(candidate.text)
  expect(await sha256(fixture.files.get(candidate.path)!)).toBe(candidate.ref.checksum)
  expect(utf8(fixture.files.get(candidate.path)!)).toBe(candidate.ref.bytes)
  const logical = await fixture.pool.logical(fixture.store, `s:${id}`) as { v: number; ledger: unknown }
  expect(logical.v).toBe(1)
  await expectRows(logical.ledger, expected)
  const { ledger_blob: _ref, ...metadata } = raw
  expect(await fingerprint(logical)).toEqual(await fingerprint({ ...metadata, v: 1, ledger: expected }))
  expect(raw.checkpoint).toMatchObject({ revision: receipt.revision, checksum: receipt.checksum, counts: receipt.counts })
  expect(fixture.store.held.get(`h:${id}`)).toEqual({ v: 1, session_id: id, generation: raw.generation, checkpoint: raw.checkpoint })
  const index = fixture.store.held.get('saved') as Record<string, unknown>
  expect(index[id]).toEqual({ at: raw.savedAt, bytes: rawBytes(`s:${id}`, raw) })
  return candidate
}
const expectNoOwn = (fixture: ReturnType<typeof setup>, id: string) => {
  expect(fixture.store.held.has(`s:${id}`)).toBe(false)
  expect(fixture.store.held.has(`h:${id}`)).toBe(false)
  const index = fixture.store.held.get('saved') as Record<string, unknown> | undefined
  expect(index?.[id]).toBeUndefined()
}
const expectUnsaved = (fixture: ReturnType<typeof setup>, cause: string) =>
  expect(fixture.lines.some(line => line.includes('unsaved') && line.includes(cause))).toBe(true)
const expectRecords = async (fixture: ReturnType<typeof setup>, records: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(records)) {
    expect(await fingerprint(fixture.store.held.get(key))).toEqual(await fingerprint(value))
  }
}

const middlewarePin = { plugins: [{ name: 'fixture-pin', register(on: On) {
  on('tool.call', { tool: /^fixture__track35_blob_pin$/ }, async capability => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000200'
    const helper = '/fixture/track/hooks/blob-fs.py'
    const pool = '/fixture/config/state/track/blobs'
    const text = JSON.stringify({ message: 'café 🧭', session_id: id })
    const bytes = new TextEncoder().encode(text)
    const checksum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
    const ref = { checksum, bytes: bytes.length }
    const request = { argv: ['python3', helper, 'publish', pool, ref.checksum], init: { stdin: text } }
    try {
      const value = await capability.process.run(request.argv, request.init)
      return { result: JSON.stringify({ status: 'fulfilled', value }) }
    } catch (error) {
      return { result: JSON.stringify({ status: 'rejected', reason: error instanceof Error ? error.message : String(error) }) }
    }
  })
} }] }

test('FIXTURE own-save 200: native SDK middleware composes the real blobPool, refusal and restored helper', middlewarePin, async ($, on) => {
  const id = idOf(200)
  const fixture = setup(on, id, { ...EMPTY, session_id: id })
  const text = JSON.stringify({ message: 'café 🧭', session_id: id })
  const ref = { checksum: await sha256(text), bytes: utf8(text) }
  const publish = async () => JSON.parse(String((await $.tool.call({ tool: 'fixture__track35_blob_pin' } as never)).result))
  const first = await publish()
  expect(first.status).toBe('fulfilled')
  expect(first.value).toEqual({ exitCode: 0, stdout: `${JSON.stringify({ ok: true, ...ref })}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  expect(JSON.parse(first.value.stdout)).toEqual({ ok: true, ...ref })
  const expectedFiles = new Map([[`${BLOBS}/${ref.checksum}.json`, text]])
  await expectFiles(fixture.files, expectedFiles)
  expect(fixture.pool.files).toBe(fixture.files)
  expect(fixture.pool.publishes).toBe(1)
  fixture.controls.mode = 'unavailable'
  const denied = await publish()
  expect(denied.status).toBe('rejected')
  expect(denied.reason).toContain(UNAVAILABLE)
  expect(fixture.pool.publishes).toBe(1)
  await expectFiles(fixture.files, expectedFiles)
  fixture.controls.mode = 'ok'
  expect(await publish()).toEqual(first)
  expect(fixture.pool.publishes).toBe(2)
  expect(fixture.observed).toEqual(Array.from({ length: 3 }, () => ({ checksum: ref.checksum, text })))
  await expectFiles(fixture.files, expectedFiles)
})

for (const [family, kind] of [[201, 'empty'], [202, 'small Unicode'], [203, 'over 16KiB bounded']] as const) {
  test(`FIXTURE own-save ${family}: available helper publishes ${kind} full rows as v:2`, async ($, on) => {
    const id = idOf(family)
    const expected = family === 201 ? { ...EMPTY, session_id: id } : family === 203 ? largeLedgerFor(id) : ledgerFor(id)
    const fixture = setup(on, id, expected)
    const before = await candidateFor(fixture.memory.value, expected)
    if (family === 203) {
      expect(before.ref.bytes).toBeGreaterThan(16384)
      expect(expected.questions).toHaveLength(75)
      expect(expected.questions.every(row => row.head.length === 200 && row.note?.length === 100)).toBe(true)
      expect(expected.nextQuestionId).toBe(76)
    }
    const receipt = await checkpoint($, id)
    const candidate = await expectOwnV2(fixture, id, expected, receipt)
    expect(candidate).toEqual(before)
    expect(fixture.pool.publishes).toBe(1)
    await expectFiles(fixture.files, new Map([[candidate.path, candidate.text]]))
  })
}

for (const family of [204, 205, 206] as const) {
  test(`FIXTURE own-save ${family}: unavailable helper or directory saves inline without pruning and retries v:2`, async ($, on) => {
    const id = idOf(family)
    const expected = family === 206 ? ledgerFor(id) : { ...EMPTY, session_id: id }
    const files = new Map<string, string>()
    const seeded = family === 206 ? await seedPointer(id, expected, files) : undefined
    const originalFiles = new Map(files)
    const fixture = setup(on, id, expected, seeded?.records, files)
    fixture.controls.mode = family === 205 ? 'ok' : 'unavailable'
    fixture.controls.config = family !== 205
    const cause = family === 205 ? 'blob directory unavailable' : 'blob helper unavailable'
    const receipt = await checkpoint($, id)
    expect(receipt.ok).toBe(true)
    expect(receipt).toMatchObject({ v: 1, source_session: id, counts: { questions: expected.questions.length, answers: 0, steps: expected.steps.length } })
    expect(receipt.reason).toBeUndefined()
    const raw = fixture.store.held.get(`s:${id}`) as Record<string, any>
    expect(raw?.v).toBe(1)
    expect(Object.hasOwn(raw, 'ledger_blob')).toBe(false)
    await expectRows(raw.ledger, expected)
    await expectRows(fixture.memory.value, expected)
    expect(raw.checkpoint).toMatchObject({ revision: receipt.revision, checksum: receipt.checksum })
    expect(fixture.lines.some(line => line.includes('saved inline') && line.includes(cause))).toBe(true)
    expect(fixture.pool.publishes).toBe(0)
    await expectFiles(files, originalFiles)
    fixture.controls.mode = 'ok'
    fixture.controls.config = true
    const retryStart = fixture.lines.length
    const candidate = await expectOwnV2(fixture, id, expected, await checkpoint($, id))
    expect(fixture.pool.publishes).toBe(1)
    expect(fixture.lines.slice(retryStart).some(line => line.includes('unsaved'))).toBe(false)
    await expectFiles(files, new Map([...originalFiles, [candidate.path, candidate.text]]))
  })
}

const expiredHistory = async (family: number) => {
  const pads = [950000, 800000, 750000, 700000]
  const sessions = pads.map((_, n) => foreignOf(family, n + 1))
  const records: Record<string, unknown> = { cleanup: { v: 1, lastAttempt: 0, cursor: '' } }
  const saved: Record<string, unknown> = {}
  for (const [n, id] of sessions.entries()) {
    const expected = ledgerFor(id)
    const ledger = { ...expected, questions: [{ ...expected.questions[0]!, note: 'n'.repeat(pads[n]!) }] }
    const stamp = await describeCheckpoint(ledger, id)
    const body = { v: 1, session_id: id, generation: GENERATION, savedAt: n + 1, ledger, checkpoint: stamp, closedAt: 0 }
    records[`s:${id}`] = body
    records[`h:${id}`] = { v: 1, session_id: id, generation: GENERATION, checkpoint: stamp, closedAt: 0 }
    saved[id] = { at: n + 1, bytes: rawBytes(`s:${id}`, body), unfinished: true }
  }
  records[`r:${sessions[0]}:kept`] = { v: 1, session_id: sessions[0], kind: 'kept', value: { text: 'keep this archive' }, closedAt: 0 }
  records.saved = saved
  return { records, sessions, guardStates: Object.fromEntries(sessions.map(id => [id, 'closed' as const])) }
}

for (const family of [208, 209] as const) {
  test(`FIXTURE own-save ${family}: over-budget unavailable fallback keeps expired foreign history until real publication works`, async ($, on) => {
    const id = idOf(family)
    const expected = ledgerFor(id)
    const history = await expiredHistory(family)
    const initialBytes = utf8(JSON.stringify(history.records))
    expect(initialBytes).toBeGreaterThan(3 * 1024 * 1024)
    expect(initialBytes).toBeLessThan(4 * 1024 * 1024)
    const files = new Map([[SENTINEL, SENTINEL_TEXT]])
    const fixture = setup(on, id, expected, history.records, files, history.guardStates)
    fixture.controls.mode = family === 208 ? 'unavailable' : 'ok'
    fixture.controls.config = family !== 209
    const cause = family === 208 ? 'blob helper unavailable' : 'blob directory unavailable'
    const failed = await checkpoint($, id)
    expect(failed.ok).toBe(false)
    expect(failed.reason).toContain(cause)
    expect(failed.reason).toContain('capacity:')
    await expectRecords(fixture, history.records)
    expectNoOwn(fixture, id)
    for (const foreign of history.sessions) expect(fixture.store.held.has(`cleanup:${foreign}`)).toBe(false)
    expect(fixture.lines.filter(line => /was evicted|deleted|deletion|\bexpired\b/.test(line))).toEqual([])
    expect(fixture.pool.publishes).toBe(0)
    await expectRows(fixture.memory.value, expected)
    await expectFiles(files, new Map([[SENTINEL, SENTINEL_TEXT]]))
    fixture.controls.mode = 'ok'
    fixture.controls.config = true
    const candidate = await expectOwnV2(fixture, id, expected, await checkpoint($, id))
    expect(fixture.pool.publishes).toBeGreaterThan(0)
    expect(files.get(SENTINEL)).toBe(SENTINEL_TEXT)
    expect(files.get(candidate.path)).toBe(candidate.text)
  })
}

const quietHistory = (family: number) => {
  const id = foreignOf(family, 1)
  const now = Date.now()
  const body = { v: 1, session_id: id, savedAt: now, ledger: { ...EMPTY, session_id: id } }
  return {
    [`s:${id}`]: body,
    [`h:${id}`]: { v: 1, retentionOnly: true, session_id: id, closedAt: now },
    [`r:${id}:kept`]: { v: 1, session_id: id, kind: 'kept', value: 'original archive' },
    saved: { [id]: { at: now, bytes: rawBytes(`s:${id}`, body) } },
    cleanup: { v: 1, lastAttempt: now, cursor: '' },
  }
}
for (const [family, mode, cause] of [
  [210, 'exit', 'blob helper exit 1'],
  [211, 'truncated', 'blob helper exit 0'],
  [212, 'receipt', 'blob helper receipt does not match the ledger'],
  [213, 'readback', 'published blob does not match the ledger'],
] as const) {
  test(`FIXTURE own-save ${family}: ${mode} integrity rejection refuses inline substitution and retries real v:2`, async ($, on) => {
    const id = idOf(family)
    const expected = ledgerFor(id)
    const history = quietHistory(family)
    const files = new Map([[SENTINEL, SENTINEL_TEXT]])
    const fixture = setup(on, id, expected, history, files)
    const candidate = await candidateFor(fixture.memory.value, expected)
    fixture.controls.mode = mode
    const failed = await checkpoint($, id)
    expect(failed.ok).toBe(false)
    expect(failed.reason).toContain(cause)
    expectUnsaved(fixture, cause)
    expectNoOwn(fixture, id)
    await expectRecords(fixture, history)
    await expectRows(fixture.memory.value, expected)
    expect(fixture.pool.publishes).toBe(1)
    await expectFiles(files, new Map([[SENTINEL, SENTINEL_TEXT], [candidate.path, candidate.text]]))
    fixture.controls.mode = 'ok'
    await expectOwnV2(fixture, id, expected, await checkpoint($, id))
    expect(fixture.pool.publishes).toBe(2)
    await expectFiles(files, new Map([[SENTINEL, SENTINEL_TEXT], [candidate.path, candidate.text]]))
  })
}

test('FIXTURE own-save 214: damaged candidate is never clobbered and a different full ledger can publish', async ($, on) => {
  const id = idOf(214)
  const expected = ledgerFor(id)
  const files = new Map([[SENTINEL, SENTINEL_TEXT]])
  const fixture = setup(on, id, expected, {}, files)
  const candidate = await candidateFor(fixture.memory.value, expected)
  const damaged = candidate.text.replace('Saved café', 'Saved cafè')
  expect(utf8(damaged)).toBe(candidate.ref.bytes)
  expect(await sha256(damaged)).not.toBe(candidate.ref.checksum)
  files.set(candidate.path, damaged)
  const originalFiles = new Map(files)
  for (const attempt of [1, 2]) {
    const failed = await checkpoint($, id)
    expect(failed.ok).toBe(false)
    expect(failed.reason).toContain('existing blob differs; refused and kept')
    expectUnsaved(fixture, 'existing blob differs; refused and kept')
    expectNoOwn(fixture, id)
    await expectRows(fixture.memory.value, expected)
    expect(fixture.pool.publishes).toBe(attempt)
    await expectFiles(files, originalFiles)
  }
  const changed = { ...expected, steps: [...expected.steps, localStep(id)] }
  fixture.memory.value = changed
  const different = await candidateFor(fixture.memory.value, changed)
  expect(different.ref.checksum).not.toBe(candidate.ref.checksum)
  const actual = await expectOwnV2(fixture, id, changed, await checkpoint($, id))
  expect(actual).toEqual(different)
  expect(fixture.pool.publishes).toBe(3)
  await expectFiles(files, new Map([...originalFiles, [different.path, different.text]]))
})

test('FIXTURE own-save 215: applied-then-threw body, head and saved writes restore exact old v:2 authority before a real retry', async ($, on) => {
  const id = idOf(215)
  const old = ledgerFor(id)
  const files = new Map([[SENTINEL, SENTINEL_TEXT]])
  const seeded = await seedPointer(id, old, files)
  const originalFiles = new Map(files)
  const fixture = setup(on, id, { ...EMPTY, session_id: id }, seeded.records, files)
  await $.classic.SessionStart({ source: 'resume', session_id: id })
  await expectRows(fixture.memory.value, old)
  expect(fixture.pool.publishes).toBe(0)
  expect(JSON.stringify(fixture.store.held.get(`s:${id}`))).toBe(JSON.stringify(seeded.pointer))
  const expected = { ...old, steps: [...old.steps, localStep(id)] }
  fixture.memory.value = { ...fixture.memory.value, steps: [...fixture.memory.value.steps, localStep(id)] }
  const candidate = await candidateFor(fixture.memory.value, expected)
  for (const [n, key] of [`s:${id}`, `h:${id}`, 'saved'].entries()) {
    fixture.controls.failKey = key
    const failed = await checkpoint($, id)
    expect(failed.ok).toBe(false)
    expect(failed.reason).toContain(`fixture applied-then-threw ${key}`)
    expect(fixture.controls.applied).toBe(n + 1)
    expect(fixture.controls.failKey).toBe('')
    expectUnsaved(fixture, `fixture applied-then-threw ${key}`)
    expect(JSON.stringify(fixture.store.held.get(`s:${id}`))).toBe(JSON.stringify(seeded.pointer))
    expect(JSON.stringify(fixture.store.held.get(`h:${id}`))).toBe(JSON.stringify(seeded.head))
    const index = fixture.store.held.get('saved') as Record<string, unknown>
    expect(JSON.stringify(index[id])).toBe(JSON.stringify(seeded.entry))
    await expectRows(fixture.memory.value, expected)
    const permitted = new Map(originalFiles)
    if (files.has(candidate.path)) permitted.set(candidate.path, candidate.text)
    await expectFiles(files, permitted)
    expect(fixture.pool.publishes).toBe(n + 1)
  }
  await expectOwnV2(fixture, id, expected, await checkpoint($, id))
  expect(fixture.controls.applied).toBe(3)
  expect(fixture.pool.publishes).toBe(4)
  await expectFiles(files, new Map([...originalFiles, [candidate.path, candidate.text]]))
})

const storeMiddlewarePin = { plugins: [{ name: 'fixture-store-pin', register(on: On) {
  on('tool.call', { tool: /^fixture__track35_store_pin$/ }, async (capability, e) => {
    if (!('fixture_key' in e) || typeof e.fixture_key !== 'string' || !('fixture_value' in e)) return { deny: 'invalid fixture store key' }
    try {
      await capability.store.set(e.fixture_key, e.fixture_value)
      return { result: JSON.stringify({ status: 'fulfilled' }) }
    } catch (error) {
      return { result: JSON.stringify({ status: 'rejected', reason: error instanceof Error ? error.message : String(error) }) }
    }
  })
} }] }

test('FIXTURE own-save 216: real store provider applies once before caller rejection and one-shot retry', storeMiddlewarePin, async ($, on) => {
  const id = idOf(216)
  const files = new Map<string, string>()
  const fixture = setup(on, id, { ...EMPTY, session_id: id }, {}, files)
  const expectedRecords = new Map<string, unknown>()
  const expectedWrites: string[] = []
  for (const [n, target] of [`s:${id}`, `h:${id}`, 'saved'].entries()) {
    fixture.controls.failKey = target
    const applied = { fixture: 'applied', target }
    const rejected = JSON.parse(String((await $.tool.call({ tool: 'fixture__track35_store_pin', fixture_key: target, fixture_value: applied } as never)).result))
    expect(rejected.status).toBe('rejected')
    expect(rejected.reason).toContain(`fixture applied-then-threw ${target}`)
    expect(fixture.controls.applied).toBe(n + 1)
    expect(fixture.controls.failKey).toBe('')
    expect(fixture.store.held.get(target)).toEqual(applied)
    expectedWrites.push(target)
    expect(fixture.storeWrites).toEqual(expectedWrites)
    expectedRecords.set(target, applied)
    expect([...fixture.store.held]).toEqual([...expectedRecords])
    await expectFiles(files, new Map())
    expect(fixture.pool.publishes).toBe(0)

    const retry = { fixture: 'retry', target }
    const fulfilled = JSON.parse(String((await $.tool.call({ tool: 'fixture__track35_store_pin', fixture_key: target, fixture_value: retry } as never)).result))
    expect(fulfilled).toEqual({ status: 'fulfilled' })
    expect(fixture.controls.applied).toBe(n + 1)
    expect(fixture.controls.failKey).toBe('')
    expect(fixture.store.held.get(target)).toEqual(retry)
    expectedWrites.push(target)
    expect(fixture.storeWrites).toEqual(expectedWrites)
    expectedRecords.set(target, retry)
    expect([...fixture.store.held]).toEqual([...expectedRecords])
    await expectFiles(files, new Map())
    expect(fixture.pool.publishes).toBe(0)
  }
  expect(fixture.controls.applied).toBe(3)
  expect(fixture.storeWrites).toEqual([`s:${id}`, `s:${id}`, `h:${id}`, `h:${id}`, 'saved', 'saved'])
})

const inlineHistory = async (family: number) => {
  const foreign = foreignOf(family, 1)
  const ledger = { ...EMPTY, session_id: foreign }
  const stamp = await describeCheckpoint(ledger, foreign)
  const body = { v: 1, session_id: foreign, generation: GENERATION, savedAt: 1, ledger, checkpoint: stamp, closedAt: 0 }
  const entry = { at: 1, bytes: rawBytes(`s:${foreign}`, body), unfinished: false }
  const records: Record<string, unknown> = {
    [`s:${foreign}`]: body,
    [`h:${foreign}`]: { v: 1, session_id: foreign, generation: GENERATION, checkpoint: stamp, closedAt: 0 },
    [`r:${foreign}:kept`]: { v: 1, session_id: foreign, kind: 'kept', value: { text: 'keep this expired archive' }, closedAt: 0 },
    saved: { [foreign]: entry },
    cleanup: { v: 1, lastAttempt: 0, cursor: '' },
  }
  return { foreign, entry, records }
}

for (const family of [207, 217] as const) {
  test(`FIXTURE own-save ${family}: under-budget inline fallback preserves expired foreign history until a real v:2 retry expires it`, async ($, on) => {
    const id = idOf(family)
    const expected = family === 207 ? ledgerFor(id) : { ...EMPTY, session_id: id }
    const history = await inlineHistory(family)
    const { foreign } = history
    const files = new Map([[SENTINEL, SENTINEL_TEXT]])
    const seeded = family === 207 ? await seedPointer(id, expected, files) : undefined
    const records = { ...history.records, ...seeded?.records,
      saved: { [foreign]: history.entry, ...(seeded === undefined ? {} : { [id]: seeded.entry }) } }
    const originalFiles = new Map(files)
    const fixture = setup(on, id, expected, records, files, { [foreign]: 'closed' })
    fixture.controls.mode = family === 207 ? 'unavailable' : 'ok'
    fixture.controls.config = family === 207
    const cause = family === 207 ? 'blob helper unavailable' : 'blob directory unavailable'
    const now = Date.now()
    expect(now).toBeGreaterThan(7 * 24 * 60 * 60 * 1000)
    for (const key of [`s:${foreign}`, `h:${foreign}`, `r:${foreign}:kept`]) {
      expect(history.records[key]).toMatchObject({ closedAt: 0 })
    }
    expect(history.records.cleanup).toEqual({ v: 1, lastAttempt: 0, cursor: '' })
    expect(fixture.store.held.has(`cleanup:${foreign}`)).toBe(false)
    expect(Object.keys(records).length).toBeLessThan(20)
    const ownKey = `s:${id}`
    const headKey = `h:${id}`
    const stamp = await describeCheckpoint(expected, id)
    const plannedBody = { v: 1, session_id: id, generation: GENERATION, savedAt: now, ledger: expected, checkpoint: stamp }
    const plannedHead = { v: 1, session_id: id, generation: GENERATION, checkpoint: stamp }
    const plannedIndex = { [foreign]: history.entry, [id]: { at: now, bytes: rawBytes(ownKey, plannedBody) } }
    // Count the old and replacement records together, plus 64 KiB for size-index metadata.
    const inlineUpperBound = utf8(JSON.stringify(records)) +
      utf8(JSON.stringify({ [ownKey]: plannedBody, [headKey]: plannedHead, saved: plannedIndex })) + 65536
    expect(inlineUpperBound).toBeLessThan(3 * 1024 * 1024)

    const receipt = await checkpoint($, id)
    for (const key of [`s:${foreign}`, `h:${foreign}`, `r:${foreign}:kept`, 'cleanup']) {
      expect(fixture.store.held.get(key)).toEqual(history.records[key])
    }
    const inlineIndex = fixture.store.held.get('saved') as Record<string, unknown>
    expect(inlineIndex[foreign]).toEqual(history.entry)
    expect(fixture.store.held.has(`cleanup:${foreign}`)).toBe(false)
    await expectFiles(files, originalFiles)
    expect(receipt).toMatchObject({ v: 1, ok: true, source_session: id,
      counts: { questions: expected.questions.length, answers: 0, steps: expected.steps.length } })
    expect(receipt.reason).toBeUndefined()
    const raw = fixture.store.held.get(ownKey) as Record<string, any>
    expect(raw?.v).toBe(1)
    expect(Object.hasOwn(raw, 'ledger_blob')).toBe(false)
    await expectRows(raw.ledger, expected)
    await expectRows(fixture.memory.value, expected)
    expect(raw.checkpoint).toMatchObject({ revision: receipt.revision, checksum: receipt.checksum, counts: receipt.counts })
    expect(fixture.store.held.get(headKey)).toEqual({ v: 1, session_id: id, generation: raw.generation, checkpoint: raw.checkpoint })
    expect(fixture.lines.some(line => line.includes('saved inline') && line.includes(cause))).toBe(true)
    expect(fixture.pool.publishes).toBe(0)
    await expectFiles(files, originalFiles)

    fixture.controls.mode = 'ok'
    fixture.controls.config = true
    const retryStart = fixture.lines.length
    const candidate = await expectOwnV2(fixture, id, expected, await checkpoint($, id))
    expect(fixture.pool.publishes).toBe(1)
    expect(fixture.lines.slice(retryStart).some(line => line.includes('unsaved'))).toBe(false)
    for (const key of [`s:${foreign}`, `h:${foreign}`, `r:${foreign}:kept`, `cleanup:${foreign}`]) {
      expect(fixture.store.held.has(key)).toBe(false)
    }
    const retryIndex = fixture.store.held.get('saved') as Record<string, unknown>
    expect(retryIndex[foreign]).toBeUndefined()
    await expectFiles(files, new Map([...originalFiles, [candidate.path, candidate.text]]))
  })
}
