// FIXTURE: TRACK-35 own-save contracts, frozen before product S. The real blobPool and
// pluginStore providers run beneath SDK middleware. This is not host atomicity or LIVE proof.
import { expect, test } from 'claude-code/testing'
import { EMPTY, TX_REQUEST, atomStore, blobPool, logs, pluginStore } from './kit'
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
  const controls = { mode: 'ok' as 'ok' | 'unavailable' | 'exit' | 'truncated' | 'receipt' | 'readback', config: true, failKey: '', refuseRollbackKey: '', applied: 0, lastPath: '',
    beforeSet: undefined as ((key: string, value: unknown) => Promise<void>) | undefined }
  const observed: Array<{ checksum: string; text: string }> = []
  const storeWrites: string[] = []
  const storeAttempts: string[] = []
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
  // Writer-lock completion requests belong to the kit's lock fixture beneath.
  on('fs.write', (_, e, next) => {
    if (TX_REQUEST.test(e.path)) return next(e)
    files.set(e.path, String(e.text))
    return { value: undefined }
  })
  const pool = blobPool(on, { configDir: CONFIG, files, readProviders: 'external' })
  on('store.delete', { key: /^(?:s:|h:|saved$)/ }, async (_, e, next) => {
    storeAttempts.push(`delete:${e.key}`)
    return next(e)
  })
  on('store.set', { key: /^(?:s:|h:|saved$)/ }, async (_, e, next) => {
    storeAttempts.push(e.key)
    await controls.beforeSet?.(e.key, e.value)
    if (e.key === controls.refuseRollbackKey && controls.failKey === '') {
      controls.refuseRollbackKey = ''
      return { deny: `fixture refused rollback ${e.key}` }
    }
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
  return { store, memory, pool, controls, lines, files, observed, storeWrites, storeAttempts }
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
// TRACK-39 P1b (2026-10-24): with neither CLAUDE_CONFIG_DIR nor HOME there is no lock config, so a
// save refuses before any helper or store call; it no longer saves inline or checks capacity.
const LOCK_CONFIG = 'writer lock configuration unavailable'
const storeSnapshot = async (fixture: ReturnType<typeof setup>) =>
  ({ keys: [...fixture.store.held.keys()], entries: await fingerprint([...fixture.store.held]) })
const expectRefusedBeforeLock = async (fixture: ReturnType<typeof setup>, receipt: any, before: Awaited<ReturnType<typeof storeSnapshot>>, originalFiles: Map<string, string>, expected: Ledger) => {
  expect(receipt.ok).toBe(false)
  expect(receipt.reason).toContain(LOCK_CONFIG)
  expectUnsaved(fixture, LOCK_CONFIG)
  expect(fixture.store.locks.spawns).toEqual([])
  expect(fixture.store.locks.requests).toEqual([])
  expect(fixture.store.locks.timeline.filter(event => /^(?:set|delete):/.test(event))).toEqual([])
  expect(fixture.storeAttempts).toEqual([])
  expect(fixture.observed).toEqual([])
  expect(await storeSnapshot(fixture)).toEqual(before)
  await expectRows(fixture.memory.value, expected)
  await expectFiles(fixture.files, originalFiles)
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

for (const family of [204, 206] as const) {
  test(`FIXTURE own-save ${family}: unavailable helper or directory saves inline without pruning and retries v:2`, async ($, on) => {
    const id = idOf(family)
    const expected = family === 206 ? ledgerFor(id) : { ...EMPTY, session_id: id }
    const files = new Map<string, string>()
    const seeded = family === 206 ? await seedPointer(id, expected, files) : undefined
    const originalFiles = new Map(files)
    const fixture = setup(on, id, expected, seeded?.records, files)
    fixture.controls.mode = 'unavailable'
    const cause = 'blob helper unavailable'
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
    const retryStart = fixture.lines.length
    const candidate = await expectOwnV2(fixture, id, expected, await checkpoint($, id))
    expect(fixture.pool.publishes).toBe(1)
    expect(fixture.lines.slice(retryStart).some(line => line.includes('unsaved'))).toBe(false)
    await expectFiles(files, new Map([...originalFiles, [candidate.path, candidate.text]]))
  })
}

test('FIXTURE own-save 205: missing lock config preserves memory and store until a valid-config v:2 retry', async ($, on) => {
  const id = idOf(205)
  const expected = { ...EMPTY, session_id: id }
  const files = new Map<string, string>()
  const originalFiles = new Map(files)
  const fixture = setup(on, id, expected, undefined, files)
  fixture.controls.config = false
  const before = await storeSnapshot(fixture)
  await expectRefusedBeforeLock(fixture, await checkpoint($, id), before, originalFiles, expected)
  expectNoOwn(fixture, id)
  expect(fixture.pool.publishes).toBe(0)
  fixture.controls.config = true
  const retryStart = fixture.lines.length
  const candidate = await expectOwnV2(fixture, id, expected, await checkpoint($, id))
  expect(fixture.pool.publishes).toBe(1)
  expect(fixture.lines.slice(retryStart).some(line => line.includes('unsaved'))).toBe(false)
  await expectFiles(files, new Map([...originalFiles, [candidate.path, candidate.text]]))
})

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

for (const family of [208] as const) {
  test(`FIXTURE own-save ${family}: over-budget unavailable fallback keeps expired foreign history until real publication works`, async ($, on) => {
    const id = idOf(family)
    const expected = ledgerFor(id)
    const history = await expiredHistory(family)
    const initialBytes = utf8(JSON.stringify(history.records))
    expect(initialBytes).toBeGreaterThan(3 * 1024 * 1024)
    expect(initialBytes).toBeLessThan(4 * 1024 * 1024)
    const files = new Map([[SENTINEL, SENTINEL_TEXT]])
    const fixture = setup(on, id, expected, history.records, files, history.guardStates)
    fixture.controls.mode = 'unavailable'
    const cause = 'blob helper unavailable'
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
    const candidate = await expectOwnV2(fixture, id, expected, await checkpoint($, id))
    expect(fixture.pool.publishes).toBeGreaterThan(0)
    expect(files.get(SENTINEL)).toBe(SENTINEL_TEXT)
    expect(files.get(candidate.path)).toBe(candidate.text)
  })
}

test('FIXTURE own-save 209: missing lock config preserves over-budget expired history until a valid-config retry', async ($, on) => {
  const id = idOf(209)
  const expected = ledgerFor(id)
  const history = await expiredHistory(209)
  const initialBytes = utf8(JSON.stringify(history.records))
  expect(initialBytes).toBeGreaterThan(3 * 1024 * 1024)
  expect(initialBytes).toBeLessThan(4 * 1024 * 1024)
  const files = new Map([[SENTINEL, SENTINEL_TEXT]])
  const fixture = setup(on, id, expected, history.records, files, history.guardStates)
  fixture.controls.config = false
  const before = await storeSnapshot(fixture)
  await expectRefusedBeforeLock(fixture, await checkpoint($, id), before, new Map([[SENTINEL, SENTINEL_TEXT]]), expected)
  await expectRecords(fixture, history.records)
  expectNoOwn(fixture, id)
  for (const foreign of history.sessions) expect(fixture.store.held.has(`cleanup:${foreign}`)).toBe(false)
  expect(fixture.lines.filter(line => /was evicted|deleted|deletion|\bexpired\b/.test(line))).toEqual([])
  expect(fixture.pool.publishes).toBe(0)
  fixture.controls.config = true
  const candidate = await expectOwnV2(fixture, id, expected, await checkpoint($, id))
  expect(fixture.pool.publishes).toBeGreaterThan(0)
  expect(files.get(SENTINEL)).toBe(SENTINEL_TEXT)
  expect(files.get(candidate.path)).toBe(candidate.text)
})

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

// FIXTURE: hold an applied save in recovery without letting its rollback reach the store.
const pendingBlobRecovery = async ($: Engine, on: On, family: number) => {
  const id = idOf(family)
  const old = ledgerFor(id)
  const files = new Map([[SENTINEL, SENTINEL_TEXT]])
  const seeded = await seedPointer(id, old, files)
  const fixture = setup(on, id, { ...EMPTY, session_id: id }, seeded.records, files)
  const durability = atomStore(on, 'durability', { isUnsaved: false, reason: '', memorySession: id })
  await $.classic.SessionStart({ source: 'resume', session_id: id })
  const changed = { ...old, steps: [...old.steps, localStep(id)] }
  fixture.memory.value = changed
  const candidate = await candidateFor(changed, changed)
  fixture.controls.failKey = `s:${id}`
  fixture.controls.refuseRollbackKey = `s:${id}`
  const failed = await checkpoint($, id)
  expect(failed.ok).toBe(false)
  expect(failed.reason).toContain(`fixture applied-then-threw s:${id}`)
  expect(failed.reason).toContain(`recovery pending: track: $.store.set: fixture refused rollback s:${id}`)
  expect(fixture.controls.applied).toBe(1)
  expect(fixture.controls.refuseRollbackKey).toBe('')
  const newPointer = JSON.stringify(fixture.store.held.get(`s:${id}`))
  expect((fixture.store.held.get(`s:${id}`) as typeof seeded.pointer).ledger_blob).toEqual(candidate.ref)
  expect(newPointer).not.toBe(JSON.stringify(seeded.pointer))
  expect(JSON.stringify(fixture.store.held.get(`h:${id}`))).toBe(JSON.stringify(seeded.head))
  expect(JSON.stringify(fixture.store.held.get('saved'))).toBe(JSON.stringify(seeded.records.saved))
  expect([...fixture.store.held.values()].some(value => JSON.stringify(value).includes(seeded.pointer.ledger_blob.checksum))).toBe(false)
  const oldText = JSON.stringify(old)
  const oldPath = `${BLOBS}/${seeded.pointer.ledger_blob.checksum}.json`
  expect(files.get(oldPath)).toBe(oldText)
  expect(await sha256(oldText)).toBe(seeded.pointer.ledger_blob.checksum)
  expect(utf8(oldText)).toBe(seeded.pointer.ledger_blob.bytes)
  files.delete(oldPath)
  return { ...fixture, durability, id, old, seeded, oldText, oldPath, newPointer }
}

test('FIXTURE own-save 235: lost previous blob is restored and verified before the old raw pointer', async ($, on) => {
  const fixture = await pendingBlobRecovery($, on, 235)
  const { id, old, seeded, oldText, oldPath } = fixture
  const restores: Array<{ text: string | undefined; checksum: string | undefined; bytes: number | undefined }> = []
  fixture.controls.beforeSet = async (key, value) => {
    if (key !== `s:${id}` || JSON.stringify(value) !== JSON.stringify(seeded.pointer)) return
    const text = fixture.files.get(oldPath)
    restores.push({ text, checksum: text === undefined ? undefined : await sha256(text), bytes: text === undefined ? undefined : utf8(text) })
  }
  await $.classic.SessionStart({ source: 'resume', session_id: id })
  // Named red: the prior bytes must exist at the instant the pointer is restored.
  expect(restores).toEqual([{ text: oldText, checksum: seeded.pointer.ledger_blob.checksum, bytes: seeded.pointer.ledger_blob.bytes }])
  expect(fixture.files.get(oldPath)).toBe(oldText)
  expect(await sha256(fixture.files.get(oldPath)!)).toBe(seeded.pointer.ledger_blob.checksum)
  expect(JSON.stringify(fixture.store.held.get(`s:${id}`))).toBe(JSON.stringify(seeded.pointer))
  expect(JSON.stringify(fixture.store.held.get(`h:${id}`))).toBe(JSON.stringify(seeded.head))
  expect(JSON.stringify(fixture.store.held.get('saved'))).toBe(JSON.stringify(seeded.records.saved))
  const logical = await fixture.pool.logical(fixture.store, `s:${id}`) as { ledger: Ledger }
  expect(JSON.stringify(logical.ledger)).toBe(oldText)
  await expectRows(logical.ledger, old)
})

for (const [family, mode, cause] of [[236, 'unavailable', 'blob helper unavailable'], [237, 'exit', 'blob helper exit 1']] as const) {
  test(`FIXTURE own-save ${family}: lost previous blob with ${mode} publisher keeps recovery pending with zero store writes`, async ($, on) => {
    const fixture = await pendingBlobRecovery($, on, family)
    const { id, seeded, oldPath, newPointer } = fixture
    const before = JSON.stringify([...fixture.store.held])
    const attempts = fixture.storeAttempts.length
    const publications = fixture.observed.length
    const restores: unknown[] = []
    fixture.controls.beforeSet = async (key, value) => {
      if (key === `s:${id}` && JSON.stringify(value) === JSON.stringify(seeded.pointer)) restores.push(value)
    }
    fixture.controls.mode = mode
    await $.classic.SessionStart({ source: 'resume', session_id: id })
    // Named red: failed previous-blob publication must attempt no durable store writes.
    expect(fixture.storeAttempts.slice(attempts)).toEqual([])
    expect(JSON.stringify([...fixture.store.held])).toBe(before)
    expect(JSON.stringify(fixture.store.held.get(`s:${id}`))).toBe(newPointer)
    expect(restores).toEqual([])
    expect(fixture.durability.value.isUnsaved).toBe(true)
    expect(fixture.durability.value.reason).toContain('resume:')
    expect(fixture.durability.value.reason).toContain(cause)
    expect(fixture.observed.length).toBe(publications + 1)
    // Re-enter recovery to prove the failed attempt retained its in-memory record.
    // The exit fixture may have published bytes before its rejected acknowledgement.
    fixture.files.delete(oldPath)
    fixture.controls.mode = 'unavailable'
    await $.classic.SessionStart({ source: 'resume', session_id: id })
    expect(fixture.observed.length).toBe(publications + 2)
    expect(fixture.storeAttempts.slice(attempts)).toEqual([])
    expect(JSON.stringify([...fixture.store.held])).toBe(before)
    expect(restores).toEqual([])
    expect(fixture.durability.value.isUnsaved).toBe(true)
    expect(fixture.durability.value.reason).toContain('blob helper unavailable')
  })
}

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

for (const family of [207] as const) {
  test(`FIXTURE own-save ${family}: under-budget inline fallback preserves expired foreign history until a real v:2 retry expires it`, async ($, on) => {
    const id = idOf(family)
    const expected = ledgerFor(id)
    const history = await inlineHistory(family)
    const { foreign } = history
    const files = new Map([[SENTINEL, SENTINEL_TEXT]])
    const seeded = await seedPointer(id, expected, files)
    const records = { ...history.records, ...seeded.records, saved: { [foreign]: history.entry, [id]: seeded.entry } }
    const originalFiles = new Map(files)
    const fixture = setup(on, id, expected, records, files, { [foreign]: 'closed' })
    fixture.controls.mode = 'unavailable'
    const cause = 'blob helper unavailable'
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

test('FIXTURE own-save 217: missing lock config preserves under-budget expired history until a valid-config retry', async ($, on) => {
  const id = idOf(217)
  const expected = { ...EMPTY, session_id: id }
  const history = await inlineHistory(217)
  const { foreign } = history
  const files = new Map([[SENTINEL, SENTINEL_TEXT]])
  const originalFiles = new Map(files)
  const fixture = setup(on, id, expected, history.records, files, { [foreign]: 'closed' })
  fixture.controls.config = false
  expect(Date.now()).toBeGreaterThan(7 * 24 * 60 * 60 * 1000)
  for (const key of [`s:${foreign}`, `h:${foreign}`, `r:${foreign}:kept`]) {
    expect(history.records[key]).toMatchObject({ closedAt: 0 })
  }
  expect(history.records.cleanup).toEqual({ v: 1, lastAttempt: 0, cursor: '' })
  const before = await storeSnapshot(fixture)
  await expectRefusedBeforeLock(fixture, await checkpoint($, id), before, originalFiles, expected)
  for (const key of [`s:${foreign}`, `h:${foreign}`, `r:${foreign}:kept`, 'cleanup']) {
    expect(fixture.store.held.get(key)).toEqual(history.records[key])
  }
  expect((fixture.store.held.get('saved') as Record<string, unknown>)[foreign]).toEqual(history.entry)
  expect(fixture.store.held.has(`cleanup:${foreign}`)).toBe(false)
  expectNoOwn(fixture, id)
  expect(fixture.pool.publishes).toBe(0)

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

// TRACK-35 (2026-10-23): reload changed object key order and duplicated an unchanged full ledger.
for (const [family, change] of [
  [230, 'prompt key order'],
  [231, 'prompt head'],
  [232, 'step array order'],
  [233, 'optional prompt requestId'],
  [234, 'distinct Unicode key order'],
] as const) {
  test(`FIXTURE own-save ${family}: ${change} selects the exact full-content blob`, async ($, on) => {
    const id = idOf(family)
    const prompt = { rowKey: 'fixture-prompt', head: 'Stable café prompt 🧭', turnId: 'saved-turn', at: 1,
      requestId: 'fixture-source-request', session_id: id }
    const original = ledgerFor(id)
    const prior: Ledger = { ...original, prompts: [prompt], steps: [...original.steps, localStep(id)],
      ...(family === 234 && { restoredIds: { 'é': 1, 'e\u0301': 1 } }) }
    let current: Ledger = prior
    if (family === 230) current = { ...prior, prompts: [{ rowKey: prompt.rowKey, head: prompt.head, at: prompt.at,
      turnId: prompt.turnId, requestId: prompt.requestId, session_id: id }] }
    if (family === 231) current = { ...prior, prompts: [{ ...prompt, head: 'Changed café prompt 🧭' }] }
    if (family === 232) current = { ...prior, steps: [prior.steps[1]!, prior.steps[0]!] }
    if (family === 233) {
      const { requestId: _requestId, ...withoutRequestId } = prompt
      current = { ...prior, prompts: [withoutRequestId] }
    }
    if (family === 234) current = { ...prior, restoredIds: { 'e\u0301': 1, 'é': 1 } }
    const reuse = family === 230 || family === 234
    const priorText = JSON.stringify(prior)
    const priorRef = { checksum: await sha256(priorText), bytes: utf8(priorText) }
    const priorPath = `${BLOBS}/${priorRef.checksum}.json`
    const currentText = JSON.stringify(current)
    const currentRef = { checksum: await sha256(currentText), bytes: utf8(currentText) }
    const selectedText = reuse ? priorText : currentText
    const selectedRef = reuse ? priorRef : currentRef
    const selectedPath = `${BLOBS}/${selectedRef.checksum}.json`
    const files = new Map([[SENTINEL, SENTINEL_TEXT]])
    const seeded = await seedPointer(id, prior, files)
    const originalFiles = new Map(files)
    const fixture = setup(on, id, current, seeded.records, files)
    atomStore(on, 'durability', { isUnsaved: false, reason: '', memorySession: id,
      baseline: { session_id: id, ledger: prior, checkpoint: seeded.head.checkpoint, generation: GENERATION } })

    expect(prior.steps).toHaveLength(2)
    expect(new Set(prior.steps.map(step => step.id)).size).toBe(2)
    expect(prior.prompts[0]).toEqual(prompt)
    expect(current.prompts[0]?.turnId).toBe('saved-turn')
    expect(currentText).not.toBe(priorText)
    if (reuse) expect(await fingerprint(current)).toEqual(await fingerprint(prior))
    else expect(await fingerprint(current)).not.toEqual(await fingerprint(prior))
    expect(currentRef.checksum).not.toBe(priorRef.checksum)
    if (family !== 232) expect(await describeCheckpoint(current, id)).toEqual(seeded.head.checkpoint)
    if (family === 233) expect(Object.hasOwn(current.prompts[0]!, 'requestId')).toBe(false)
    if (family === 234) {
      expect(Object.keys(prior.restoredIds!)).toEqual(['é', 'e\u0301'])
      expect(Object.keys(current.restoredIds!)).toEqual(['e\u0301', 'é'])
    }
    await expectRows(fixture.memory.value, current)
    expect(JSON.stringify(fixture.memory.value)).toBe(currentText)
    expect(seeded.pointer.ledger_blob).toEqual(priorRef)
    expect(fixture.store.held.get(`s:${id}`)).toEqual(seeded.pointer)
    expect(fixture.pool.publishes).toBe(0)
    expect(fixture.observed).toEqual([])
    await expectFiles(files, originalFiles)

    const receipt = await checkpoint($, id)
    const raw = fixture.store.held.get(`s:${id}`) as Record<string, any>
    // This is the first post-checkpoint assertion: reuse must retain the prior physical reference.
    expect(raw.ledger_blob).toEqual(selectedRef)
    expect(fixture.observed).toEqual([{ checksum: selectedRef.checksum, text: selectedText }])
    expect(fixture.pool.publishes).toBe(1)
    expect(raw.v).toBe(2)
    expect(Object.hasOwn(raw, 'ledger')).toBe(false)
    expect(raw.session_id).toBe(id)
    expect(raw.generation).toBe(GENERATION)
    expect(typeof raw.savedAt).toBe('number')
    expect(receipt).toMatchObject({ v: 1, ok: true, source_session: id,
      counts: { questions: 1, answers: 0, steps: 2 } })
    expect(receipt.reason).toBeUndefined()
    expect(raw.checkpoint).toEqual(await describeCheckpoint(current, id, seeded.head.checkpoint))
    expect(raw.checkpoint).toMatchObject({ revision: receipt.revision, checksum: receipt.checksum, counts: receipt.counts })
    expect(files.get(selectedPath)).toBe(selectedText)
    expect(await sha256(files.get(selectedPath)!)).toBe(selectedRef.checksum)
    expect(utf8(files.get(selectedPath)!)).toBe(selectedRef.bytes)
    expect(files.get(priorPath)).toBe(priorText)
    expect(await sha256(files.get(priorPath)!)).toBe(priorRef.checksum)
    expect(utf8(files.get(priorPath)!)).toBe(priorRef.bytes)
    expect(files.get(SENTINEL)).toBe(SENTINEL_TEXT)
    await expectRows(fixture.memory.value, current)
    expect(fixture.memory.value.steps.map(step => step.id)).toEqual(current.steps.map(step => step.id))
    const logical = await fixture.pool.logical(fixture.store, `s:${id}`) as { v: number; ledger: Ledger }
    expect(logical.v).toBe(1)
    await expectRows(logical.ledger, current)
    expect(logical.ledger.steps.map(step => step.id)).toEqual(current.steps.map(step => step.id))
    const { ledger_blob: _ref, ...metadata } = raw
    expect(await fingerprint(logical)).toEqual(await fingerprint({ ...metadata, v: 1, ledger: current }))
    expect(fixture.store.held.get(`h:${id}`)).toEqual({ v: 1, session_id: id, generation: GENERATION, checkpoint: raw.checkpoint })
    const index = fixture.store.held.get('saved') as Record<string, unknown>
    expect(index[id]).toEqual({ at: raw.savedAt, bytes: rawBytes(`s:${id}`, raw) })
    await expectFiles(files, reuse ? originalFiles : new Map([...originalFiles, [selectedPath, selectedText]]))
    expect(files.size).toBe(originalFiles.size + (reuse ? 0 : 1))
  })
}
