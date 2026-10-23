// FIXTURE: TRACK-39 U2. Whole-record replacements model a queued saver and safe
// old-blob eviction. They do not prove live host locking or sweep correctness.
import { expect, test } from 'claude-code/testing'
import { EMPTY, atomStore, blobPool, pluginStore } from './kit'
import type { Engine, On } from './kit'
import { describeCheckpoint } from '../hooks/checkpoint'
import type { Checkpoint } from '../hooks/checkpoint'

const CONFIG = '/fixture/config'
const BLOBS = `${CONFIG}/state/track/blobs`
const GENERATION = '39403940-3940-4940-8940-394039403940'
const DAMAGED = 'saved history blob is missing or damaged'
const ids = (n: number) => ({
  destination: `39403940-d390-4390-8390-${String(n).padStart(12, '0')}`,
  source: `39403940-5390-4390-8390-${String(n).padStart(12, '0')}`,
})

const ledgerFor = (session: string, label: string, expanded = false) => ({
  v: 1, nextQuestionId: expanded ? 3 : 2, prompts: [], session_id: session,
  questions: [
    { id: 1, head: `${label} question 😀`, at: 1, turnId: 'old', status: 'deferred', note: `${label} note`, session_id: session },
    ...(expanded ? [{ id: 2, head: `${label} answered question`, at: 2, turnId: 'old', status: 'answered', answerText: `${label} answer`, session_id: session }] : []),
  ],
  steps: [
    { id: 'plan:1', source: 'plan', subject: `${label} step`, status: 'in_progress', session_id: session },
    ...(expanded ? [{ id: 'plan:2', source: 'plan', subject: `${label} pending step`, status: 'pending', session_id: session }] : []),
  ],
})

const destinationFor = (session: string) => ({
  ...EMPTY, nextQuestionId: 8, session_id: session,
  questions: [{ id: 7, head: 'Destination original question', at: 7, turnId: 'local', status: 'open', note: 'Preserve me', session_id: session }],
})

const sha256 = async (text: string) => Array.from(new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
), byte => byte.toString(16).padStart(2, '0')).join('')

const snapshotFor = async (files: Map<string, string>, session: string, label: string, previous?: Checkpoint, expanded = false) => {
  const ledger = ledgerFor(session, label, expanded)
  const checkpoint = await describeCheckpoint(ledger as never, session, previous)
  const body = { v: 1, session_id: session, generation: GENERATION, savedAt: 1000, ledger, checkpoint }
  const head = { v: 1, session_id: session, generation: GENERATION, checkpoint }
  const text = JSON.stringify(ledger)
  const checksum = await sha256(text)
  const path = `${BLOBS}/${checksum}.json`
  files.set(path, text)
  const { ledger: _ledger, ...metadata } = body
  const pointer = { ...metadata, v: 2, ledger_blob: { checksum, bytes: new TextEncoder().encode(text).length } }
  return { ledger, checkpoint, body, head, pointer, path, text }
}
type SavedSnapshot = Awaited<ReturnType<typeof snapshotFor>>
type StoreWrite = { operation: 'set' | 'delete'; key: string }

const setup = (on: On, destination: string, records: Record<string, unknown>, files: Map<string, string>, memory = destinationFor(destination)) => {
  const l = atomStore<any>(on, 'ledger', memory)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'durability', { isUnsaved: false, reason: '', memorySession: destination })
  const reads: string[] = []
  const rawReads: string[] = []
  const writes: StoreWrite[] = []
  const publications: string[] = []
  // Fixture actor mutations bypass engine writes deliberately and are logged separately.
  const actor: string[] = []
  const controls: {
    beforeRead?: (path: string) => string | undefined;
    afterGet?: (key: string, value: unknown) => void;
    afterSet?: (key: string, value: unknown) => void;
  } = {}
  on('session.id', () => ({ value: destination }))
  on('session.append', (_, e, next) => next(e))
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? CONFIG : undefined }))
  on('fs.read', (_, e) => {
    reads.push(e.path)
    const denial = controls.beforeRead?.(e.path)
    if (denial !== undefined) return { deny: denial }
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT: no such file or directory, open '${e.path}'` } : { value: text }
  })
  on('fs.write', (_, e) => { files.set(e.path, String(e.text)); return { value: undefined } })
  // This differs from blobPool's helper-path matcher; never register it twice.
  on('process.run', { argv: /^publish$/ }, async (_, e, next) => {
    publications.push(e.argv[4] ?? '')
    return next(e)
  })
  const pool = blobPool(on, { configDir: CONFIG, files, readProviders: 'external' })
  // kit owns matcher-less handlers. Each observer has one distinct filtered matcher.
  on('store.get', { key: /^.+$/ }, async (_, e, next) => {
    rawReads.push(e.key)
    const result = await next(e)
    if (result.deny === undefined) controls.afterGet?.(e.key, result.value)
    return result
  })
  on('store.set', { key: /^.+$/ }, async (_, e, next) => {
    writes.push({ operation: 'set', key: e.key })
    const result = await next(e)
    if (result.deny === undefined) controls.afterSet?.(e.key, e.value)
    return result
  })
  on('store.delete', { key: /^.+$/ }, async (_, e, next) => {
    writes.push({ operation: 'delete', key: e.key })
    return next(e)
  })
  const store = pluginStore(on, records)
  return { l, store, reads, rawReads, writes, publications, pool, actor, controls }
}
type Fixture = ReturnType<typeof setup>

const replaceSource = (fixture: Fixture, files: Map<string, string>, source: string, oldPath: string, replacement?: SavedSnapshot, inline = false) => {
  if (replacement === undefined) {
    fixture.store.held.delete(`s:${source}`)
    fixture.actor.push(`delete:s:${source}`)
  } else {
    fixture.store.held.set(`s:${source}`, inline ? replacement.body : replacement.pointer)
    fixture.store.held.set(`h:${source}`, replacement.head)
    fixture.actor.push(`replace:s:${source}`, `replace:h:${source}`)
  }
  files.delete(oldPath)
  fixture.actor.push(`remove:${oldPath}`)
}

const restore = ($: Engine, source: string, expected?: Checkpoint) => $.tool.call({
  tool: 'mcp__track__restore_tracker', from_session: source, tool_use_id: 'reader-retry-restore',
  ...(expected === undefined ? {} : { expected_checkpoint: expected }),
} as never)
const receiptOf = (result: unknown) => JSON.parse(String(result ?? '{}'))
const sourceWrites = (fixture: Fixture, source: string) => fixture.writes.filter(write => write.key.includes(source))
const storeBytes = (fixture: Fixture) => JSON.stringify([...fixture.store.held.entries()].sort(([a], [b]) => a < b ? -1 : 1))
const sourceReads = (fixture: Fixture, snapshots: SavedSnapshot[]) => fixture.reads.filter(path => snapshots.some(snapshot => snapshot.path === path))

test('CHECKPOINT retries a replaced raw pointer only after body, head and index acknowledgement', async ($, on) => {
  const { destination: session } = ids(1)
  const files = new Map<string, string>()
  const a = await snapshotFor(files, session, 'A')
  const b = await snapshotFor(files, session, 'B', a.checkpoint, true)
  const fixture = setup(on, session, {}, files, a.ledger as never)
  const acknowledgements: string[] = []
  const expectedOrder = [`s:${session}`, `h:${session}`, 'saved']
  let pending: { key: string; text: string } | undefined
  let armed = false
  fixture.controls.afterSet = (key, value) => {
    if (key === expectedOrder[acknowledgements.length]) pending = { key, text: JSON.stringify(value) }
  }
  fixture.controls.afterGet = (key, value) => {
    if (pending?.key !== key || JSON.stringify(value) !== pending.text) return
    acknowledgements.push(key)
    pending = undefined
    armed = acknowledgements.length === expectedOrder.length
  }
  fixture.controls.beforeRead = path => {
    if (armed && path.startsWith(`${BLOBS}/`)) {
      armed = false
      replaceSource(fixture, files, session, path, b)
    }
    return undefined
  }
  const ran = await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: session } as never)
  const receipt = receiptOf(ran.result)
  expect(acknowledgements).toEqual(expectedOrder)
  expect(fixture.actor).toHaveLength(3)
  expect(receipt.ok).toBe(true)
  expect(receipt).toMatchObject(b.checkpoint)
  expect(receipt.counts).toEqual({ questions: 2, answers: 1, steps: 2 })
  expect(receipt.open_steps).toEqual([
    { id: 'plan:1', status: 'in_progress', subject: 'B step' },
    { id: 'plan:2', status: 'pending', subject: 'B pending step' },
  ])
  expect(receipt.checksum).not.toBe(a.checkpoint.checksum)
  expect(fixture.store.held.get(`s:${session}`)).toEqual(b.pointer)
})

for (const inline of [false, true]) {
  test(`RESTORE_TRACKER retries replacement by ${inline ? 'inline v:1' : 'blob v:2'} B and preserves the destination question`, async ($, on) => {
    const { destination, source } = ids(inline ? 3 : 2)
    const files = new Map<string, string>()
    const a = await snapshotFor(files, source, 'A')
    const b = await snapshotFor(files, source, 'B', a.checkpoint, true)
    // Inline replacement has no pre-published B blob to accidentally depend on.
    if (inline) files.delete(b.path)
    const fixture = setup(on, destination, { [`s:${source}`]: a.pointer, [`h:${source}`]: a.head }, files)
    const original = JSON.stringify(fixture.l.value.questions[0])
    fixture.controls.beforeRead = path => {
      if (path === a.path) replaceSource(fixture, files, source, path, b, inline)
      return undefined
    }
    const ran = await restore($, source)
    expect(ran.deny).toBeUndefined()
    expect(String(ran.result)).toContain('Restored 2 steps')
    expect(fixture.l.value.questions.map((q: { head: string }) => q.head)).toEqual([
      'Destination original question', 'B question 😀', 'B answered question',
    ])
    expect(JSON.stringify(fixture.l.value.questions[0])).toBe(original)
    expect(fixture.l.value.questions.slice(1)).toMatchObject([
      { head: 'B question 😀', status: 'deferred', note: 'B note', sourceId: `${source}:Q1`, restoredFrom: source },
      { head: 'B answered question', status: 'answered', answerText: 'B answer', sourceId: `${source}:Q2`, restoredFrom: source },
    ])
    expect(fixture.l.value.steps).toMatchObject([
      { id: 'plan:1', source: 'plan', subject: 'B step', status: 'in_progress', sourceId: `${source}:plan:1` },
      { id: 'plan:2', source: 'plan', subject: 'B pending step', status: 'pending', sourceId: `${source}:plan:2` },
    ])
    expect(fixture.l.value.steps).toHaveLength(2)
    expect(sourceReads(fixture, [a, b])).toEqual(inline ? [a.path] : [a.path, b.path])
    expect(sourceWrites(fixture, source)).toEqual([])
    expect(fixture.publications).not.toContain(a.pointer.ledger_blob.checksum)
    expect(fixture.publications).not.toContain(b.pointer.ledger_blob.checksum)
    expect(fixture.store.held.get(`s:${source}`)).toEqual(inline ? b.body : b.pointer)
    expect(fixture.store.held.get(`h:${source}`)).toEqual(b.head)
    expect(fixture.actor).toEqual([`replace:s:${source}`, `replace:h:${source}`, `remove:${a.path}`])
  })
}

for (const [index, fault] of ['missing', 'damaged', 'unreadable'].entries()) {
  test(`RESTORE_TRACKER refuses a stable ${fault} source after one hydration and keeps its visible fault category`, async ($, on) => {
    const { destination, source } = ids(10 + index)
    const files = new Map<string, string>()
    const a = await snapshotFor(files, source, 'A')
    if (fault === 'missing') files.delete(a.path)
    if (fault === 'damaged') files.set(a.path, `${a.text}damaged`)
    const fixture = setup(on, destination, { [`s:${source}`]: a.pointer, [`h:${source}`]: a.head }, files)
    if (fault === 'unreadable') fixture.controls.beforeRead = path => path === a.path ? 'EACCES: permission denied for source blob' : undefined
    const beforeStore = storeBytes(fixture)
    const beforeLedger = JSON.stringify(fixture.l.value)
    const ran = await restore($, source)
    expect(ran.deny).toContain(DAMAGED)
    expect(ran.deny).toContain('pointer was kept')
    expect(ran.deny).toContain(fault === 'unreadable' ? 'blob unreadable' : 'blob missing, changed or invalid')
    expect(sourceReads(fixture, [a])).toEqual([a.path])
    expect(storeBytes(fixture)).toBe(beforeStore)
    expect(JSON.stringify(fixture.l.value)).toBe(beforeLedger)
    expect(fixture.l.writes).toHaveLength(0)
    expect(fixture.writes).toEqual([])
    expect(fixture.pool.publishes).toBe(0)
    expect(fixture.actor).toEqual([])
  })
}

test('RESTORE_TRACKER stops continued replacement within three source snapshots before readable D', async ($, on) => {
  const { destination, source } = ids(20)
  const files = new Map<string, string>()
  const a = await snapshotFor(files, source, 'A')
  const b = await snapshotFor(files, source, 'B', a.checkpoint)
  const c = await snapshotFor(files, source, 'C', b.checkpoint)
  const d = await snapshotFor(files, source, 'D', c.checkpoint)
  const snapshots = [a, b, c, d]
  const fixture = setup(on, destination, { [`s:${source}`]: a.pointer, [`h:${source}`]: a.head }, files)
  const beforeLedger = JSON.stringify(fixture.l.value)
  fixture.controls.beforeRead = path => {
    const index = snapshots.findIndex(snapshot => snapshot.path === path)
    if (index >= 0 && index < 3) replaceSource(fixture, files, source, path, snapshots[index + 1])
    return undefined
  }
  const ran = await restore($, source)
  expect(ran.deny).toContain(DAMAGED)
  const hydrationReads = sourceReads(fixture, snapshots)
  expect(hydrationReads.length).toBeGreaterThan(0)
  expect(hydrationReads.length).toBeLessThanOrEqual(3)
  expect(hydrationReads).not.toContain(d.path)
  expect(fixture.rawReads.filter(key => key === `s:${source}`).length).toBeLessThanOrEqual(3)
  expect(files.get(d.path)).toBe(d.text)
  expect(JSON.stringify(fixture.l.value)).toBe(beforeLedger)
  expect(fixture.l.writes).toHaveLength(0)
  expect(fixture.writes).toEqual([])
  expect(fixture.pool.publishes).toBe(0)
  expect(fixture.actor.length).toBe(hydrationReads.length * 3)
  const lastReplacement = snapshots[hydrationReads.length]!
  expect(fixture.store.held.get(`s:${source}`)).toEqual(lastReplacement.pointer)
  expect(fixture.store.held.get(`h:${source}`)).toEqual(lastReplacement.head)
})

test('RESTORE_TRACKER expected_checkpoint rejects replacement B when the caller supplied A', async ($, on) => {
  const { destination, source } = ids(30)
  const files = new Map<string, string>()
  const a = await snapshotFor(files, source, 'A')
  const b = await snapshotFor(files, source, 'B', a.checkpoint, true)
  const fixture = setup(on, destination, { [`s:${source}`]: a.pointer, [`h:${source}`]: a.head }, files)
  const beforeLedger = JSON.stringify(fixture.l.value)
  fixture.controls.beforeRead = path => {
    if (path === a.path) replaceSource(fixture, files, source, path, b)
    return undefined
  }
  const ran = await restore($, source, a.checkpoint)
  const receipt = receiptOf(ran.result)
  expect(receipt).toMatchObject({ v: 1, ok: false, source_session: source, destination_session: destination })
  expect(receipt.reason).toContain('source checkpoint session, revision, checksum or counts do not match')
  expect(JSON.stringify(fixture.l.value)).toBe(beforeLedger)
  expect(fixture.l.writes).toHaveLength(0)
  expect(fixture.writes).toEqual([])
  expect(fixture.pool.publishes).toBe(0)
  expect(fixture.store.held.get(`s:${source}`)).toEqual(b.pointer)
  expect(fixture.store.held.get(`h:${source}`)).toEqual(b.head)
  expect(fixture.actor).toHaveLength(3)
})

for (const checkpointBound of [false, true]) {
  test(`RESTORE_TRACKER ${checkpointBound ? 'checkpoint-bound' : 'legacy'} source eviction preserves the empty-source refusal`, async ($, on) => {
    const { destination, source } = ids(checkpointBound ? 41 : 40)
    const files = new Map<string, string>()
    const a = await snapshotFor(files, source, 'A')
    const fixture = setup(on, destination, { [`s:${source}`]: a.pointer, [`h:${source}`]: a.head }, files)
    const beforeLedger = JSON.stringify(fixture.l.value)
    fixture.controls.beforeRead = path => {
      if (path === a.path) replaceSource(fixture, files, source, path)
      return undefined
    }
    const ran = await restore($, source, checkpointBound ? a.checkpoint : undefined)
    if (checkpointBound) {
      const receipt = receiptOf(ran.result)
      expect(receipt).toMatchObject({ v: 1, ok: false, source_session: source, destination_session: destination })
      expect(receipt.reason).toBe('source checkpoint is missing or incompatible')
    } else {
      expect(ran.deny).toBe(`track: No saved steps or questions for session ${source}; nothing changed.`)
    }
    expect(sourceReads(fixture, [a])).toEqual([a.path])
    expect(fixture.rawReads.filter(key => key === `s:${source}`).length).toBeLessThanOrEqual(2)
    expect(JSON.stringify(fixture.l.value)).toBe(beforeLedger)
    expect(fixture.l.writes).toHaveLength(0)
    expect(fixture.writes).toEqual([])
    expect(fixture.pool.publishes).toBe(0)
    expect(fixture.store.held.has(`s:${source}`)).toBe(false)
    expect(fixture.store.held.get(`h:${source}`)).toEqual(a.head)
    expect(fixture.actor).toEqual([`delete:s:${source}`, `remove:${a.path}`])
  })
}
