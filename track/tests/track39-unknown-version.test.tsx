// FIXTURE: unsupported declared body versions must preserve saved history and memory.
// These public-path checks do not prove live host locking or filesystem atomicity.
import { expect, test } from 'claude-code/testing'
import { TX_REQUEST, atomStore, blobPool, pluginStore, trackCommand } from './kit'
import type { Engine, On } from './kit'
import { checksumOf, describeCheckpoint } from '../hooks/checkpoint'
import type { Checkpoint } from '../hooks/checkpoint'

const CONFIG = '/fixture/config'
const FUTURE_BLOBS = `${CONFIG}/state/track/blobs-v2`
const GENERATION = '39903990-3990-4990-8990-399039903990'
const ids = (number: number) => ({
  destination: `39903990-d390-4390-8390-${String(number).padStart(12, '0')}`,
  source: `39903990-5390-4390-8390-${String(number).padStart(12, '0')}`,
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

const futureSnapshot = async (files: Map<string, string>, session: string) => {
  const { body, head } = await inlineSnapshot(session, 'Future source')
  const text = JSON.stringify(body.ledger)
  const checksum = await checksumOf(body.ledger)
  files.set(`${FUTURE_BLOBS}/${checksum}.json`, text)
  const { ledger: _ledger, ...metadata } = body
  return {
    body: { ...metadata, v: 99, ledger_blob: { checksum, bytes: new TextEncoder().encode(text).length } },
    head,
  }
}

const setup = (on: On, destination: string, records: Record<string, unknown>, files: Map<string, string>) => {
  const memory = atomStore(on, 'ledger', ledgerFor(destination, 'Destination original'))
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'durability', { isUnsaved: false, reason: '', memorySession: destination })
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
  // Writer-lock completion requests belong to the kit's lock fixture beneath.
  on('fs.write', (_, event, next) => {
    if (TX_REQUEST.test(event.path)) return next(event)
    fileWrites.push(event.path)
    files.set(event.path, String(event.text))
    return { value: undefined }
  })
  const pool = blobPool(on, { configDir: CONFIG, files, readProviders: 'external' })
  // Distinct filtered observers precede kit's terminal matcher-less providers.
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
  expect(fixture.reads.filter(path => path.startsWith(`${CONFIG}/state/track/blobs/`) || path.startsWith(`${FUTURE_BLOBS}/`))).toEqual([])
}

const command = async ($: Engine, args: string) => JSON.parse((await trackCommand($, args)).text ?? '{}')
const restore = ($: Engine, source: string, expected?: Checkpoint) => $.tool.call({
  tool: 'mcp__track__restore_tracker', from_session: source,
  ...(expected === undefined ? {} : { expected_checkpoint: expected }),
} as never) as Promise<{ result?: unknown; deny?: string }>

test('export refuses a declared v:99 body before writing any bundle', async ($, on) => {
  const { destination, source } = ids(1)
  const files = new Map<string, string>()
  const supported = await inlineSnapshot(destination, 'Supported inline')
  const future = await futureSnapshot(files, source)
  const fixture = setup(on, destination, {
    [`s:${destination}`]: supported.body, [`h:${destination}`]: supported.head,
    [`s:${source}`]: future.body, [`h:${source}`]: future.head,
  }, files)
  const before = capture(fixture)
  const receipt = await command($, 'export /fixture/unknown-export.json')
  expect(receipt.ok).toBe(false)
  expect(String(receipt.reason)).toMatch(/unsupported/i)
  expect(String(receipt.reason)).toMatch(/version/i)
  expect(files.has('/fixture/unknown-export.json')).toBe(false)
  expectPreserved(fixture, before)
})

test('own checkpoint refuses a declared v:99 body and preserves its body, head, index and memory', async ($, on) => {
  const { destination } = ids(2)
  const files = new Map<string, string>()
  const future = await futureSnapshot(files, destination)
  const fixture = setup(on, destination, {
    [`s:${destination}`]: future.body, [`h:${destination}`]: future.head,
    saved: { [destination]: { at: 1000, bytes: new TextEncoder().encode(JSON.stringify(future.body)).length, unfinished: true } },
  }, files)
  const before = capture(fixture)
  const called = await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: destination } as never)
  const receipt = JSON.parse(String(called.result ?? '{}'))
  expect(receipt.ok).toBe(false)
  expect(String(receipt.reason)).toMatch(/incompatible|unsupported|version/i)
  expectPreserved(fixture, before)
})

test('legacy restore refuses a declared v:99 source without changing either session', async ($, on) => {
  const { destination, source } = ids(3)
  const files = new Map<string, string>()
  const supported = await inlineSnapshot(destination, 'Destination saved')
  const future = await futureSnapshot(files, source)
  const fixture = setup(on, destination, {
    [`s:${destination}`]: supported.body, [`h:${destination}`]: supported.head,
    [`s:${source}`]: future.body, [`h:${source}`]: future.head,
  }, files)
  const before = capture(fixture)
  const called = await restore($, source)
  expect(typeof called.deny).toBe('string')
  expect(String(called.deny).length).toBeGreaterThan(0)
  expectPreserved(fixture, before)
})

test('checkpoint-bound restore refuses a coherent declared v:99 source without mutations', async ($, on) => {
  const { destination, source } = ids(4)
  const files = new Map<string, string>()
  const supported = await inlineSnapshot(destination, 'Destination saved')
  const future = await futureSnapshot(files, source)
  const fixture = setup(on, destination, {
    [`s:${destination}`]: supported.body, [`h:${destination}`]: supported.head,
    [`s:${source}`]: future.body, [`h:${source}`]: future.head,
  }, files)
  const before = capture(fixture)
  const called = await restore($, source, future.head.checkpoint)
  const receipt = JSON.parse(String(called.result ?? '{}'))
  expect(receipt.ok).toBe(false)
  expect(String(receipt.reason)).toMatch(/incompatible|unsupported|version/i)
  expectPreserved(fixture, before)
})

test('import refuses a valid-checksum bundle containing a declared v:99 body without mutations', async ($, on) => {
  const { destination, source } = ids(5)
  const files = new Map<string, string>()
  const supported = await inlineSnapshot(destination, 'Destination saved')
  const future = await futureSnapshot(files, source)
  const records = [{ key: `s:${source}`, value: future.body }]
  files.set('/fixture/unknown-import.json', JSON.stringify({
    v: 1, source_identity: '/fixture/legacy-track', checksum: await checksumOf(records), records,
  }))
  const fixture = setup(on, destination, {
    [`s:${destination}`]: supported.body, [`h:${destination}`]: supported.head,
  }, files)
  const before = capture(fixture)
  const receipt = await command($, 'import /fixture/unknown-import.json')
  expect(receipt.ok).toBe(false)
  expect(String(receipt.reason)).toMatch(/invalid|incompatible|unsupported/i)
  expectPreserved(fixture, before)
})
