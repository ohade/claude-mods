// FIXTURE: strict foreign CLOSED compaction boundaries, frozen before product S.
// Native SDK routing uses the original providers; this is not host atomicity or LIVE proof.
import { expect, test } from 'claude-code/testing'
import { EMPTY, atomStore, blobPool, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'
import { describeCheckpoint } from '../hooks/checkpoint'
import type { Ledger } from '../types'

const CONFIG = '/fixture/config'
const BLOBS = `${CONFIG}/state/track/blobs`
const GENERATION = '99999999-8888-4777-8666-555555555555'
const BUDGET = 3 * 1024 * 1024
const DELETE_DENIAL = 'fixture protected foreign delete'
const PADDING_KEY = 'fixtureOpaqueProtectedPadding'
const encoder = new TextEncoder()
const utf8 = (text: string) => encoder.encode(text).length
const sha256 = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))), b => b.toString(16).padStart(2, '0')).join('')
const callerOf = (family: number) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(family).padStart(12, '0')}`
const foreignOf = (family: number) => `cccccccc-0000-4000-8000-${String(family * 100 + 1).padStart(12, '0')}`
const fullEntryBytes = (key: string, value: unknown) => utf8(JSON.stringify({ [key]: value }))
const savedBytes = (key: string, value: unknown) => fullEntryBytes(key, value) + 1

// The expected raw pointer maps every field in place. Its oracle uses only JSON and crypto.
const pointerFor = async (body: Record<string, unknown> & { ledger: Ledger }) => {
  const text = JSON.stringify(body.ledger)
  const ref = { checksum: await sha256(text), bytes: utf8(text) }
  const pointer = Object.fromEntries(Object.entries(body).map(([key, value]) =>
    key === 'v' ? [key, 2] : key === 'ledger' ? ['ledger_blob', ref] : [key, value]))
  return { text, ref, pointer, path: `${BLOBS}/${ref.checksum}.json` }
}

const historyFor = async (family: number, compactedAt: number, now: number) => {
  const foreign = foreignOf(family)
  const ledger: Ledger = { ...EMPTY, compactedAt }
  const checkpoint = await describeCheckpoint(ledger, foreign)
  const body = { v: 1, session_id: foreign, generation: GENERATION, savedAt: now, ledger, checkpoint, closedAt: now }
  const head = { v: 1, session_id: foreign, generation: GENERATION, checkpoint, closedAt: now }
  const entry = { at: now, bytes: savedBytes(`s:${foreign}`, body), unfinished: false }
  const records: Record<string, unknown> = {
    [`s:${foreign}`]: body, [`h:${foreign}`]: head, saved: { [foreign]: entry },
    cleanup: { v: 1, lastAttempt: now, cursor: '' },
  }
  return { foreign, body, head, entry, records, candidate: await pointerFor(body) }
}

// Every value excludes capacitySizes. These are independent complete JSON-entry measurements.
const originalSizes = (records: Record<string, unknown>) => Object.fromEntries(
  Object.entries(records).map(([key, value]) => [key, fullEntryBytes(key, value) - 2]))
const initialIndexFor = (records: Record<string, unknown>) => ({ v: 1, sizes: originalSizes(records) })
const conservativeTotal = (records: Record<string, unknown>, originalIndex: ReturnType<typeof initialIndexFor>) => {
  const sizes = originalSizes(records)
  const keys = Object.keys(sizes)
  // All fixture keys are ASCII: encoded UTF-16 and UTF-8 key widths agree.
  expect(keys.every(key => /^[\x00-\x7f]*$/.test(key))).toBe(true)
  const longest = keys.reduce((left, right) => JSON.stringify(left).length >= JSON.stringify(right).length ? left : right, '')
  const pendingIndex = { v: 1, sizes, pending: longest }
  const indexBytes = Math.max(fullEntryBytes('capacitySizes', pendingIndex), fullEntryBytes('capacitySizes', originalIndex)) - 2
  const entryCount = keys.length + 1
  return 2 + Object.values(sizes).reduce((sum, bytes) => sum + bytes, 0) + indexBytes + entryCount - 1
}

const capacityFixture = async (family: number, history: Awaited<ReturnType<typeof historyFor>>, now: number) => {
  const caller = callerOf(family)
  const ownLedger: Ledger = { ...EMPTY, session_id: caller }
  const checkpoint = await describeCheckpoint(ownLedger, caller)
  const ownInline = { v: 1, session_id: caller, generation: GENERATION, savedAt: now, ledger: ownLedger, checkpoint }
  const ownCandidate = await pointerFor(ownInline)
  const ownHead = { v: 1, session_id: caller, generation: GENERATION, checkpoint }
  const planned = (records: Record<string, unknown>, ownBody: unknown) => ({
    ...records, [`s:${caller}`]: ownBody, [`h:${caller}`]: ownHead,
    saved: { [history.foreign]: history.entry, [caller]: { at: now, bytes: savedBytes(`s:${caller}`, ownBody) } },
  })
  let padding = 0
  for (let n = 0; n < 3; n++) {
    const records = { ...history.records, [PADDING_KEY]: 'p'.repeat(padding) }
    const index = initialIndexFor(records)
    padding += BUDGET + 128 - conservativeTotal(planned(records, ownCandidate.pointer), index)
    expect(Number.isSafeInteger(padding) && padding >= 0).toBe(true)
  }
  const original = { ...history.records, [PADDING_KEY]: 'p'.repeat(padding) }
  const index = initialIndexFor(original)
  const inline = planned(original, ownInline)
  const pointer = planned(original, ownCandidate.pointer)
  const floor = (records: Record<string, unknown>) => Object.fromEntries(Object.entries(records)
    .filter(([key]) => key !== `s:${history.foreign}` && key !== `h:${history.foreign}`))
  const measurements = {
    padding, initial: conservativeTotal(original, index),
    ownInline: conservativeTotal(inline, index), ownPointer: conservativeTotal(pointer, index),
    inlineFloor: conservativeTotal(floor(inline), index), pointerFloor: conservativeTotal(floor(pointer), index),
  }
  // These preconditions must pass before Track runs. A failed fixture is never product RED.
  expect(String(now).length).toBe(13)
  expect(GENERATION.length).toBe(36)
  expect(Math.abs(measurements.ownPointer - (BUDGET + 128))).toBeLessThanOrEqual(16)
  expect(measurements.initial).toBeLessThan(BUDGET)
  expect(measurements.ownInline).toBeGreaterThanOrEqual(BUDGET)
  expect(measurements.ownPointer).toBeGreaterThanOrEqual(BUDGET)
  expect(measurements.inlineFloor).toBeLessThan(BUDGET)
  expect(measurements.pointerFloor).toBeLessThan(BUDGET)
  const records = { ...original, capacitySizes: index }
  expect(utf8(JSON.stringify(records))).toBeLessThan(BUDGET)
  return { caller, ownLedger, ownCandidate, records, index, measurements }
}

const originalFiles = async () => {
  const text = JSON.stringify({ fixture: 'old unreferenced blob', note: 'keep café 🧭' })
  return new Map([[`${BLOBS}/${await sha256(text)}.json`, text]])
}
const sortedFiles = (files: Map<string, string>) => [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
const setup = (on: On, caller: string, foreign: string, foreignChecksum: string, records: Record<string, unknown>, files: Map<string, string>) => {
  const foreignPublications: Array<{ checksum: string; text: unknown }> = []
  const deniedDeletes: string[] = []
  // Distinct matchers nest this observer before the real pool and the guard before its provider.
  on('process.run', { argv: /blob-fs\.py$/ }, (_, e, next) => {
    if (e.argv[4] === foreignChecksum) foreignPublications.push({ checksum: e.argv[4], text: e.init?.stdin })
    return next(e)
  })
  on('store.delete', { key: new RegExp(`^[sh]:${foreign}$`) }, (_, e) => {
    deniedDeletes.push(e.key)
    return { deny: DELETE_DENIAL }
  })
  const memory = atomStore<Ledger>(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 'boundary-turn', gatedTurnId: null, eventOrder: 0 })
  on('session.id', () => ({ value: caller }))
  const pool = blobPool(on, { configDir: CONFIG, files })
  const store = pluginStore(on, records, undefined, { guardStates: { [foreign]: 'closed' } })
  const lines = logs(on)
  return { memory, pool, store, lines, foreignPublications, deniedDeletes }
}
const checkpoint = async ($: Engine, caller: string) =>
  JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: caller } as never)).result ?? '{}'))

// The host serializes register as a standalone module: it deliberately closes over nothing.
const deletePin = { plugins: [{ name: 'fixture-delete-pin', register(on: On) {
  on('tool.call', { tool: /^fixture__track35_delete_pin$/ }, async (capability, e) => {
    if (!('fixture_key' in e) || typeof e.fixture_key !== 'string') return { deny: 'invalid fixture delete key' }
    try {
      await capability.store.delete(e.fixture_key)
      return { result: JSON.stringify({ status: 'fulfilled' }) }
    } catch (error) {
      return { result: JSON.stringify({ status: 'rejected', reason: error instanceof Error ? error.message : String(error) }) }
    }
  })
} }] }

test('FIXTURE boundary 223: native store.delete composes the provider and targeted foreign denial', deletePin, async ($, on) => {
  const history = await historyFor(223, 10 ** 13, Date.now())
  const unrelated = 'fixtureUnrelatedDeleteSentinel'
  const records = { ...history.records, [unrelated]: 'remove only this key' }
  const files = await originalFiles()
  const beforeFiles = new Map(files)
  const fixture = setup(on, callerOf(223), history.foreign, history.candidate.ref.checksum, records, files)
  expect(Object.fromEntries(fixture.store.held)).toEqual(records)
  const fulfilled = JSON.parse(String((await $.tool.call({ tool: 'fixture__track35_delete_pin', fixture_key: unrelated } as never)).result))
  expect(fulfilled).toEqual({ status: 'fulfilled' })
  expect(fixture.deniedDeletes).toEqual([])
  expect(fixture.store.held.has(unrelated)).toBe(false)
  expect(Object.fromEntries(fixture.store.held)).toEqual(history.records)
  const rejected = JSON.parse(String((await $.tool.call({ tool: 'fixture__track35_delete_pin', fixture_key: `s:${history.foreign}` } as never)).result))
  expect(rejected.status).toBe('rejected')
  expect(rejected.reason).toContain(DELETE_DENIAL)
  expect(Object.keys(rejected).sort()).toEqual(['reason', 'status'])
  expect(fixture.deniedDeletes).toEqual([`s:${history.foreign}`])
  expect(Object.fromEntries(fixture.store.held)).toEqual(history.records)
  expect(JSON.stringify(fixture.store.held.get(`s:${history.foreign}`))).toBe(JSON.stringify(history.body))
  expect(JSON.stringify(fixture.store.held.get(`h:${history.foreign}`))).toBe(JSON.stringify(history.head))
  expect(sortedFiles(files)).toEqual(sortedFiles(beforeFiles))
  expect(fixture.pool.publishes).toBe(0)
  expect(fixture.foreignPublications).toEqual([])
})

for (const [family, compactedAt, ledgerBytes, delta] of [
  [220, 10 ** 13, 94, 1], [221, 10 ** 14, 95, 0], [222, 10 ** 15, 96, -1],
] as const) {
  test(`FIXTURE boundary ${family}: foreign CLOSED full-entry delta ${delta} publishes only on strict shrink`, async ($, on) => {
    const now = Date.now()
    const history = await historyFor(family, compactedAt, now)
    const { foreign, candidate, body, head, entry } = history
    const foreignKey = `s:${foreign}`
    expect(Object.hasOwn(body.ledger, 'session_id')).toBe(false)
    expect(Number.isFinite(body.ledger.compactedAt)).toBe(true)
    expect(candidate.ref.bytes).toBe(ledgerBytes)
    expect(candidate.text).toBe(JSON.stringify({ ...EMPTY, compactedAt }))
    expect(candidate.ref).toEqual({ checksum: await sha256(candidate.text), bytes: utf8(candidate.text) })
    expect(fullEntryBytes(foreignKey, candidate.pointer) - fullEntryBytes(foreignKey, body)).toBe(delta)
    expect(entry).toEqual({ at: now, bytes: fullEntryBytes(foreignKey, body) + 1, unfinished: false })
    const capacity = await capacityFixture(family, history, now)
    const files = await originalFiles()
    const beforeFiles = new Map(files)
    const fixture = setup(on, capacity.caller, foreign, candidate.ref.checksum, capacity.records, files)
    expect(fixture.store.held.has('capacitySizes')).toBe(true)
    expect(fixture.store.held.get('capacitySizes')).toEqual(capacity.index)
    expect(Object.keys(capacity.index.sizes).sort()).toEqual(Object.keys(capacity.records).filter(key => key !== 'capacitySizes').sort())
    for (const [key, bytes] of Object.entries(capacity.index.sizes)) {
      expect(bytes).toBe(fullEntryBytes(key, fixture.store.held.get(key)) - 2)
    }
    expect(fixture.store.held.has(`cleanup:${foreign}`)).toBe(false)
    expect([...fixture.store.held.keys()].filter(key => key.startsWith(`r:${foreign}:`))).toEqual([])
    expect(body.closedAt).toBe(now)
    expect(head.closedAt).toBe(now)
    expect(fixture.store.held.get('cleanup')).toEqual({ v: 1, lastAttempt: now, cursor: '' })
    expect(candidate.ref.checksum).not.toBe(capacity.ownCandidate.ref.checksum)
    expect(String(Date.now()).length).toBe(String(now).length)

    const result = await checkpoint($, capacity.caller)
    // FIRST post-action assertion: unconditional foreign publication is the named wrong behavior.
    const expectedPublications = delta < 0 ? 1 : 0
    expect({ foreignPublicationCalls: fixture.foreignPublications.length }).toEqual({ foreignPublicationCalls: expectedPublications })
    expect(fixture.foreignPublications).toEqual(Array.from({ length: expectedPublications }, () => ({ checksum: candidate.ref.checksum, text: candidate.text })))
    expect(fixture.deniedDeletes.length).toBeGreaterThan(0)
    expect(fixture.deniedDeletes.every(key => key === foreignKey || key === `h:${foreign}`)).toBe(true)
    expect(fixture.lines.some(line => line.includes(DELETE_DENIAL))).toBe(true)
    expect(result.ok).toBe(false)
    expect(String(result.reason)).toContain('capacity:')
    expect(fixture.lines.some(line => line.includes('unsaved') && line.includes('capacity:'))).toBe(true)
    expect(fixture.store.held.has(`s:${capacity.caller}`)).toBe(false)
    expect(fixture.store.held.has(`h:${capacity.caller}`)).toBe(false)
    const saved = fixture.store.held.get('saved') as Record<string, unknown>
    expect(saved[capacity.caller]).toBeUndefined()
    expect(Object.keys(saved)).toEqual([foreign])
    expect(JSON.stringify(fixture.store.held.get(`h:${foreign}`))).toBe(JSON.stringify(head))
    const expectedRaw = delta < 0 ? candidate.pointer : body
    expect(JSON.stringify(fixture.store.held.get(foreignKey))).toBe(JSON.stringify(expectedRaw))
    expect(saved[foreign]).toEqual(delta < 0 ? { ...entry, bytes: entry.bytes - 1 } : entry)
    expect(fixture.store.held.get(PADDING_KEY)).toBe(capacity.records[PADDING_KEY])
    expect([...fixture.store.held.keys()].filter(key => key.startsWith(`r:${foreign}:`))).toEqual([])
    expect(await fixture.pool.logical(fixture.store, foreignKey)).toEqual(body)
    const permitted = new Map(beforeFiles)
    if (delta < 0) {
      expect(Object.hasOwn(expectedRaw, 'ledger')).toBe(false)
      expect(files.get(candidate.path)).toBe(candidate.text)
      expect({ checksum: await sha256(files.get(candidate.path)!), bytes: utf8(files.get(candidate.path)!) }).toEqual(candidate.ref)
      permitted.set(candidate.path, candidate.text)
    } else {
      expect(files.has(candidate.path)).toBe(false)
    }
    // Only this independently fixed own candidate may remain after a future failed v:2 save.
    expect({ ...fixture.memory.value, session_id: capacity.caller }).toEqual(capacity.ownLedger)
    if (files.has(capacity.ownCandidate.path)) {
      const text = files.get(capacity.ownCandidate.path)!
      expect(text).toBe(JSON.stringify(capacity.ownLedger))
      expect({ checksum: await sha256(text), bytes: utf8(text) }).toEqual(capacity.ownCandidate.ref)
      permitted.set(capacity.ownCandidate.path, capacity.ownCandidate.text)
    }
    expect(sortedFiles(files)).toEqual(sortedFiles(permitted))
    const intent = fixture.store.held.get(`cleanup:${foreign}`)
    if (intent !== undefined) expect(intent).toMatchObject({ v: 2, mode: 'eviction', session_id: foreign, closedAt: now })
    // capacitySizes and a denied-delete intent may remain; neither excuses changed history.
  })
}
