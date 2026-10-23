// FIXTURE: TRACK-35 U2a, correction round 1. Pins the v:2 readers the first suite left open:
// the rewind baseline, the import index size and head check for a kept pointer, the legacy
// archive in repairHead, and a blob read that fails for a reason other than a missing file.
import { expect, test } from 'claude-code/testing'
import { EMPTY, atomStore, blobPool, pluginStore, trackCommand } from './kit'
import type { Engine, On } from './kit'
import { describeCheckpoint } from '../hooks/checkpoint'
import type { Checkpoint } from '../hooks/checkpoint'

const CONFIG = '/fixture/config'
const BLOBS = `${CONFIG}/state/track/blobs`
const GENERATION = '99999999-8888-4777-8666-555555555555'
const OTHER_GENERATION = '77777777-6666-4555-8444-333333333333'
const DAMAGED = 'saved history blob is missing or damaged'
const KEPT = 'pointer was kept'
// Ids differ from the first suite's, so no module state carries a revision across files.
const ids = (n: number) => ({
  id: `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`,
  other: `11111111-2222-4333-8444-${String(n).padStart(12, '0')}`,
})

const step = (id: string, subject: string, status: string) => ({ id, source: 'plan', subject, status })

const ledgerFor = (id: string, extra: { steps?: unknown[] } = {}) => ({
  v: 1, nextQuestionId: 3, prompts: [],
  questions: [{ id: 1, head: 'Saved question', at: 1, turnId: 'old', status: 'deferred', note: 'unfinished', session_id: id }],
  steps: [{ ...step('plan:1', 'Saved step', 'in_progress'), session_id: id }, ...(extra.steps ?? [])],
  session_id: id,
})

const durable = async (id: string, ledger: Record<string, unknown>, previous?: Checkpoint) => {
  const checkpoint = await describeCheckpoint(ledger as never, id, previous)
  return {
    body: { v: 1, session_id: id, generation: GENERATION, savedAt: 1000, ledger, checkpoint } as Record<string, unknown> & { ledger: unknown },
    head: { v: 1, session_id: id, generation: GENERATION, checkpoint },
  }
}

const sha256 = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('')
const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

// The pointer U2b will write: the ledger text moves to <blobs>/<checksum>.json.
const compact = async (files: Map<string, string>, body: { ledger: unknown } & Record<string, unknown>) => {
  const text = JSON.stringify(body.ledger)
  const checksum = await sha256(text)
  files.set(`${BLOBS}/${checksum}.json`, text)
  const { ledger: _ledger, ...rest } = body
  return { ...rest, v: 2, ledger_blob: { checksum, bytes: new TextEncoder().encode(text).length } }
}

type Options = { memory?: unknown; durability?: unknown; guardStates?: Record<string, 'live' | 'closed'>; blobReadError?: string }
const setup = (on: On, id: string, records: Record<string, unknown>, files: Map<string, string>, options: Options = {}) => {
  const l = atomStore<any>(on, 'ledger', options.memory ?? EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  if (options.durability !== undefined) atomStore(on, 'durability', options.durability)
  const store = pluginStore(on, records, undefined, { guardStates: options.guardStates })
  on('session.id', () => ({ value: id }))
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? CONFIG : undefined }))
  on('fs.read', (_, e) => {
    if (options.blobReadError !== undefined && e.path.startsWith(BLOBS)) return { deny: options.blobReadError }
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT: no such file or directory, open '${e.path}'` } : { value: text }
  })
  on('fs.write', (_, e) => { files.set(e.path, String(e.text)); return { value: undefined } })
  const pool = blobPool(on, { configDir: CONFIG, files, readProviders: 'external' })
  return { l, store, pool }
}

const checkpoint = async ($: Engine, id: string) =>
  JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: id } as never)).result ?? '{}'))
const command = async ($: Engine, args: string) => JSON.parse((await trackCommand($, args)).text ?? '{}')
const snapshot = (store: { held: Map<string, unknown> }, files: Map<string, string>) => JSON.stringify({
  store: [...store.held.entries()].sort(([a], [b]) => a < b ? -1 : 1),
  files: [...files.entries()].sort(([a], [b]) => a < b ? -1 : 1),
})

test('a rewind baseline is verified against the v:2 blob and the save writes v:2 with the new row', async ($, on) => {
  const { id } = ids(31)
  const files = new Map<string, string>()
  const saved = { v: 1, nextQuestionId: 1, prompts: [], questions: [],
    steps: [{ ...step('plan:1', 'Saved step', 'in_progress'), session_id: id }, { ...step('plan:2', 'Rewound step', 'pending'), session_id: id }], session_id: id }
  const { body, head } = await durable(id, saved)
  // The rewind snapshot is the saved ledger as savedLedger normalizes it.
  const normalized = { v: 1, nextQuestionId: 1, prompts: [], questions: [], steps: [step('plan:1', 'Saved step', 'in_progress'), step('plan:2', 'Rewound step', 'pending')] }
  // After the rewind: plan:2 left the transcript and a new row was added.
  const memory = { v: 1, nextQuestionId: 1, prompts: [], questions: [], steps: [step('plan:1', 'Saved step', 'in_progress'), step('plan:3', 'New step', 'pending')], session_id: id }
  const { store, pool } = setup(on, id, { [`s:${id}`]: await compact(files, body), [`h:${id}`]: head }, files, {
    memory,
    durability: { isUnsaved: true, reason: 'rewind', memorySession: id, rewindBaseline: { session_id: id, ledger: normalized } },
  })
  const receipt = await checkpoint($, id)
  expect(receipt.reason).toBeUndefined()
  expect(receipt).toMatchObject({ ok: true, revision: 2 })
  const written = store.held.get(`s:${id}`) as Record<string, unknown>
  expect(written.v).toBe(2)
  expect(Object.hasOwn(written, 'ledger')).toBe(false)
  const logical = await pool.logical(store, `s:${id}`) as { ledger: { steps: Array<{ subject: string }> } }
  expect(logical.ledger.steps.map(s => s.subject)).toEqual(['Saved step', 'New step'])
})

test('importing over a kept v:2 destination sizes its index entry by the raw pointer', async ($, on) => {
  const { id, other } = ids(32)
  const files = new Map<string, string>()
  const { body, head } = await durable(other, ledgerFor(other))
  const pointer = await compact(files, body)
  const { store } = setup(on, id, { [`s:${other}`]: pointer, [`h:${other}`]: head }, files, { guardStates: { [other]: 'closed' } })
  expect((await command($, 'export /backup.json')).ok).toBe(true)
  const imported = await command($, 'import /backup.json')
  expect(imported.reason).toBeUndefined()
  expect(imported).toMatchObject({ ok: true, imported: [], verified: [other] })
  expect(JSON.stringify(store.held.get(`s:${other}`))).toBe(JSON.stringify(pointer))
  const index = store.held.get('saved') as Record<string, { bytes: number }>
  expect(index[other]?.bytes).toBe(bytesOf({ [`s:${other}`]: pointer }) + 1)
  expect(index[other]?.bytes).not.toBe(bytesOf({ [`s:${other}`]: body }) + 1)
})

test('importing over a v:2 destination whose head differs from the bundle head is a head conflict', async ($, on) => {
  const { id, other } = ids(33)
  const files = new Map<string, string>()
  const { body, head } = await durable(other, ledgerFor(other))
  const pointer = await compact(files, body)
  const { store } = setup(on, id, { [`s:${other}`]: pointer, [`h:${other}`]: head }, files, { guardStates: { [other]: 'closed' } })
  expect((await command($, 'export /backup.json')).ok).toBe(true)
  store.held.set(`h:${other}`, { ...head, generation: OTHER_GENERATION })
  const before = snapshot(store, files)
  const imported = await command($, 'import /backup.json')
  expect(imported.ok).toBe(false)
  expect(imported.reason).toContain('has a durable head')
  expect(snapshot(store, files)).toBe(before)
})

test('repairHead archives the raw v:2 legacy successor, never its hydrated view', async ($, on) => {
  const { id } = ids(34)
  const files = new Map<string, string>()
  const first = await durable(id, ledgerFor(id))
  const second = await durable(id, ledgerFor(id, { steps: [{ ...step('plan:2', 'Second step', 'pending'), session_id: id }] }), first.head.checkpoint)
  const { generation: _generation, ...legacy } = second.body
  const pointer = await compact(files, legacy as typeof second.body)
  const { store } = setup(on, id, { [`s:${id}`]: pointer, [`h:${id}`]: first.head }, files)
  await checkpoint($, id)
  const archives = [...store.held.entries()].filter(([key]) => key.startsWith(`r:${id}:conflict-`))
  expect(archives.length).toBe(1)
  const archived = archives[0]?.[1] as { value: { durable: { body: unknown; head: unknown } } }
  expect(JSON.stringify(archived.value.durable.body)).toBe(JSON.stringify(pointer))
  expect(archived.value.durable.head).toEqual(first.head)
})

test('a blob read that fails for a reason other than a missing file keeps its cause', async ($, on) => {
  const { id } = ids(35)
  const files = new Map<string, string>()
  const { body, head } = await durable(id, ledgerFor(id))
  const { store } = setup(on, id, { [`s:${id}`]: await compact(files, body), [`h:${id}`]: head }, files, { blobReadError: 'EACCES: permission denied' })
  const before = snapshot(store, files)
  const saved = await checkpoint($, id)
  expect(saved.ok).toBe(false)
  expect(saved.reason).toContain('blob unreadable')
  expect(saved.reason).toContain(DAMAGED)
  expect(saved.reason).toContain(KEPT)
  expect(snapshot(store, files)).toBe(before)
})

test('a blob read that fails because the file is missing still reads as a missing blob', async ($, on) => {
  const { id } = ids(36)
  const files = new Map<string, string>()
  const { body, head } = await durable(id, ledgerFor(id))
  const { store } = setup(on, id, { [`s:${id}`]: await compact(files, body), [`h:${id}`]: head }, files)
  for (const path of [...files.keys()]) files.delete(path)
  const before = snapshot(store, files)
  const saved = await checkpoint($, id)
  expect(saved.ok).toBe(false)
  expect(saved.reason).toContain(DAMAGED)
  expect(saved.reason).toContain(KEPT)
  expect(saved.reason).not.toContain('blob unreadable')
  expect(snapshot(store, files)).toBe(before)
})
