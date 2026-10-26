// FIXTURE, phase 2 identity contract (2026-10-26). Native execution belongs
// to the manager; these checks do not establish LIVE callback reachability.
import { expect, mock, test } from 'claude-code/testing'
import type { PluginState } from 'claude-code'
import { describeCheckpoint } from '../hooks/checkpoint'
import type { Activity, Ledger, Pending, Question, Turn } from '../types'
import { EMPTY, atomStore, blobPool, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'

const A = 'aaaaaaaa-0000-4000-8000-000000000002'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const FROM = '22222222-0000-4000-8000-000000000002'
const X = '11111111-0000-4000-8000-000000000002:Q1'
const Y = `${FROM}:Q1`
const BY = 'eeeeeeee-0000-4000-8000-000000000002'
const GENERATION = 'dddddddd-0000-4000-8000-000000000002'
const CONFIG = '/fixture/config'
const BLOBS = `${CONFIG}/state/track/blobs`
const NOW = 10000
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const encoder = new TextEncoder()
const hash = async (text: string) => Array.from(new Uint8Array(
  await crypto.subtle.digest('SHA-256', encoder.encode(text)),
), byte => byte.toString(16).padStart(2, '0')).join('')
const idle = (): Activity => ({ isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
const latch = () => {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  return { entered, released, enter, release }
}
type Latch = ReturnType<typeof latch>
type Door = 'session.start' | 'classic.SessionStart'
type Durability = PluginState['track']['durability']

// A real-time deadline separates fixture failures from named behavior failures.
// The mocked engine clock does not advance by itself.
const fixtureWait = async <T,>(request: Promise<T>, phase: string): Promise<T> => {
  const timers = globalThis as unknown as {
    setTimeout: (run: () => void, ms: number) => unknown; clearTimeout: (timer: unknown) => void
  }
  let timer: unknown
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = timers.setTimeout(() => reject(new Error(`INVALID FIXTURE: deadline during ${phase}`)), 2000)
    })])
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer)
  }
}
const outcome = async <T,>(request: Promise<T>) => {
  try { return { value: await request } }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
}
const requireHeld = async <T,>(held: Latch, request: Promise<T>, phase: string) => {
  const reached = await fixtureWait(Promise.race([
    held.entered.then(() => 'held'), request.then(() => 'returned'),
  ]), phase)
  if (reached !== 'held') throw new Error(`INVALID FIXTURE: ${phase} returned before its latch`)
}

const savedRows = (id: string, name: string): Ledger => ({ ...EMPTY, session_id: id, nextQuestionId: 2,
  questions: [{ session_id: id, id: 1, head: `${name} saved question`, at: 1,
    turnId: `${name}-saved-turn`, status: 'answered', answerText: `${name} complete saved answer`, note: `${name} saved note` }],
  steps: [{ session_id: id, id: 'plan:1', source: 'plan', subject: `${name} saved step`, status: 'pending', note: `${name} step context` }],
})
const seed = async (id: string, rows: Ledger, files: Map<string, string>) => {
  const text = JSON.stringify(rows)
  const ref = { checksum: await hash(text), bytes: encoder.encode(text).length }
  const path = `${BLOBS}/${ref.checksum}.json`
  files.set(path, text)
  const checkpoint = await describeCheckpoint(rows, id)
  const body = { v: 2, session_id: id, generation: GENERATION, savedAt: 1000, ledger_blob: ref, checkpoint }
  const head = { v: 1, session_id: id, generation: GENERATION, checkpoint }
  const entry = { at: 1000, bytes: encoder.encode(JSON.stringify({ [`s:${id}`]: body })).length + 1, unfinished: true }
  return { rows, text, path, body, head, entry }
}

const setup = async (on: On) => {
  const files = new Map<string, string>()
  const a = await seed(A, savedRows(A, 'A'), files)
  const b = await seed(B, savedRows(B, 'B'), files)
  const controls = { session: A, modelHold: undefined as Latch | undefined, taskHold: undefined as Latch | undefined,
    resumeHold: undefined as { path: string; held: Latch } | undefined, seedBOnLoad: false }
  const clock = mock.clock(on, { now: NOW })
  mock.session(on)
  // Observe before atomStore's provider. Seed B's volatile state when B loads,
  // after resume A has been queued, using only the existing atom boundary.
  on('state.set', (_, e, next) => {
    if (e.plugin === 'track' && e.key === 'durability' && controls.seedBOnLoad &&
        (e.value as Durability).memorySession === B && (e.value as Durability).baseline?.session_id === B) {
      controls.seedBOnLoad = false
      turn.value = { currentId: 'B-live-turn', gatedTurnId: null, stepReminder: 'B-only reminder' }
      activity.value = { ...idle(), isWorking: true, mainTurnId: 'B-live-turn', tasks: ['B-only-task'] }
      pending.value = { inputs: [{ id: 41, head: 'B-only input', excerpt: 'B-only input',
        textHash: 'b'.repeat(64), turnId: 'B-live-turn' }], nextId: 42 }
    }
    return next(e)
  })
  const memory = atomStore<Ledger>(on, 'ledger', { ...EMPTY, session_id: A })
  const pending = atomStore<Pending>(on, 'pending', { inputs: [], nextId: 1 })
  const turn = atomStore<Turn>(on, 'turn', { currentId: null, gatedTurnId: null })
  const activity = atomStore<Activity>(on, 'activity', idle())
  const durability = atomStore<Durability>(on, 'durability', { isUnsaved: false, reason: '', memorySession: A })
  atomStore(on, 'scroll', { questions: null, steps: null })
  const publications: string[] = []
  const blobReads: string[] = []
  const nativeCalls: string[] = []
  const pool = blobPool(on, { files, configDir: CONFIG, readProviders: 'external' })
  on('env.get', { name: /^CLAUDE_CONFIG_DIR$/ }, () => ({ value: CONFIG }))
  on('env.get', { name: /^HOME$/ }, () => ({ value: undefined }))
  on('fs.read', { path: /\/state\/track\/blobs\// }, async (_, e) => {
    blobReads.push(e.path)
    const held = controls.resumeHold?.path === e.path ? controls.resumeHold.held : undefined
    if (held !== undefined) { held.enter(); await held.released }
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`INVALID FIXTURE: missing blob ${e.path}`)
    return { value: text }
  })
  const store = pluginStore(on, { [`s:${A}`]: a.body, [`h:${A}`]: a.head,
    [`s:${B}`]: b.body, [`h:${B}`]: b.head, saved: { [A]: a.entry, [B]: b.entry } })
  const lines = logs(on)
  on('session.id', () => ({ value: controls.session }))
  on('classic.SessionStart', () => ({}))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('env.set', { name: 'TRACK_GATE_SNAPSHOT' }, (_, e) => {
    publications.push(String(e.value))
    return { value: {} }
  })
  on('model.complete', async () => {
    const held = controls.modelHold
    if (held !== undefined) { held.enter(); await held.released }
    return { value: { isAnswered: true, text: 'question', usage: USAGE } }
  })
  on('tool.call', { tool: 'TaskCreate' }, async (_, e) => {
    nativeCalls.push(String(e.subject))
    const held = controls.taskHold
    if (held !== undefined) { held.enter(); await held.released }
    return { result: { task: { id: String(e.tool_use_id) } } }
  })
  return { a, b, files, controls, clock, memory, pending, turn, activity, durability,
    pool, store, lines, publications, blobReads, nativeCalls }
}
type Fixture = Awaited<ReturnType<typeof setup>>
const directResume = async ($: Engine, door: Door, id: string) => door === 'classic.SessionStart'
  ? $.classic.SessionStart({ source: 'resume', session_id: id })
  : $.session.start({ cwd: '/fixture/work', surface: 'terminal', isInteractive: true })
const beginA = async ($: Engine, fixture: Fixture) => {
  await fixtureWait(directResume($, 'classic.SessionStart', A), 'initial A resume')
  expect(fixture.memory.value).toEqual(fixture.a.rows)
  expect(fixture.durability.value.memorySession).toBe(A)
}
const transientBytes = (fixture: Fixture) => JSON.stringify({ pending: fixture.pending.value,
  turn: fixture.turn.value, activity: fixture.activity.value })
const historyBytes = (fixture: Fixture, id: string, path: string) => JSON.stringify({
  body: fixture.store.held.get(`s:${id}`), head: fixture.store.held.get(`h:${id}`), blob: fixture.files.get(path),
})
// One legacy storage resume acquires exactly one write grant. Observe that
// existing protocol boundary instead of exposing resumeOwned or the epoch.
const writeGrants = (fixture: Fixture, id: string) => fixture.store.locks.spawns
  .filter(spawn => spawn.argv[2] === 'write' && spawn.argv[3] === id).length
const task = ($: Engine, id: string) => $.tool.call({ tool: 'TaskCreate', tool_use_id: id,
  subject: `Native work ${id}`, description: 'Exercise the admitted ownership token.' } as never)
const expectStaleNativeRefusal = (response: { error?: string; value?: { isError?: boolean; result?: unknown } }) => {
  expect(response.error).toBeUndefined()
  expect(response.value?.isError).toBe(true)
  expect(String(response.value?.result)).toContain('TaskCreate returned, but Track could not finish recording it: session owner changed during the call.')
  expect(String(response.value?.result)).toContain('Any native action already completed was not undone.')
}

const restoreRows = (cachedId: number, archiveId: number): Ledger => {
  const x: Question = { session_id: A, id: 1, sourceId: X, head: 'X unrelated answered question',
    at: 1, turnId: 'X-turn', status: 'answered', answerText: 'X full answer must survive', note: 'X status and note' }
  const y: Question = { session_id: A, id: 2, sourceId: Y, restoredFrom: FROM, restoredBy: BY,
    head: 'Y local answered question', at: 2, turnId: 'restored', status: 'answered',
    answerText: 'Y locally retained answer', note: 'Y local note' }
  return { ...EMPTY, session_id: A, nextQuestionId: 3, questions: [x, y],
    restoredIds: { [X]: 1, [Y]: cachedId }, restores: [{ session_id: A, by: BY, from: FROM,
      steps: 0, questions: [{ ...y, id: archiveId }], display: 'user' }] }
}
const prepareRestore = (fixture: Fixture, rows: Ledger) => {
  fixture.memory.value = rows
  fixture.store.held.delete(`s:${A}`)
  fixture.store.held.delete(`h:${A}`)
  fixture.store.held.set('saved', { [B]: fixture.b.entry })
  fixture.store.held.set(`s:${FROM}`, { v: 1, session_id: FROM, ledger: { ...EMPTY, nextQuestionId: 2,
    questions: [{ id: 1, sourceId: Y, head: 'Y refreshed source question', at: 2, turnId: 'source-turn',
      status: 'deferred', answerText: 'Y source answer', note: 'Y source note' }] } })
}
const restore = ($: Engine, replace: boolean, id: string) => $.tool.call({ tool: 'mcp__track__restore_tracker',
  from_session: FROM, replace, tool_use_id: id } as never)

test('FIXTURE phase2 I3: stale Y cache cannot replace unrelated X or move visible Y away from Q2', async ($, on) => {
  const fixture = await setup(on)
  const rows = restoreRows(1, 1)
  prepareRestore(fixture, rows)
  const xBytes = JSON.stringify(rows.questions[0])
  const result = await fixtureWait(restore($, true, 'identity-I3-replace'), 'I3 restore')
  expect(result.deny).toBeUndefined()
  expect(result.isError).not.toBe(true)
  expect({ I3_unrelated_X_bytes: JSON.stringify(fixture.memory.value.questions.find(q => q.sourceId === X)),
    I3_source_ids: fixture.memory.value.questions.map(q => [q.sourceId, q.id]), I3_cache: fixture.memory.value.restoredIds }).toEqual({
    I3_unrelated_X_bytes: xBytes, I3_source_ids: [[X, 1], [Y, 2]], I3_cache: { [X]: 1, [Y]: 2 },
  })
  expect(fixture.memory.value.questions.find(q => q.sourceId === Y)?.head).toBe('Y refreshed source question')
})

test('FIXTURE phase2 I3 allocation: a historic hint cannot occupy X or reuse a withdrawn number', async ($, on) => {
  const fixture = await setup(on)
  const rows = restoreRows(1, 1)
  rows.questions = rows.questions.filter(q => q.sourceId === X)
  rows.withdrawn = [{ session_id: A, id: 2, head: 'Withdrawn local work' }]
  prepareRestore(fixture, rows)
  const result = await fixtureWait(restore($, true, 'identity-I3-historic-hint'), 'I3 historic hint restore')
  expect(result.deny).toBeUndefined()
  expect(result.isError).not.toBe(true)
  expect({ I3_allocated_rows: fixture.memory.value.questions.map(q => [q.sourceId, q.id]),
    I3_unrelated_X: fixture.memory.value.questions.find(q => q.sourceId === X),
    I3_withdrawn: fixture.memory.value.withdrawn, I3_cache: fixture.memory.value.restoredIds,
    I3_next_id: fixture.memory.value.nextQuestionId }).toEqual({
    I3_allocated_rows: [[X, 1], [Y, 3]], I3_unrelated_X: rows.questions[0], I3_withdrawn: rows.withdrawn,
    I3_cache: { [X]: 1, [Y]: 3 }, I3_next_id: 4,
  })
})

test('FIXTURE phase2 I3 refusal: duplicate active stable identities preserve the original rows and store', async ($, on) => {
  const fixture = await setup(on)
  const rows = restoreRows(2, 2)
  rows.questions.push({ ...rows.questions[1]!, id: 3, head: 'Conflicting second Y row' })
  rows.nextQuestionId = 4
  prepareRestore(fixture, rows)
  const before = JSON.stringify({ rows: fixture.memory.value, store: [...fixture.store.held] })
  const result = await fixtureWait(restore($, true, 'identity-I3-ambiguous'), 'I3 ambiguous restore')
  expect({ I3_ambiguous_restore_refused: result.deny !== undefined || result.isError === true })
    .toEqual({ I3_ambiguous_restore_refused: true })
  expect(String(result.deny ?? result.result)).toMatch(/identity|ambiguous|collision/i)
  expect(JSON.stringify({ rows: fixture.memory.value, store: [...fixture.store.held] })).toBe(before)
})

for (const replace of [false, true]) {
  test(`FIXTURE phase2 I4: repeat replace=${replace} keeps ids, unrelated answers and archived native identity`, async ($, on) => {
    const fixture = await setup(on)
    const rows = restoreRows(2, 1)
    prepareRestore(fixture, rows)
    const expectedArchive = { ...rows.restores![0]!, questions: rows.restores![0]!.questions.map(q => ({ ...q, id: 2 })) }
    for (const repeat of [1, 2]) {
      const result = await fixtureWait(restore($, replace, `identity-I4-${replace}-${repeat}`), 'I4 repeat restore')
      expect(result.deny).toBeUndefined()
      expect(result.isError).not.toBe(true)
      expect(fixture.memory.value.questions.find(q => q.sourceId === X)).toEqual(rows.questions[0])
      expect(fixture.memory.value.questions.map(q => [q.sourceId, q.id])).toEqual([[X, 1], [Y, 2]])
      expect(fixture.memory.value.restoredIds).toEqual({ [X]: 1, [Y]: 2 })
      if (!replace) expect(fixture.memory.value.questions.find(q => q.sourceId === Y)).toEqual(rows.questions[1])
      else expect(fixture.memory.value.questions.find(q => q.sourceId === Y)).toMatchObject({
        id: 2, sourceId: Y, status: 'deferred', answerText: 'Y source answer', head: 'Y refreshed source question',
      })
      expect({ I4_original_native_archive: fixture.memory.value.restores?.find(r => r.by === BY) })
        .toEqual({ I4_original_native_archive: expectedArchive })
    }
  })
}

test('FIXTURE phase2 E1: direct B resume drops held A classifier work without changing B history', async ($, on) => {
  const fixture = await setup(on)
  await beginA($, fixture)
  const held = latch()
  fixture.controls.modelHold = held
  fixture.store.held.set('classifier', { isOn: true })
  const bBefore = historyBytes(fixture, B, fixture.b.path)
  await fixtureWait($.prompt.submit({ text: 'Why is A still waiting?', wait: false,
    origin: { kind: 'composer' } }), 'E1 A prompt')
  await fixtureWait(fixture.clock.advance(1), 'E1 start classifier')
  try {
    await fixtureWait(held.entered, 'E1 classifier latch')
    fixture.controls.session = B
    await fixtureWait(directResume($, 'classic.SessionStart', B), 'E1 direct B resume')
    const publicationsAfterResume = fixture.publications.length
    held.release()
    await fixtureWait(fixture.clock.settle(), 'E1 release classifier')
    expect({ E1_pending_after_direct_resume: fixture.pending.value.inputs,
      E1_turn: fixture.turn.value, E1_activity: fixture.activity.value,
      E1_memory: fixture.memory.value, E1_B_history: historyBytes(fixture, B, fixture.b.path),
      E1_late_publications: fixture.publications.slice(publicationsAfterResume) }).toEqual({
      E1_pending_after_direct_resume: [], E1_turn: { currentId: null, gatedTurnId: null }, E1_activity: idle(),
      E1_memory: fixture.b.rows, E1_B_history: bBefore, E1_late_publications: [],
    })
  } finally {
    held.release()
    await fixtureWait(fixture.clock.settle(), 'E1 cleanup')
  }
})

test('FIXTURE phase2 E2: old A native completion cannot mint into an empty unowned B ledger', async ($, on) => {
  const fixture = await setup(on)
  await beginA($, fixture)
  const held = latch()
  fixture.controls.taskHold = held
  const request = outcome(task($, 'identity-E2-old'))
  try {
    await requireHeld(held, request, 'E2 native admission')
    // A host clears memory before selecting a B session with no saved body.
    // These are existing atoms, not an epoch setter or a production test hook.
    fixture.memory.value = { ...EMPTY }
    fixture.durability.value = { isUnsaved: false, reason: '' }
    fixture.store.held.delete(`s:${B}`)
    fixture.store.held.delete(`h:${B}`)
    fixture.store.held.set('saved', { [A]: fixture.a.entry })
    fixture.controls.session = B
    await fixtureWait(directResume($, 'classic.SessionStart', B), 'E2 empty B resume')
    const bBefore = historyBytes(fixture, B, fixture.b.path)
    held.release()
    const result = await fixtureWait(request, 'E2 native completion')
    expect({ E2_empty_destination_rows: fixture.memory.value.steps,
      E2_B_history: historyBytes(fixture, B, fixture.b.path), E2_native_calls: fixture.nativeCalls })
      .toEqual({ E2_empty_destination_rows: [], E2_B_history: bBefore, E2_native_calls: ['Native work identity-E2-old'] })
    expectStaleNativeRefusal(result)
  } finally {
    held.release()
    await fixtureWait(request, 'E2 cleanup')
  }
})

for (const door of ['session.start', 'classic.SessionStart'] as const) {
  test(`FIXTURE phase2 E3 ${door}: same-target resume preserves atoms, refuses old token and accepts a new token`, async ($, on) => {
    const fixture = await setup(on)
    await beginA($, fixture)
    fixture.pending.value = { inputs: [{ id: 7, head: 'A pending question?', excerpt: 'A pending question?',
      textHash: 'a'.repeat(64), turnId: 'A-live-turn', held: true, label: 'question' }], nextId: 8 }
    fixture.turn.value = { currentId: 'A-live-turn', gatedTurnId: 'A-live-turn', eventOrder: 12, stepReminder: 'A reminder',
      freshness: { turnId: 'A-live-turn', edits: ['A-edit'], bash: [], steps: [], completed: [], waiting: [], held: [], nudged: [] } }
    fixture.activity.value = { ...idle(), isWorking: true, mainTurnId: 'A-live-turn', tasks: ['A-task'], owners: { 'A-task': ['plan:1'] } }
    const before = transientBytes(fixture)
    const held = latch()
    fixture.controls.taskHold = held
    const request = outcome(task($, `identity-E3-old-${door}`))
    try {
      await requireHeld(held, request, 'E3 native admission')
      const grants = writeGrants(fixture, A)
      await fixtureWait(directResume($, door, A), 'E3 same-target direct resume')
      expect({ E3_preserved_atom_bytes: transientBytes(fixture), E3_storage_resumes: writeGrants(fixture, A) - grants })
        .toEqual({ E3_preserved_atom_bytes: before, E3_storage_resumes: 1 })
      held.release()
      const result = await fixtureWait(request, 'E3 old native completion')
      expectStaleNativeRefusal(result)
      expect({ E3_no_old_row: fixture.memory.value, E3_no_late_atom_change: transientBytes(fixture) })
        .toEqual({ E3_no_old_row: fixture.a.rows, E3_no_late_atom_change: before })
      fixture.controls.taskHold = undefined
      const fresh = await fixtureWait(task($, `identity-E3-fresh-${door}`), 'E3 fresh native operation')
      expect(fresh.deny).toBeUndefined()
      expect(fresh.isError).not.toBe(true)
      expect(fixture.memory.value.steps.some(step => step.taskId === `identity-E3-fresh-${door}`)).toBe(true)
    } finally {
      held.release()
      await fixtureWait(request, 'E3 cleanup')
    }
  })
}

test('FIXTURE phase2 R3: queued A-B-A decides target ownership at execution and clears B atoms', async ($, on) => {
  const fixture = await setup(on)
  await beginA($, fixture)
  const held = latch()
  fixture.controls.resumeHold = { path: fixture.b.path, held }
  fixture.controls.seedBOnLoad = true
  fixture.controls.session = B
  const first = outcome(directResume($, 'classic.SessionStart', B))
  let second: Promise<Awaited<typeof first>> | undefined
  try {
    await requireHeld(held, first, 'R3 B resume held before load')
    fixture.controls.session = A
    second = outcome(directResume($, 'classic.SessionStart', A))
    await fixtureWait(fixture.clock.settle(), 'R3 queue final A resume')
    held.release()
    const results = await fixtureWait(Promise.all([first, second]), 'R3 queued resumes')
    expect(results.map(result => result?.error)).toEqual([undefined, undefined])
    expect({ R3_B_state_was_seeded: !fixture.controls.seedBOnLoad, R3_owner: fixture.durability.value.memorySession,
      R3_memory: fixture.memory.value, R3_pending: fixture.pending.value.inputs,
      R3_turn: fixture.turn.value, R3_activity: fixture.activity.value }).toEqual({
      R3_B_state_was_seeded: true, R3_owner: A, R3_memory: fixture.a.rows, R3_pending: [],
      R3_turn: { currentId: null, gatedTurnId: null }, R3_activity: idle(),
    })
  } finally {
    held.release()
    await fixtureWait(Promise.all([first, second]), 'R3 cleanup')
  }
})

test('FIXTURE phase2 R4: overlapping same-target callbacks share one storage transition and old-token fence', async ($, on) => {
  const fixture = await setup(on)
  await beginA($, fixture)
  fixture.pending.value = { inputs: [{ id: 7, head: 'A pending question?', excerpt: 'A pending question?',
    textHash: 'a'.repeat(64), turnId: 'A-live-turn', held: true, label: 'question' }], nextId: 8 }
  fixture.turn.value = { currentId: 'A-live-turn', gatedTurnId: 'A-live-turn', eventOrder: 12, stepReminder: 'A reminder',
    freshness: { turnId: 'A-live-turn', edits: ['A-edit'], bash: [], steps: [], completed: [], waiting: [], held: [], nudged: [] } }
  fixture.activity.value = { ...idle(), isWorking: true, mainTurnId: 'A-live-turn', tasks: ['A-task'], owners: { 'A-task': ['plan:1'] } }
  const native = latch()
  const resume = latch()
  fixture.controls.taskHold = native
  const old = outcome(task($, 'identity-R4-old'))
  let first: Promise<unknown> | undefined
  let second: Promise<unknown> | undefined
  try {
    await requireHeld(native, old, 'R4 old native admission')
    const grants = writeGrants(fixture, A)
    const before = transientBytes(fixture)
    fixture.controls.resumeHold = { path: fixture.a.path, held: resume }
    first = outcome(directResume($, 'classic.SessionStart', A))
    await requireHeld(resume, first, 'R4 first direct resume')
    second = outcome(directResume($, 'session.start', A))
    await fixtureWait(fixture.clock.settle(), 'R4 overlapping second callback')
    resume.release()
    await fixtureWait(Promise.all([first, second]), 'R4 both direct callbacks')
    expect({ R4_storage_resumes: writeGrants(fixture, A) - grants,
      R4_preserved_atoms: transientBytes(fixture) }).toEqual({
      R4_storage_resumes: 1, R4_preserved_atoms: before,
    })
    native.release()
    expectStaleNativeRefusal(await fixtureWait(old, 'R4 old native completion'))
    fixture.controls.taskHold = undefined
    const fresh = await fixtureWait(task($, 'identity-R4-fresh'), 'R4 fresh token')
    expect(fresh.deny).toBeUndefined()
    expect(fresh.isError).not.toBe(true)
    expect(fixture.memory.value.steps.map(step => step.taskId).filter(id => id !== undefined)).toEqual(['identity-R4-fresh'])
  } finally {
    native.release()
    resume.release()
    await fixtureWait(Promise.all([old, first, second]), 'R4 cleanup')
  }
})
