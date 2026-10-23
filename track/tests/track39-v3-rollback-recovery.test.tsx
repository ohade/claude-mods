// FIXTURE: pinned old-reader recovery keeps raw v:3 history before refusing it.
// Expected cleanup reconciliation is allowed; this does not prove LIVE rollback.
import { expect, test } from 'claude-code/testing'
import { atomStore, blobPool, pluginStore } from './kit'
import type { Engine, On } from './kit'
import { checksumOf, describeCheckpoint } from '../hooks/checkpoint'
import { entryBytes } from '../hooks/size-index'

const CONFIG = '/fixture/config'
const LEGACY_BLOBS = `${CONFIG}/state/track/blobs`
const V3_BLOBS = `${CONFIG}/state/track/blobs-v2`
const GENERATION = '39313931-3931-4931-8931-393139313931'
const sessionFor = (number: number) => `39313931-d391-4391-8391-${String(number).padStart(12, '0')}`
const ledgerFor = (session: string, label: string) => ({
  v: 1 as const, nextQuestionId: 2, prompts: [], session_id: session,
  questions: [{ id: 1, head: `${label} question 😀`, at: 1, turnId: 'old', status: 'deferred' as const, note: `${label} note`, session_id: session }],
  steps: [{ id: 'plan:1', source: 'plan' as const, subject: `${label} step`, status: 'in_progress' as const, session_id: session }],
})

const v3Snapshot = async (files: Map<string, string>, session: string, label: string) => {
  const ledger = ledgerFor(session, label)
  const checkpoint = await describeCheckpoint(ledger, session)
  const text = JSON.stringify(ledger)
  const checksum = await checksumOf(ledger)
  files.set(`${V3_BLOBS}/${checksum}.json`, text)
  return {
    body: { v: 3, session_id: session, generation: GENERATION, savedAt: 1000, checkpoint,
      ledger_blob: { checksum, bytes: new TextEncoder().encode(text).length } },
    head: { v: 1, session_id: session, generation: GENERATION, checkpoint },
    ledger,
  }
}

const savedIndex = (session: string, body: unknown) => ({
  [session]: { at: 1000, bytes: new TextEncoder().encode(JSON.stringify({ [`s:${session}`]: body })).length + 1, unfinished: true },
})

const setup = (on: On, session: string, records: Record<string, unknown>, files: Map<string, string>) => {
  const memory = atomStore(on, 'ledger', ledgerFor(session, 'Owned memory'))
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'durability', { isUnsaved: false, reason: '', memorySession: session })
  const reads: string[] = []
  const fileWrites: string[] = []
  const storeWrites: string[] = []
  on('session.id', () => ({ value: session }))
  on('env.get', (_, event) => ({ value: event.name === 'CLAUDE_CONFIG_DIR' ? CONFIG : undefined }))
  on('fs.read', (_, event) => {
    reads.push(event.path)
    const text = files.get(event.path)
    return text === undefined ? { deny: `ENOENT: no such file: ${event.path}` } : { value: text }
  })
  on('fs.write', (_, event) => {
    fileWrites.push(event.path)
    files.set(event.path, String(event.text))
    return { value: undefined }
  })
  const pool = blobPool(on, { configDir: CONFIG, files, readProviders: 'external' })
  on('store.set', { key: /^.+$/ }, (_, event, next) => {
    storeWrites.push(`set:${event.key}`)
    return next(event)
  })
  on('store.delete', { key: /^.+$/ }, (_, event, next) => {
    storeWrites.push(`delete:${event.key}`)
    return next(event)
  })
  const store = pluginStore(on, records)
  return { memory, reads, fileWrites, storeWrites, pool, store, files }
}
type Fixture = ReturnType<typeof setup>

const capture = (fixture: Fixture) => ({
  files: JSON.stringify([...fixture.files.entries()]),
  ledger: JSON.stringify(fixture.memory.value),
})

const expectMemoryAndBlobsPreserved = (fixture: Fixture, before: ReturnType<typeof capture>) => {
  expect(capture(fixture)).toEqual(before)
  expect(fixture.memory.writes).toEqual([])
  expect(fixture.fileWrites).toEqual([])
  expect(fixture.pool.publishes).toBe(0)
  expect(fixture.reads.filter(path => path.startsWith(`${LEGACY_BLOBS}/`) || path.startsWith(`${V3_BLOBS}/`))).toEqual([])
}

const expectExactRecords = (fixture: Fixture, expected: Record<string, unknown>) => {
  expect([...fixture.store.held.keys()].sort()).toEqual(Object.keys(expected).sort())
  for (const [key, value] of Object.entries(expected)) {
    expect(JSON.stringify(fixture.store.held.get(key))).toBe(JSON.stringify(value))
  }
}

// Recovery uses indexedStore: only its size bookkeeping may accompany the named writes.
const expectRecoveryWrites = (fixture: Fixture, records: Record<string, unknown>, writes: string[]) => {
  const sizes = Object.fromEntries(Object.entries(records).map(([key, value]) => [key, entryBytes(key, value)]))
  expectExactRecords(fixture, { ...records, capacitySizes: { v: 1, sizes } })
  expect(fixture.storeWrites.filter(write => write !== 'set:capacitySizes')).toEqual(writes)
}

const expectUnsupportedCheckpoint = async ($: Engine, session: string) => {
  const called = await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: session } as never)
  const receipt = JSON.parse(String(called.result ?? '{}'))
  expect(receipt.ok).toBe(false)
  expect(String(receipt.reason)).toMatch(/unsupported/i)
  expect(String(receipt.reason)).toMatch(/version/i)
}

test('old-reader owner recovery restores exact raw v:3 before-value and clears its cleanup journal', async ($, on) => {
  const session = sessionFor(7)
  const files = new Map<string, string>()
  const original = await v3Snapshot(files, session, 'Before cleanup')
  const stamped = { ...original.body, closedAt: 100 }
  const journal = { v: 1, session_id: session, entries: [{ key: `s:${session}`, before: original.body, after: stamped }] }
  const saved = savedIndex(session, stamped)
  const expected = structuredClone({ [`s:${session}`]: original.body, [`h:${session}`]: original.head, saved })
  const fixture = setup(on, session, {
    [`s:${session}`]: stamped, [`h:${session}`]: original.head, saved, [`cleanup:${session}`]: journal,
  }, files)
  const before = capture(fixture)
  await expectUnsupportedCheckpoint($, session)
  expect(fixture.store.held.has(`cleanup:${session}`)).toBe(false)
  expectRecoveryWrites(fixture, expected, [`set:s:${session}`, `delete:cleanup:${session}`])
  expectMemoryAndBlobsPreserved(fixture, before)
})

test('old-reader owner recovery archives raw A/B/C conflict evidence before clearing its journal', async ($, on) => {
  const session = sessionFor(8)
  const files = new Map<string, string>()
  const original = await v3Snapshot(files, session, 'Before cleanup A')
  const stamped = { ...original.body, closedAt: 100 }
  const current = await v3Snapshot(files, session, 'Conflicting current C')
  const journal = { v: 1, session_id: session, entries: [{ key: `s:${session}`, before: original.body, after: stamped }] }
  const saved = savedIndex(session, current.body)
  const value = { recovery: journal, values: [{ key: `s:${session}`, value: current.body }] }
  const archiveKey = `r:${session}:cleanup-conflict-${await checksumOf(value)}`
  const archive = { v: 1, session_id: session, kind: 'cleanup-conflict', value }
  const expected = structuredClone({
    [`s:${session}`]: current.body, [`h:${session}`]: current.head, saved, [archiveKey]: archive,
  })
  const fixture = setup(on, session, {
    [`s:${session}`]: current.body, [`h:${session}`]: current.head, saved, [`cleanup:${session}`]: journal,
  }, files)
  const before = capture(fixture)
  await expectUnsupportedCheckpoint($, session)
  expect([...fixture.store.held.keys()].filter(key => key.startsWith(`r:${session}:cleanup-conflict-`))).toEqual([archiveKey])
  expect(fixture.store.held.has(`cleanup:${session}`)).toBe(false)
  expectRecoveryWrites(fixture, expected, [`set:${archiveKey}`, `delete:cleanup:${session}`])
  expect(files.size).toBe(2)
  expectMemoryAndBlobsPreserved(fixture, before)
})

test('old-reader checkpoint preserves pre-existing raw v:3 cleanup-conflict and conflict archives', async ($, on) => {
  const session = sessionFor(9)
  const files = new Map<string, string>()
  const original = await v3Snapshot(files, session, 'Archived before A')
  const attempted = await v3Snapshot(files, session, 'Archived after B')
  const current = await v3Snapshot(files, session, 'Own durable C')
  const journal = { v: 1, session_id: session, entries: [{ key: `s:${session}`, before: original.body, after: attempted.body }] }
  const cleanupValue = { recovery: journal, values: [{ key: `s:${session}`, value: current.body }] }
  const cleanupKey = `r:${session}:cleanup-conflict-${await checksumOf(cleanupValue)}`
  const baseline = { session_id: session, ledger: original.ledger, checkpoint: original.head.checkpoint, generation: GENERATION }
  const memory = ledgerFor(session, 'Archived local memory')
  const durable = { body: current.body, head: current.head }
  const conflictKey = `r:${session}:conflict-${await checksumOf({ durable, baseline, memory })}`
  const records = {
    [`s:${session}`]: current.body, [`h:${session}`]: current.head, saved: savedIndex(session, current.body),
    [cleanupKey]: { v: 1, session_id: session, kind: 'cleanup-conflict', value: cleanupValue },
    [conflictKey]: { v: 1, session_id: session, kind: 'conflict', value: { ledger: memory, baseline, durable } },
  }
  const expected = structuredClone(records)
  const fixture = setup(on, session, records, files)
  const before = capture(fixture)
  await expectUnsupportedCheckpoint($, session)
  expectExactRecords(fixture, expected)
  expect(fixture.storeWrites).toEqual([])
  expect(files.size).toBe(3)
  expectMemoryAndBlobsPreserved(fixture, before)
})
