// FIXTURE: TRACK-35 U2a. Every session-body reader resolves a v:2 pointer whose ledger lives in
// a verified blob file, and keeps the raw stored body for rollback, compare-and-set and hashing.
import { expect, test } from 'claude-code/testing'
import { EMPTY, atomStore, blobPool, pluginStore, trackCommand } from './kit'
import type { Engine, On } from './kit'
import { describeCheckpoint } from '../hooks/checkpoint'
import type { Checkpoint } from '../hooks/checkpoint'

const CONFIG = '/fixture/config'
const BLOBS = `${CONFIG}/state/track/blobs`
const GENERATION = '99999999-8888-4777-8666-555555555555'
const DAMAGED = 'saved history blob is missing or damaged'
const KEPT = 'pointer was kept'
// One id pair per test, so no module state carries a revision from one test into another.
const ids = (n: number) => ({
  id: `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`,
  other: `11111111-2222-4333-8444-${String(n).padStart(12, '0')}`,
})

const ledgerFor = (id: string, extra: { questions?: unknown[]; steps?: unknown[] } = {}) => ({
  v: 1, nextQuestionId: 3, prompts: [],
  questions: [{ id: 1, head: 'Saved question', at: 1, turnId: 'old', status: 'deferred', note: 'unfinished', session_id: id }, ...(extra.questions ?? [])],
  steps: [{ id: 'plan:1', subject: 'Saved step', source: 'plan', status: 'in_progress', session_id: id }, ...(extra.steps ?? [])],
  session_id: id,
})

const durable = async (id: string, ledger: ReturnType<typeof ledgerFor>, previous?: Checkpoint) => {
  const checkpoint = await describeCheckpoint(ledger as never, id, previous)
  return {
    body: { v: 1, session_id: id, generation: GENERATION, savedAt: 1000, ledger, checkpoint },
    head: { v: 1, session_id: id, generation: GENERATION, checkpoint },
  }
}

const sha256 = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('')

// The pointer U2b will write: the ledger text moves to <blobs>/<checksum>.json.
const compact = async (files: Map<string, string>, body: { ledger: unknown } & Record<string, unknown>) => {
  const text = JSON.stringify(body.ledger)
  const checksum = await sha256(text)
  files.set(`${BLOBS}/${checksum}.json`, text)
  const { ledger: _ledger, ...rest } = body
  return { ...rest, v: 2, ledger_blob: { checksum, bytes: new TextEncoder().encode(text).length } }
}

const setup = (on: On, id: string, records: Record<string, unknown>, files: Map<string, string>, options: { memory?: unknown; guardStates?: Record<string, 'live' | 'closed'> } = {}) => {
  const l = atomStore<any>(on, 'ledger', options.memory ?? EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on, records, undefined, { guardStates: options.guardStates })
  const reads: string[] = []
  on('session.id', () => ({ value: id }))
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? CONFIG : undefined }))
  on('fs.read', (_, e) => {
    reads.push(e.path)
    const text = files.get(e.path)
    return text === undefined ? { deny: `no such file: ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => { files.set(e.path, String(e.text)); return { value: undefined } })
  const pool = blobPool(on, { configDir: CONFIG, files, readProviders: 'external' })
  return { l, store, reads, pool }
}

const checkpoint = async ($: Engine, id: string) =>
  JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: id } as never)).result ?? '{}'))
const restore = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__track__restore_tracker', ...input } as never) as Promise<{ result?: unknown; deny?: string }>
const command = async ($: Engine, args: string) => JSON.parse((await trackCommand($, args)).text ?? '{}')
const snapshot = (store: { held: Map<string, unknown> }, files: Map<string, string>) => JSON.stringify({
  store: [...store.held.entries()].sort(([a], [b]) => a < b ? -1 : 1),
  files: [...files.entries()].sort(([a], [b]) => a < b ? -1 : 1),
})

test('resume from a v:2 body restores its rows from the blob', async ($, on) => {
  const { id } = ids(1)
  const files = new Map<string, string>()
  const { body, head } = await durable(id, ledgerFor(id))
  const pointer = await compact(files, body)
  const { l } = setup(on, id, { [`s:${id}`]: pointer, [`h:${id}`]: head }, files)
  const receipt = await checkpoint($, id)
  expect(receipt.reason).toBeUndefined()
  expect(receipt).toMatchObject({ ok: true, revision: 1, checksum: head.checkpoint.checksum })
  expect(l.value.questions.map((q: { head: string }) => q.head)).toEqual(['Saved question'])
  expect(l.value.steps.map((s: { subject: string }) => s.subject)).toEqual(['Saved step'])
})

test('checkpoint tool reports open_steps from a v:2 body', async ($, on) => {
  const { id } = ids(2)
  const files = new Map<string, string>()
  const { body, head } = await durable(id, ledgerFor(id))
  setup(on, id, { [`s:${id}`]: await compact(files, body), [`h:${id}`]: head }, files)
  const receipt = await checkpoint($, id)
  expect(receipt.reason).toBeUndefined()
  expect(receipt.counts).toEqual({ questions: 1, answers: 0, steps: 1 })
  expect(receipt.open_steps).toEqual([{ id: 'plan:1', status: 'in_progress', subject: 'Saved step' }])
})

test('restore_tracker restores from a v:2 previous session', async ($, on) => {
  const { id, other } = ids(3)
  const files = new Map<string, string>()
  const { body, head } = await durable(other, ledgerFor(other))
  const pointer = await compact(files, body)
  const { l, store } = setup(on, id, { [`s:${other}`]: pointer, [`h:${other}`]: head }, files)
  const ran = await restore($, { from_session: other })
  expect(ran.deny).toBeUndefined()
  expect(String(ran.result)).toContain('Restored 1 step')
  expect(l.value.steps.map((s: { subject: string }) => s.subject)).toEqual(['Saved step'])
  expect(store.held.get(`s:${other}`)).toEqual(pointer)
})

test('repairHead accepts a matching v:2 successor body and completes the head', async ($, on) => {
  const { id } = ids(4)
  const files = new Map<string, string>()
  const first = await durable(id, ledgerFor(id))
  const next = ledgerFor(id, { steps: [{ id: 'plan:2', subject: 'Second step', source: 'plan', status: 'pending', session_id: id }] })
  const second = await durable(id, next, first.head.checkpoint)
  expect(second.head.checkpoint.revision).toBe(2)
  const { store } = setup(on, id, { [`s:${id}`]: await compact(files, second.body), [`h:${id}`]: first.head }, files)
  const receipt = await checkpoint($, id)
  expect(receipt.reason).toBeUndefined()
  expect(receipt).toMatchObject({ ok: true, revision: 2, checksum: second.head.checkpoint.checksum })
  expect(store.held.get(`h:${id}`)).toEqual(second.head)
})

test('a stale writer reconciles against a v:2 durable body', async ($, on) => {
  const { id } = ids(5)
  const files = new Map<string, string>()
  const first = await durable(id, ledgerFor(id))
  const { l, store, pool } = setup(on, id, { [`s:${id}`]: await compact(files, first.body), [`h:${id}`]: first.head }, files)
  expect((await checkpoint($, id)).revision).toBe(1)
  // Another writer published revision 2 as a pointer.
  const theirs = ledgerFor(id, { questions: [{ id: 2, head: 'Other writer question', at: 2, turnId: 'peer', status: 'deferred', session_id: id }] })
  const second = await durable(id, theirs, first.head.checkpoint)
  store.held.set(`s:${id}`, await compact(files, second.body))
  store.held.set(`h:${id}`, second.head)
  l.value = { ...l.value, steps: [...l.value.steps, { id: 'plan:9', subject: 'Local step', source: 'plan', status: 'pending' }] }
  const receipt = await checkpoint($, id)
  expect(receipt.reason).toBeUndefined()
  expect(receipt.revision).toBe(3)
  const saved = store.held.get(`s:${id}`) as Record<string, unknown>
  expect(saved.v).toBe(2)
  expect(Object.hasOwn(saved, 'ledger')).toBe(false)
  const logical = await pool.logical(store, `s:${id}`) as { ledger: { questions: Array<{ head: string }>; steps: Array<{ subject: string }> } }
  expect(logical.ledger.questions.map(q => q.head)).toEqual(['Saved question', 'Other writer question'])
  expect(logical.ledger.steps.map(s => s.subject)).toEqual(['Saved step', 'Local step'])
})

test('an own save over a v:2 body writes a v:2 body and retains every old blob', async ($, on) => {
  const { id } = ids(6)
  const files = new Map<string, string>()
  const { body, head } = await durable(id, ledgerFor(id))
  const pointer = await compact(files, body)
  const blobs = new Map(files)
  const { l, store, pool } = setup(on, id, { [`s:${id}`]: pointer, [`h:${id}`]: head }, files)
  const receipt = await checkpoint($, id)
  expect(receipt.reason).toBeUndefined()
  const saved = store.held.get(`s:${id}`) as Record<string, unknown>
  expect(saved.v).toBe(2)
  expect(Object.hasOwn(saved, 'ledger')).toBe(false)
  const logical = await pool.logical(store, `s:${id}`) as { ledger: { steps: Array<{ subject: string }> } }
  expect(logical.ledger.steps.map(s => s.subject)).toEqual(['Saved step'])
  expect(saved.generation).toBe(GENERATION)
  expect(store.held.get(`h:${id}`)).toEqual(head)
  const expectedText = JSON.stringify(l.value)
  const checksum = await sha256(expectedText)
  const candidatePath = `${BLOBS}/${checksum}.json`
  expect(saved.ledger_blob).toEqual({ checksum, bytes: new TextEncoder().encode(expectedText).length })
  expect(files.get(candidatePath)).toBe(expectedText)
  expect(logical.ledger).toEqual(l.value)
  for (const [path, text] of blobs) expect(files.get(path)).toBe(text)
  const expectedFiles = new Map(blobs)
  expectedFiles.set(candidatePath, expectedText)
  expect([...files.entries()]).toEqual([...expectedFiles.entries()])
})

test('a failed body, head or index write over a v:2 body rolls back to the raw pointer and its blob', async ($, on) => {
  const { id } = ids(7)
  const files = new Map<string, string>()
  const { body, head } = await durable(id, ledgerFor(id))
  const pointer = await compact(files, body)
  const blobs = new Map(files)
  const { l, store, pool } = setup(on, id, { [`s:${id}`]: pointer, [`h:${id}`]: head }, files)
  for (const key of [`s:${id}`, `h:${id}`, 'saved']) {
    store.faults.mismatchAfterSet = key
    const failed = await checkpoint($, id)
    expect(failed.ok).toBe(false)
    expect(failed.reason).toContain('read-back')
    expect(JSON.stringify(store.held.get(`s:${id}`))).toBe(JSON.stringify(pointer))
    expect(JSON.stringify(store.held.get(`h:${id}`))).toBe(JSON.stringify(head))
    const candidateText = JSON.stringify(l.value)
    const candidatePath = `${BLOBS}/${await sha256(candidateText)}.json`
    for (const [path, text] of blobs) expect(files.get(path)).toBe(text)
    const expectedFiles = new Map(blobs)
    if (files.has(candidatePath)) {
      expect(files.get(candidatePath)).toBe(candidateText)
      expectedFiles.set(candidatePath, candidateText)
    }
    expect([...files.entries()]).toEqual([...expectedFiles.entries()])
  }
  store.faults.mismatchAfterSet = ''
  const receipt = await checkpoint($, id)
  expect(receipt.reason).toBeUndefined()
  const saved = store.held.get(`s:${id}`) as Record<string, unknown>
  expect(saved.v).toBe(2)
  expect(Object.hasOwn(saved, 'ledger')).toBe(false)
  const logical = await pool.logical(store, `s:${id}`) as { ledger: unknown }
  expect(logical.ledger).toEqual(l.value)
})

const breakages: Array<[string, (files: Map<string, string>, pointer: Record<string, any>) => Record<string, unknown>]> = [
  ['a missing blob', (files, pointer) => { files.clear(); return pointer }],
  ['changed blob content', (files, pointer) => {
    for (const [path, text] of files) files.set(path, text.replace('Saved step', 'Saved stex'))
    return pointer
  }],
  ['a wrong blob size', (_, pointer) => ({ ...pointer, ledger_blob: { ...pointer.ledger_blob, bytes: pointer.ledger_blob.bytes + 1 } })],
  ['an invalid checksum string', (_, pointer) => ({ ...pointer, ledger_blob: { ...pointer.ledger_blob, checksum: 'not-a-checksum' } })],
  ['a missing ledger_blob', (_, pointer) => { const { ledger_blob: _blob, ...rest } = pointer; return rest }],
]

for (const [name, damage] of breakages) {
  test(`${name} under a v:2 body fails save, resume, restore_tracker and export closed and changes nothing`, async ($, on) => {
    const { id, other } = ids(10 + breakages.findIndex(([n]) => n === name))
    const files = new Map<string, string>()
    const own = await durable(id, ledgerFor(id))
    const theirs = await durable(other, ledgerFor(other))
    const ownPointer = damage(files, await compact(files, own.body))
    const theirPointer = damage(files, await compact(files, theirs.body))
    const { l, store } = setup(on, id, { [`s:${id}`]: ownPointer, [`h:${id}`]: own.head, [`s:${other}`]: theirPointer, [`h:${other}`]: theirs.head }, files)
    const before = snapshot(store, files)
    const saved = await checkpoint($, id)
    expect(saved.ok).toBe(false)
    expect(saved.reason).toContain(DAMAGED)
    expect(saved.reason).toContain(KEPT)
    const restored = await restore($, { from_session: other })
    expect(String(restored.deny ?? restored.result)).toContain(DAMAGED)
    expect(String(restored.deny ?? restored.result)).not.toContain('No saved steps')
    const exported = await command($, 'export /backup.json')
    expect(exported.ok).toBe(false)
    expect(exported.reason).toContain(DAMAGED)
    expect(files.has('/backup.json')).toBe(false)
    expect(snapshot(store, files)).toBe(before)
    expect(l.value.steps).toEqual([])
    expect(l.value.questions).toEqual([])
  })
}

test('export writes a v:2 body as its v:1 logical record and keeps the raw pointer', async ($, on) => {
  const { id, other } = ids(20)
  const files = new Map<string, string>()
  const { body, head } = await durable(other, ledgerFor(other))
  const pointer = await compact(files, body)
  const { store } = setup(on, id, { [`s:${other}`]: pointer, [`h:${other}`]: head }, files)
  const exported = await command($, 'export /backup.json')
  expect(exported.reason).toBeUndefined()
  expect(exported).toMatchObject({ ok: true, records: 1 })
  const bundle = JSON.parse(files.get('/backup.json') ?? '{}')
  expect(bundle.records).toEqual([{ key: `s:${other}`, value: body }])
  expect(Object.hasOwn(bundle.records[0].value, 'ledger_blob')).toBe(false)
  expect(JSON.stringify(store.held.get(`s:${other}`))).toBe(JSON.stringify(pointer))
})

test('importing the export of a v:2 store into itself twice is not a conflict and keeps the raw pointer', async ($, on) => {
  const { id, other } = ids(21)
  const files = new Map<string, string>()
  const { body, head } = await durable(other, ledgerFor(other))
  const pointer = await compact(files, body)
  const { store } = setup(on, id, { [`s:${other}`]: pointer, [`h:${other}`]: head }, files, { guardStates: { [other]: 'closed' } })
  expect((await command($, 'export /backup.json')).ok).toBe(true)
  const bundle = files.get('/backup.json')
  for (const round of [1, 2]) {
    const imported = await command($, 'import /backup.json')
    expect({ round, reason: imported.reason }).toEqual({ round, reason: undefined })
    expect(imported).toMatchObject({ ok: true, imported: [], verified: [other] })
    expect(JSON.stringify(store.held.get(`s:${other}`))).toBe(JSON.stringify(pointer))
    expect(JSON.stringify(store.held.get(`h:${other}`))).toBe(JSON.stringify(head))
  }
  expect(files.get('/backup.json')).toBe(bundle)
})

test('savedIndex sizes an uncached v:2 entry by its raw value and never reads its blob', async ($, on) => {
  const { id, other } = ids(22)
  const files = new Map<string, string>()
  const { body, head } = await durable(other, ledgerFor(other))
  const pointer = await compact(files, body)
  const { store, reads, pool } = setup(on, id, { [`s:${other}`]: pointer, [`h:${other}`]: head }, files)
  const receipt = await checkpoint($, id)
  expect(receipt.reason).toBeUndefined()
  const index = store.held.get('saved') as Record<string, unknown>
  expect(index[other]).toEqual({ at: 1000, bytes: new TextEncoder().encode(JSON.stringify({ [`s:${other}`]: pointer })).length + 1, unfinished: true })
  expect(reads.filter(path => path === `${BLOBS}/${pointer.ledger_blob.checksum}.json`)).toEqual([])
  expect(JSON.stringify(store.held.get(`s:${other}`))).toBe(JSON.stringify(pointer))
  expect(JSON.stringify(store.held.get(`h:${other}`))).toBe(JSON.stringify(head))
  const saved = store.held.get(`s:${id}`) as Record<string, unknown>
  expect(saved.v).toBe(2)
  expect(Object.hasOwn(saved, 'ledger')).toBe(false)
  const logical = await pool.logical(store, `s:${id}`) as { ledger: unknown }
  expect(logical.ledger).toEqual({ ...EMPTY, session_id: id })
})
