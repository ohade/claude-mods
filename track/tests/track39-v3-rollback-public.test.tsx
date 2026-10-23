// FIXTURE: pinned old-reader acceptance for the proposed v:3 blob namespace.
// These negative checks do not prove LIVE rollback, host locks or filesystem atomicity.
import { expect, test } from 'claude-code/testing'
import { atomStore, blobPool, pluginStore, trackCommand } from './kit'
import type { Engine, On } from './kit'
import { checksumOf, describeCheckpoint } from '../hooks/checkpoint'
import type { Checkpoint } from '../hooks/checkpoint'

const CONFIG = '/fixture/config'
const LEGACY_BLOBS = `${CONFIG}/state/track/blobs`
const V3_BLOBS = `${CONFIG}/state/track/blobs-v2`
const GENERATION = '39303930-3930-4930-8930-393039303930'
const ids = (number: number) => ({
  destination: `39303930-d390-4390-8390-${String(number).padStart(12, '0')}`,
  source: `39303930-5390-4390-8390-${String(number).padStart(12, '0')}`,
})

const ledgerFor = (session: string, label: string) => ({
  v: 1 as const, nextQuestionId: 2, prompts: [], session_id: session,
  questions: [{ id: 1, head: `${label} question 😀`, at: 1, turnId: 'old', status: 'deferred' as const, note: `${label} note`, session_id: session }],
  steps: [{ id: 'plan:1', source: 'plan' as const, subject: `${label} step`, status: 'in_progress' as const, session_id: session }],
})

const inlineSnapshot = async (session: string, label: string) => {
  const ledger = ledgerFor(session, label)
  const checkpoint = await describeCheckpoint(ledger, session)
  return {
    body: { v: 1, session_id: session, generation: GENERATION, savedAt: 1000, ledger, checkpoint },
    head: { v: 1, session_id: session, generation: GENERATION, checkpoint },
  }
}

const v3Snapshot = async (files: Map<string, string>, session: string, legacyDecoy = false) => {
  const { body, head } = await inlineSnapshot(session, 'V3 source')
  const text = JSON.stringify(body.ledger)
  const checksum = await checksumOf(body.ledger)
  files.set(`${V3_BLOBS}/${checksum}.json`, text)
  // A reader confusing v:3 with v:2 must find a valid legacy blob, not ENOENT.
  if (legacyDecoy) files.set(`${LEGACY_BLOBS}/${checksum}.json`, text)
  const { ledger: _ledger, ...metadata } = body
  return { body: { ...metadata, v: 3, ledger_blob: { checksum, bytes: new TextEncoder().encode(text).length } }, head }
}

const savedIndex = (session: string, body: unknown) => ({
  [session]: { at: 1000, bytes: new TextEncoder().encode(JSON.stringify({ [`s:${session}`]: body })).length + 1, unfinished: true },
})

const setup = (on: On, destination: string, records: Record<string, unknown>, files: Map<string, string>, baseline?: Awaited<ReturnType<typeof inlineSnapshot>>['body']) => {
  const memory = atomStore(on, 'ledger', ledgerFor(destination, 'Destination original'))
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'durability', {
    isUnsaved: false, reason: '', memorySession: destination,
    ...(baseline === undefined ? {} : { baseline: {
      session_id: destination, ledger: baseline.ledger, checkpoint: baseline.checkpoint, generation: baseline.generation,
    } }),
  })
  const reads: string[] = []
  const fileWrites: string[] = []
  const storeWrites: string[] = []
  on('session.id', () => ({ value: destination }))
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
  // Filtered observers must precede kit's terminal matcher-less store providers.
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
  store: JSON.stringify([...fixture.store.held.entries()]),
  files: JSON.stringify([...fixture.files.entries()]),
  ledger: JSON.stringify(fixture.memory.value),
})

const expectPreserved = (fixture: Fixture, before: ReturnType<typeof capture>) => {
  expect(capture(fixture)).toEqual(before)
  expect(fixture.memory.writes).toEqual([])
  expect(fixture.storeWrites).toEqual([])
  expect(fixture.fileWrites).toEqual([])
  expect(fixture.pool.publishes).toBe(0)
  expect(fixture.reads.filter(path => path.startsWith(`${LEGACY_BLOBS}/`) || path.startsWith(`${V3_BLOBS}/`))).toEqual([])
}

const expectUnsupportedVersion = (reason: unknown) => {
  expect(String(reason)).toMatch(/unsupported/i)
  expect(String(reason)).toMatch(/version/i)
}
const command = async ($: Engine, args: string) => JSON.parse((await trackCommand($, args)).text ?? '{}')
const checkpoint = async ($: Engine, session: string) => {
  const called = await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: session } as never)
  return JSON.parse(String(called.result ?? '{}'))
}
const restore = ($: Engine, source: string, expected?: Checkpoint) => $.tool.call({
  tool: 'mcp__track__restore_tracker', from_session: source,
  ...(expected === undefined ? {} : { expected_checkpoint: expected }),
} as never) as Promise<{ result?: unknown; deny?: string }>

test('old-reader export refuses raw v:3 despite a valid legacy-namespace decoy', async ($, on) => {
  const { destination, source } = ids(1)
  const files = new Map<string, string>()
  const supported = await inlineSnapshot(destination, 'Supported inline')
  const future = await v3Snapshot(files, source, true)
  const fixture = setup(on, destination, {
    [`s:${destination}`]: supported.body, [`h:${destination}`]: supported.head,
    [`s:${source}`]: future.body, [`h:${source}`]: future.head,
  }, files)
  const before = capture(fixture)
  const receipt = await command($, 'export /fixture/v3-rollback-export.json')
  expect(receipt.ok).toBe(false)
  expectUnsupportedVersion(receipt.reason)
  expect(files.has('/fixture/v3-rollback-export.json')).toBe(false)
  expectPreserved(fixture, before)
})

test('old-reader own checkpoint preserves coherent raw v:3 body, head, index and memory', async ($, on) => {
  const { destination } = ids(2)
  const files = new Map<string, string>()
  const future = await v3Snapshot(files, destination, true)
  const fixture = setup(on, destination, {
    [`s:${destination}`]: future.body, [`h:${destination}`]: future.head,
    saved: savedIndex(destination, future.body),
  }, files)
  const before = capture(fixture)
  const receipt = await checkpoint($, destination)
  expect(receipt.ok).toBe(false)
  expectUnsupportedVersion(receipt.reason)
  expectPreserved(fixture, before)
})

test('old-reader legacy restore refuses a foreign raw v:3 source without mutations', async ($, on) => {
  const { destination, source } = ids(3)
  const files = new Map<string, string>()
  const supported = await inlineSnapshot(destination, 'Destination saved')
  const future = await v3Snapshot(files, source)
  const fixture = setup(on, destination, {
    [`s:${destination}`]: supported.body, [`h:${destination}`]: supported.head,
    [`s:${source}`]: future.body, [`h:${source}`]: future.head,
  }, files)
  const before = capture(fixture)
  const called = await restore($, source)
  expect(typeof called.deny).toBe('string')
  expectUnsupportedVersion(called.deny)
  expectPreserved(fixture, before)
})

test('old-reader checkpoint-bound restore refuses a coherent raw v:3 source', async ($, on) => {
  const { destination, source } = ids(4)
  const files = new Map<string, string>()
  const supported = await inlineSnapshot(destination, 'Destination saved')
  const future = await v3Snapshot(files, source, true)
  const fixture = setup(on, destination, {
    [`s:${destination}`]: supported.body, [`h:${destination}`]: supported.head,
    [`s:${source}`]: future.body, [`h:${source}`]: future.head,
  }, files)
  const before = capture(fixture)
  const called = await restore($, source, future.head.checkpoint)
  const receipt = JSON.parse(String(called.result ?? '{}'))
  expect(receipt.ok).toBe(false)
  expectUnsupportedVersion(receipt.reason)
  expectPreserved(fixture, before)
})

test('old-reader import refuses a valid-checksum logical bundle containing raw v:3', async ($, on) => {
  const { destination, source } = ids(5)
  const files = new Map<string, string>()
  const supported = await inlineSnapshot(destination, 'Destination saved')
  const future = await v3Snapshot(files, source)
  const records = [{ key: `s:${source}`, value: future.body }]
  files.set('/fixture/v3-rollback-import.json', JSON.stringify({
    v: 1, source_identity: '/fixture/legacy-track', checksum: await checksumOf(records), records,
  }))
  const fixture = setup(on, destination, {
    [`s:${destination}`]: supported.body, [`h:${destination}`]: supported.head,
  }, files)
  const before = capture(fixture)
  const receipt = await command($, 'import /fixture/v3-rollback-import.json')
  expect(receipt.ok).toBe(false)
  expect(String(receipt.reason)).toMatch(/invalid|incompatible/i)
  expectPreserved(fixture, before)
})

test('old-reader reload-state checkpoint retains owned memory and a raw v:3 durable body', async ($, on) => {
  const { destination } = ids(6)
  const files = new Map<string, string>()
  const future = await v3Snapshot(files, destination, true)
  const baseline = await inlineSnapshot(destination, 'Acknowledged baseline')
  const fixture = setup(on, destination, {
    [`s:${destination}`]: future.body, [`h:${destination}`]: future.head,
    saved: savedIndex(destination, future.body),
  }, files, baseline.body)
  const before = capture(fixture)
  // This checks the public reload-shaped input, not which private read refuses it.
  const receipt = await checkpoint($, destination)
  expect(receipt.ok).toBe(false)
  expectUnsupportedVersion(receipt.reason)
  expectPreserved(fixture, before)
})
