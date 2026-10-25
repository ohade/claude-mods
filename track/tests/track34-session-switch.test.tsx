// FIXTURE, TRACK-34 Unit 2 (2026-10-24): the first event after an in-process
// session switch must select its own history before reading or changing Track.
// Native execution belongs to Claude. These fixtures do not claim LIVE resume proof.
import { expect, mock, test } from 'claude-code/testing'
import type { PluginState } from 'claude-code'
import { describeCheckpoint } from '../hooks/checkpoint'
import type { Activity, Ledger, Pending, Turn } from '../types'
import { EMPTY, atomStore, blobPool, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'

const A = 'aaaaaaaa-0000-4000-8000-000000000034'
const B = 'bbbbbbbb-0000-4000-8000-000000000034'
const C = 'cccccccc-0000-4000-8000-000000000034'
const GENERATION = 'dddddddd-0000-4000-8000-000000000034'
const CONFIG = '/fixture/config'
const BLOBS = `${CONFIG}/state/track/blobs`
const NOW = 10000
const B_RESULT = 'B completed the independently requested result.'
const B_MARK = 'unit2-b-mark'
const IDENTITY_FAILURE = 'TRACK34 injected session.id read failure'
const READ_FAILURE = 'TRACK34 injected B resume store refusal'
const LEASE_FAILURE = 'TRACK34 injected B writer lease refusal'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const encoder = new TextEncoder()
const hash = async (text: string) => Array.from(new Uint8Array(
  await crypto.subtle.digest('SHA-256', encoder.encode(text)),
), byte => byte.toString(16).padStart(2, '0')).join('')
const idle = (): Activity => ({ isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })

// Values come from fixture inputs, never from the ledger produced by the plugin.
const savedRows = async (id: string, name: string): Promise<Ledger> => ({
  v: 1, session_id: id, nextQuestionId: 3,
  prompts: [{ session_id: id, rowKey: `${name}-saved-prompt`, requestId: `${name}-saved-source`,
    head: `${name} saved prompt`, at: 1, turnId: `${name}-saved-turn` }],
  questions: [
    { session_id: id, id: 1, head: `${name} answered question`, at: 2, turnId: `${name}-saved-turn`,
      status: 'answered', rowKey: `${name}-saved-prompt`, askedRequestId: `${name}-saved-source`,
      trackedBy: `${name}-question-call`, answerText: `${name} complete saved answer.`,
      answerTextHash: await hash(JSON.stringify(`${name} complete saved answer.`)), answerKey: `${name}-answer-call`,
      answerRequestId: `${name}-answer-call`, answeredBy: `${name}-answer-call`, answeredAt: 3 },
    { session_id: id, id: 2, head: `${name} open question`, at: 4, turnId: `${name}-saved-turn`,
      status: 'open', trackedBy: `${name}-open-call`, note: `${name} question context` },
  ],
  steps: [{ session_id: id, id: 'plan:1', source: 'plan', subject: `${name} saved step`,
    status: 'completed', note: `${name} step context`, startedAt: 10, endedAt: 20,
    resultText: `${name} complete saved step result.`, resultTextHash: await hash(JSON.stringify(`${name} complete saved step result.`)),
    resultRequestId: `${name}-result-call`, resultAt: 20 }],
})

// Use the accepted checkpoint helper only to seed valid bodies/heads, as own-save
// tests do. All post-event row expectations are written independently below.
const seed = async (id: string, rows: Ledger, files: Map<string, string>) => {
  const text = JSON.stringify(rows)
  const ref = { checksum: await hash(text), bytes: encoder.encode(text).length }
  const path = `${BLOBS}/${ref.checksum}.json`
  files.set(path, text)
  const checkpoint = await describeCheckpoint(rows, id)
  const body = { v: 2, session_id: id, generation: GENERATION, savedAt: 1000, ledger_blob: ref, checkpoint }
  const head = { v: 1, session_id: id, generation: GENERATION, checkpoint }
  const entry = { at: 1000, bytes: encoder.encode(JSON.stringify({ [`s:${id}`]: body })).length + 1, unfinished: true }
  return { rows, body, head, entry, path, text }
}

const latch = () => {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  return { entered, released, enter, release }
}
type Latch = ReturnType<typeof latch>
type Durability = PluginState['track']['durability']
type PromptObservation = { text: string; context: readonly string[]; ledger: Ledger; pending: Pending; turn: Turn; activity: Activity }

const setup = async (on: On, bStoreWrites?: Array<{ key: string; value: unknown }>,
  extraSteps: Partial<Record<string, Ledger['steps']>> = {}) => {
  const files = new Map<string, string>()
  const rows = async (id: string, name: string) => {
    const saved = await savedRows(id, name)
    return { ...saved, steps: [...saved.steps, ...(extraSteps[id] ?? [])] }
  }
  const a = await seed(A, await rows(A, 'A'), files)
  const b = await seed(B, await rows(B, 'B'), files)
  const c = await seed(C, await rows(C, 'C'), files)
  const saved = { [A]: a.entry, [B]: b.entry, [C]: c.entry }
  const controls = { session: A, identityFailure: '', identityFailOnce: false, readFailure: '', resumeHold: undefined as Latch | undefined,
    taskHold: undefined as Latch | undefined,
    todoHold: undefined as Latch | undefined, updateHold: undefined as Latch | undefined,
    workHold: undefined as Latch | undefined, updateSuccess: true,
    modelReply: async (_text: string): Promise<'question' | 'not_question'> => 'not_question' }
  const lease: { leaseFailure?: string; refuseSet?: (key: string, value: unknown) => string | undefined } = {}
  const identityReads: string[] = []
  const readRefusals: string[] = []
  const modelCalls: string[] = []
  const promptCalls: PromptObservation[] = []
  const taskCalls: Array<{ subject: unknown; ledger: Ledger }> = []
  const todoCalls: Array<{ todos: unknown; ledger: Ledger }> = []
  const updateCalls: Array<{ taskId: unknown; status: unknown; ledger: Ledger }> = []
  const workCalls: Array<{ command: unknown; ledger: Ledger }> = []
  const mutationAttempts: Ledger[] = []
  const starts: string[] = []
  const clock = mock.clock(on, { now: NOW })
  const session = mock.session(on)
  // This observer has no matcher, unlike atomStore's ledger provider. It relays
  // the real CAS write. The requested result is unique to these tests.
  on('state.set', (_, e, next) => {
    if (e.plugin === 'track' && e.key === 'ledger') {
      const value = e.value as Ledger
      if (value.steps.some(step => step.resultText === B_RESULT)) mutationAttempts.push(structuredClone(value))
    }
    return next(e)
  })
  const memory = atomStore<Ledger>(on, 'ledger', { ...EMPTY, session_id: A })
  const pending = atomStore<Pending>(on, 'pending', { inputs: [], nextId: 1 })
  const turn = atomStore<Turn>(on, 'turn', { currentId: null, gatedTurnId: null })
  const activity = atomStore<Activity>(on, 'activity', idle())
  const durability = atomStore<Durability>(on, 'durability', { isUnsaved: false, reason: '', memorySession: A })
  atomStore(on, 'scroll', { questions: null, steps: null })
  // One provider is registered once. Every transition changes only its captured
  // session value; its throwing branch is the native fault control, not a deny.
  on('session.id', () => {
    const failure = controls.identityFailure
    identityReads.push(failure || controls.session)
    if (failure !== '') {
      if (controls.identityFailOnce) {
        controls.identityFailure = ''
        controls.identityFailOnce = false
      }
      throw new Error(failure)
    }
    return { value: controls.session }
  }).catch((_, _e, next) => ({ deny: next.error.message ?? 'TRACK34 session.id fixture failed without a reason' }))
  on('store.get', { key: /^s:/ }, (_, e, next) => {
    if (e.key === `s:${B}` && controls.readFailure !== '') {
      readRefusals.push(controls.readFailure)
      return { deny: controls.readFailure }
    }
    return next(e)
  })
  on('fs.read', { path: /\/state\/track\/blobs\// }, async (_, e, next) => {
    if (e.path === b.path && controls.resumeHold !== undefined) {
      controls.resumeHold.enter()
      await controls.resumeHold.released
    }
    return next(e)
  })
  const pool = blobPool(on, { files, configDir: CONFIG })
  // Native tests register hooks before their first engine call. Opted-in cases
  // observe writes without changing the store provider's return value.
  if (bStoreWrites !== undefined) lease.refuseSet = (key, value) => {
    if (key === `s:${B}` || key === `h:${B}`) bStoreWrites.push({ key, value: structuredClone(value) })
    return undefined
  }
  const store = pluginStore(on, { [`s:${A}`]: a.body, [`h:${A}`]: a.head,
    [`s:${B}`]: b.body, [`h:${B}`]: b.head, [`s:${C}`]: c.body, [`h:${C}`]: c.head, saved }, undefined, lease)
  const lines = logs(on)
  on('classic.SessionStart', (_, e) => { starts.push(e.session_id); return {} })
  on('session.messages', () => ({ value: [{ role: 'assistant', text: '', toolUses:
    ['A', 'B', 'C'].flatMap(name => ['question', 'open', 'answer', 'result'].map(kind => ({
      tool_use_id: `${name}-${kind}-call`, tool: 'fixture_saved_call', input: {},
    }))) }] }))
  on('prompt.submit', (_, e) => {
    promptCalls.push({ text: e.text, context: [...(e.context ?? [])], ledger: structuredClone(memory.value),
      pending: structuredClone(pending.value), turn: structuredClone(turn.value), activity: structuredClone(activity.value) })
    return { text: e.text, context: e.context }
  })
  on('model.complete', async (_, e) => {
    modelCalls.push(e.prompt)
    return { value: { isAnswered: true, text: await controls.modelReply(e.prompt), usage: USAGE } }
  })
  // A real TaskCreate handler beneath Track makes refusal observable before
  // the task itself executes, rather than inferring execution from log text.
  on('tool.call', { tool: 'TaskCreate' }, (_, e) => {
    taskCalls.push({ subject: e.subject, ledger: structuredClone(memory.value) })
    const held = controls.taskHold
    if (held !== undefined) {
      held.enter()
      return held.released.then(() => ({ result: { task: { id: 'unit2-a-held-task' } } }))
    }
    return { result: { task: { id: 'unit2-b-task' } } }
  })
  on('tool.call', { tool: 'TodoWrite' }, async (_, e) => {
    todoCalls.push({ todos: structuredClone(e.todos), ledger: structuredClone(memory.value) })
    const held = controls.todoHold
    if (held !== undefined) { held.enter(); await held.released }
    return { result: { newTodos: e.todos } }
  })
  on('tool.call', { tool: 'TaskUpdate' }, async (_, e) => {
    updateCalls.push({ taskId: e.taskId, status: e.status, ledger: structuredClone(memory.value) })
    const held = controls.updateHold
    if (held !== undefined) { held.enter(); await held.released }
    return { result: { success: controls.updateSuccess } }
  })
  on('tool.call', { tool: 'Bash' }, async (_, e) => {
    workCalls.push({ command: e.command, ledger: structuredClone(memory.value) })
    const held = controls.workHold
    if (held !== undefined) { held.enter(); await held.released }
    return { result: 'fixture A command completed' }
  })
  return { a, b, c, saved, files, controls, lease, clock, session, memory, pending, turn, activity, durability,
    pool, store, lines, identityReads, readRefusals, modelCalls, promptCalls, taskCalls, todoCalls, updateCalls, workCalls, mutationAttempts, starts }
}
type Fixture = Awaited<ReturnType<typeof setup>>

const beginA = async ($: Engine, fixture: Fixture) => {
  // The only resume callback in each fixture loads A through resumeOwned and
  // the actual blob reader. A->B below never raises either start callback.
  await $.classic.SessionStart({ source: 'resume', session_id: A })
  expect({ ledger: fixture.memory.value, owner: fixture.durability.value.memorySession,
    baseline: fixture.durability.value.baseline, starts: fixture.starts }).toEqual({
    ledger: fixture.a.rows, owner: A, baseline: baseline(fixture.a, A), starts: [A],
  })
}
const baseline = (saved: Fixture['a'], id: string) => ({ session_id: id, ledger: saved.rows,
  checkpoint: saved.head.checkpoint, generation: GENERATION })
const archives = (fixture: Fixture) => [...fixture.store.held.entries()]
  .filter(([key]) => key.startsWith('r:')).map(([, value]) => value)
const expectedArchive = (rows: Ledger) => [{ v: 1, session_id: B, kind: 'session-switch',
  value: { source_session: A, ledger: rows } }]
const history = async (fixture: Fixture, id: string, saved: Fixture['a']) => ({
  bodyBytes: JSON.stringify(fixture.store.held.get(`s:${id}`)), headBytes: JSON.stringify(fixture.store.held.get(`h:${id}`)),
  blobBytes: fixture.files.get(saved.path), ledger: (await fixture.pool.logical(fixture.store, `s:${id}`) as { ledger: Ledger }).ledger,
})
const expectedHistory = (saved: Fixture['a']) => ({ bodyBytes: JSON.stringify(saved.body),
  headBytes: JSON.stringify(saved.head), blobBytes: saved.text, ledger: saved.rows })
const ownership = (fixture: Fixture) => ({ memorySession: fixture.durability.value.memorySession,
  baseline: fixture.durability.value.baseline })
const unchangedState = async (fixture: Fixture) => ({ memory: fixture.memory.value,
  a: await history(fixture, A, fixture.a), b: await history(fixture, B, fixture.b), c: await history(fixture, C, fixture.c),
  saved: fixture.store.held.get('saved'), archives: archives(fixture), ownership: ownership(fixture), starts: fixture.starts })
const expectedSelectedB = (fixture: Fixture, memory: unknown, archived = fixture.a.rows) => ({ memory,
  a: expectedHistory(fixture.a), b: expectedHistory(fixture.b), c: expectedHistory(fixture.c), saved: fixture.saved,
  archives: expectedArchive(archived), ownership: { memorySession: B, baseline: baseline(fixture.b, B) }, starts: [A] })
const expectedStillA = (fixture: Fixture) => ({ memory: fixture.a.rows,
  a: expectedHistory(fixture.a), b: expectedHistory(fixture.b), c: expectedHistory(fixture.c), saved: fixture.saved,
  archives: [], ownership: { memorySession: A, baseline: baseline(fixture.a, A) }, starts: [A] })
const pendingQuestion = async (text: string) => ({ inputs: [{ id: expect.any(Number), head: text,
  excerpt: text, textHash: await hash(JSON.stringify(text)), turnId: null }], nextId: expect.any(Number) })
const submit = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
const markB = ($: Engine) => $.tool.call({ tool: 'mcp__track__mark_step', tool_use_id: B_MARK,
  id: 'plan:1', status: 'completed', result_text: B_RESULT } as never)
const changedB = async (fixture: Fixture): Promise<Ledger> => ({ ...fixture.b.rows, steps: [{
  session_id: B, id: 'plan:1', source: 'plan', subject: 'B saved step', status: 'completed', note: 'B step context',
  startedAt: 10, endedAt: 20, resultText: B_RESULT, resultTextHash: await hash(JSON.stringify(B_RESULT)), resultRequestId: B_MARK, resultAt: NOW,
}] })
const appendB = (door: 'prompt' | 'delivery', text: string) => ({ door, origin: { kind: 'composer' as const },
  uuid: 'eeeeeeee-0000-4000-8000-000000000034', message: { type: door === 'prompt' ? 'user' as const : 'attachment' as const,
    ...(door === 'delivery' && { name: 'queued_command' }), role: 'user' as const, content: [{ type: 'text' as const, text }] } })
const outcome = async <T,>(request: Promise<T>) => {
  try { return { value: await request } }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
}
const refusalText = (result: unknown) => JSON.stringify(result)

test('FIXTURE TRACK34 session switch 01: first B prompt.submit selects B before pending and context reads', async ($, on) => {
  const fixture = await setup(on)
  await beginA($, fixture)
  fixture.controls.session = B
  const text = 'Why is B still open?'
  const result = await submit($, text)
  // Named stale-session assertion: memory and both complete histories must agree.
  expect(await unchangedState(fixture)).toEqual(expectedSelectedB(fixture, fixture.b.rows))
  expect(fixture.promptCalls.map(call => ({ text: call.text, ledger: call.ledger, pending: call.pending })))
    .toEqual([{ text, ledger: fixture.b.rows, pending: await pendingQuestion(text) }])
  expect(fixture.pending.value).toEqual(await pendingQuestion(text))
  expect(result.drop).toBeUndefined()
  expect(fixture.promptCalls[0]!.context.join('\n')).toContain('question:2 "B open question"')
})

for (const door of ['prompt', 'delivery'] as const) {
  test(`FIXTURE TRACK34 session switch ${door === 'prompt' ? '02' : '03'}: first B session.append ${door}${door === 'delivery' ? '/queued_command' : ''} records only B`, async ($, on) => {
    const fixture = await setup(on)
    await beginA($, fixture)
    fixture.controls.session = B
    const text = `B ${door} typed work`
    const event = appendB(door, text)
    const result = await $.session.append(event as never)
    const expectedMemory = { ...fixture.b.rows, prompts: [...fixture.b.rows.prompts,
      { rowKey: 'eeeeeeee-0000-4000-8000', head: text, turnId: null, at: expect.any(Number) }] }
    expect(await unchangedState(fixture)).toEqual(expectedSelectedB(fixture, expectedMemory))
    expect(result).toEqual({ message: event.message, uuid: event.uuid })
    expect(fixture.session.appended()).toEqual([event])
    expect(fixture.pending.value).toEqual({ inputs: [], nextId: 1 })
  })
}

test('FIXTURE TRACK34 session switch 04: first B lookup_rows returns B labels and full saved rows', async ($, on) => {
  const fixture = await setup(on)
  await beginA($, fixture)
  fixture.controls.session = B
  const result = await $.tool.call({ tool: 'mcp__track__lookup_rows' } as never)
  expect({ receipt: JSON.parse(String(result.result)), state: await unchangedState(fixture) }).toEqual({
    receipt: { ok: true, rows: [
      { label: 'S1', id: 'plan:1', kind: 'step', status: 'completed', subject: 'B saved step' },
      { label: 'Q1', id: 'question:1', kind: 'question', status: 'answered', subject: 'B answered question' },
      { label: 'Q2', id: 'question:2', kind: 'question', status: 'open', subject: 'B open question' },
    ] }, state: expectedSelectedB(fixture, fixture.b.rows),
  })
})

const expectBResult = async (fixture: Fixture) => {
  const expected = await changedB(fixture)
  const logical = await fixture.pool.logical(fixture.store, `s:${B}`) as { ledger: Ledger }
  expect({ memory: fixture.memory.value, durableB: logical.ledger, a: await history(fixture, A, fixture.a),
    c: await history(fixture, C, fixture.c), archives: archives(fixture), owner: fixture.durability.value.memorySession,
    acknowledged: fixture.durability.value.baseline?.ledger, starts: fixture.starts }).toEqual({
    memory: expected, durableB: expected, a: expectedHistory(fixture.a), c: expectedHistory(fixture.c),
    archives: expectedArchive(fixture.a.rows), owner: B, acknowledged: expected, starts: [A],
  })
  const raw = fixture.store.held.get(`s:${B}`) as { v: number; session_id: string; generation: string; checkpoint: unknown }
  expect({ v: raw.v, session: raw.session_id, generation: raw.generation }).toEqual({ v: 2, session: B, generation: GENERATION })
  expect(fixture.store.held.get(`h:${B}`)).toEqual({ v: 1, session_id: B, generation: GENERATION, checkpoint: raw.checkpoint })
}

test('FIXTURE TRACK34 session switch 05: first B mark_step changes B plan:1 and keeps A body/head byte-equivalent', async ($, on) => {
  const fixture = await setup(on)
  await beginA($, fixture)
  fixture.controls.session = B
  const result = await markB($)
  await expectBResult(fixture)
  expect(result.deny).toBeUndefined()
  expect(result.isError).not.toBe(true)
  expect(String(result.result)).toContain('"B saved step" marked completed')
})

test('FIXTURE TRACK34 session switch 06: unsaved A is archived exactly before B acknowledged rows load', async ($, on) => {
  const fixture = await setup(on)
  await beginA($, fixture)
  const unsaved: Ledger = { ...fixture.a.rows, nextQuestionId: 4,
    prompts: [...fixture.a.rows.prompts, { session_id: A, rowKey: 'A-unsaved-prompt', head: 'A unsaved typed work', at: 30, turnId: 'A-unsaved-turn' }],
    questions: [...fixture.a.rows.questions, { session_id: A, id: 3, head: 'A unsaved question', at: 31,
      turnId: 'A-unsaved-turn', status: 'deferred', note: 'A unsaved owner context' }],
    steps: [...fixture.a.rows.steps, { session_id: A, id: 'plan:local-A', source: 'plan', subject: 'A unsaved step',
      status: 'in_progress', startedAt: 32, activeTurnId: 'A-unsaved-turn', note: 'A unsaved step context' }] }
  fixture.memory.value = unsaved
  fixture.durability.value = { ...fixture.durability.value, isUnsaved: true, reason: 'A local unsaved work' }
  fixture.controls.session = B
  await $.tool.call({ tool: 'mcp__track__lookup_rows' } as never)
  expect(await unchangedState(fixture)).toEqual(expectedSelectedB(fixture, fixture.b.rows, unsaved))
  expect({ isUnsaved: fixture.durability.value.isUnsaved, reason: fixture.durability.value.reason }).toEqual({ isUnsaved: false, reason: '' })
})

test('FIXTURE TRACK34 session switch 07: repeated B events retain a fresh unsaved B row and one A archive', async ($, on) => {
  const fixture = await setup(on)
  await beginA($, fixture)
  fixture.controls.session = B
  await $.tool.call({ tool: 'mcp__track__lookup_rows' } as never)
  const local: Ledger = { ...fixture.b.rows, steps: [...fixture.b.rows.steps, { session_id: B, id: 'plan:local-B',
    source: 'plan', subject: 'B fresh unsaved work', status: 'pending', note: 'Do not reload over this row' }] }
  fixture.memory.value = local
  fixture.durability.value = { ...fixture.durability.value, isUnsaved: true, reason: 'B local unsaved work' }
  for (const _repeat of [1, 2]) await $.tool.call({ tool: 'mcp__track__lookup_rows' } as never)
  expect(await unchangedState(fixture)).toEqual(expectedSelectedB(fixture, local))
  expect({ isUnsaved: fixture.durability.value.isUnsaved, reason: fixture.durability.value.reason })
    .toEqual({ isUnsaved: true, reason: 'B local unsaved work' })
})

// Project every turn/activity field that can carry A's temporary ownership. Null
// and missing optional values both mean absent; no A value is taken as an oracle.
const temporary = (fixture: { turn: { value: Turn }; activity: { value: Activity } }) => ({
  turn: { currentId: fixture.turn.value.currentId, gatedTurnId: fixture.turn.value.gatedTurnId,
    eventOrder: fixture.turn.value.eventOrder ?? 0, lastText: fixture.turn.value.lastText ?? null,
    composeSeen: fixture.turn.value.composeSeen ?? null, composedRule: fixture.turn.value.composedRule ?? null,
    freshness: fixture.turn.value.freshness ?? null, stepReminder: fixture.turn.value.stepReminder ?? null,
    resultReminder: fixture.turn.value.resultReminder ?? null, resultNudgedTurnId: fixture.turn.value.resultNudgedTurnId ?? null,
    turnlessNudged: fixture.turn.value.turnlessNudged ?? [] },
  activity: { ...idle(), ...fixture.activity.value, mainTurnId: fixture.activity.value.mainTurnId ?? null,
    owners: fixture.activity.value.owners ?? {}, ownerOrder: fixture.activity.value.ownerOrder ?? [],
    launchOwners: fixture.activity.value.launchOwners ?? [] },
})
const emptyTemporary = { turn: { currentId: null, gatedTurnId: null, eventOrder: 0, lastText: null,
  composeSeen: null, composedRule: null, freshness: null, stepReminder: null, resultReminder: null,
  resultNudgedTurnId: null, turnlessNudged: [] }, activity: { ...idle(), mainTurnId: null,
    owners: {}, ownerOrder: [], launchOwners: [] } }

test('FIXTURE TRACK34 session switch 08: B pending, answer source, freshness and task ownership reject late A classifier work', async ($, on) => {
  const fixture = await setup(on)
  const oldLabel = latch()
  const newLabel = latch()
  const aText = 'Why is A still waiting?'
  const bText = 'Why is B still waiting?'
  fixture.controls.modelReply = async text => {
    const held = text === aText ? oldLabel : newLabel
    held.enter()
    await held.released
    return text === aText ? 'question' : 'not_question'
  }
  await beginA($, fixture)
  fixture.store.held.set('classifier', { isOn: true })
  await submit($, aText)
  await fixture.clock.advance(1)
  await oldLabel.entered
  fixture.pending.value = { ...fixture.pending.value, inputs: fixture.pending.value.inputs.map(input => ({ ...input, held: true })) }
  fixture.turn.value = { currentId: 'A-running-turn', gatedTurnId: 'A-running-turn', eventOrder: 9,
    lastText: { row: 'A-live-answer', requestId: 'A-live-source', turnId: 'A-running-turn', order: 8,
      text: 'A live answer text', textHash: await hash(JSON.stringify('A live answer text')) },
    freshness: { turnId: 'A-running-turn', edits: ['A-edit'], bash: ['A-bash'], steps: ['plan:1'],
      completed: [{ id: 'plan:1', owner_task_ids: ['A-task'] }], waiting: ['plan:1'], held: ['untracked_edit'], nudged: ['A-nudge'] },
    stepReminder: 'A private step reminder', resultReminder: { turnId: 'A-running-turn', ids: ['plan:1'] },
    resultNudgedTurnId: 'A-running-turn', turnlessNudged: ['A-identity'] }
  fixture.activity.value = { isWorking: true, mainTurnId: 'A-running-turn', agentCalls: ['A-agent-call'],
    askCalls: ['A-ask-call'], background: ['A-agent'], tasks: ['A-task'], owners: { 'A-task': ['plan:1'] },
    ownerOrder: ['plan:1'], launchOwners: [{ task: 'A-task', steps: [{ id: 'plan:1', subject: 'A saved step' }] }] }
  fixture.controls.session = B
  try {
    await submit($, bText)
    await fixture.clock.advance(1)
    await newLabel.entered
    oldLabel.release()
    await fixture.clock.settle()
    expect({ pending: fixture.pending.value, temporary: temporary(fixture),
      state: await unchangedState(fixture), modelCalls: fixture.modelCalls }).toEqual({
      pending: await pendingQuestion(bText), temporary: emptyTemporary,
      state: expectedSelectedB(fixture, fixture.b.rows), modelCalls: [aText, bText],
    })
    expect(fixture.promptCalls.filter(call => call.text === bText).map(call => ({
      ledger: call.ledger, pending: call.pending,
      temporary: temporary({ turn: { value: call.turn }, activity: { value: call.activity } }),
    }))).toEqual([{ ledger: fixture.b.rows, pending: await pendingQuestion(bText), temporary: emptyTemporary }])
    expect(fixture.promptCalls.at(-1)!.context.join('\n')).not.toContain(aText)
    expect(fixture.promptCalls.at(-1)!.context.join('\n')).not.toContain('A private step reminder')
  } finally {
    oldLabel.release()
    newLabel.release()
    await fixture.clock.settle()
  }
})

test('FIXTURE TRACK34 session switch 09 CONTROL: thrown session.id rejects the native caller and reaches observeRewind catch', async ($, on) => {
  const fixture = await setup(on)
  await beginA($, fixture)
  fixture.controls.identityFailure = IDENTITY_FAILURE
  const result = await submit($, 'Continue the saved A work.')
  expect(result.drop).toContain('rewind session identity unavailable:')
  expect(result.drop).toContain(IDENTITY_FAILURE)
  expect(fixture.lines.some(line => line.startsWith('track: rewind session identity unavailable:') && line.includes(IDENTITY_FAILURE))).toBe(true)
  expect(fixture.identityReads).toContain(IDENTITY_FAILURE)
  expect(fixture.promptCalls).toEqual([])
  expect(await unchangedState(fixture)).toEqual(expectedStillA(fixture))
})

test('FIXTURE TRACK34 session switch 10: identity outage keeps a provisional task in A memory and recovery archives it before B loads', async ($, on) => {
  const fixture = await setup(on)
  await beginA($, fixture)
  fixture.controls.session = B
  fixture.controls.identityFailure = IDENTITY_FAILURE
  const result = await outcome($.tool.call({ tool: 'TaskCreate', subject: 'B provisional task',
    description: 'Keep provisional progress in memory until session identity recovers.' } as never))
  const provisional = structuredClone(fixture.memory.value)
  expect({ targetCalls: fixture.taskCalls.map(call => call.subject) }).toEqual({ targetCalls: ['B provisional task'] })
  expect({ ledgerSession: provisional.session_id,
    steps: provisional.steps.map(step => ({ source: step.source, subject: step.subject })),
    a: await history(fixture, A, fixture.a), b: await history(fixture, B, fixture.b),
    archives: archives(fixture), memorySession: fixture.durability.value.memorySession }).toEqual({
    ledgerSession: A, steps: [{ source: 'plan', subject: 'A saved step' }, { source: 'task', subject: 'B provisional task' }],
    a: expectedHistory(fixture.a), b: expectedHistory(fixture.b), archives: [], memorySession: A,
  })
  expect(result.error).toBeUndefined()
  expect(result.value?.deny).toBeUndefined()
  expect(result.value?.isError).not.toBe(true)
  fixture.controls.identityFailure = ''
  await $.tool.call({ tool: 'mcp__track__lookup_rows' } as never)
  expect(await unchangedState(fixture)).toEqual(expectedSelectedB(fixture, fixture.b.rows, provisional))
})

for (const [number, fault, cause] of [[11, 'store', READ_FAILURE], [12, 'lease', LEASE_FAILURE]] as const) {
  test(`FIXTURE TRACK34 session switch ${number}: first B mutation refuses ${fault} failure before TaskCreate executes`, async ($, on) => {
    const fixture = await setup(on)
    await beginA($, fixture)
    fixture.controls.session = B
    if (fault === 'store') fixture.controls.readFailure = cause
    if (fault === 'lease') fixture.lease.leaseFailure = cause
    const result = await outcome($.tool.call({ tool: 'TaskCreate', subject: 'B must remain uncreated',
      description: 'The first mutation must refuse before the native task handler.' } as never))
    expect({ targetCalls: fixture.taskCalls, mutationAttempts: fixture.mutationAttempts,
      pending: fixture.pending.value, temporary: temporary(fixture), state: await unchangedState(fixture) }).toEqual({
      targetCalls: [], mutationAttempts: [], pending: { inputs: [], nextId: 1 }, temporary: emptyTemporary,
      state: expectedStillA(fixture),
    })
    expect(refusalText(result)).toContain(cause)
    if (fault === 'store') expect(fixture.readRefusals).toContain(cause)
    if (fault === 'lease') expect(fixture.store.locks.spawns.some(spawn => spawn.argv[2] === 'lease' && spawn.argv[3] === B)).toBe(true)
  })
}

test('FIXTURE TRACK34 session switch 13: B->C while B resume awaits refuses B mutation without relabelling any history', async ($, on) => {
  const fixture = await setup(on)
  await beginA($, fixture)
  const held = latch()
  fixture.controls.resumeHold = held
  fixture.controls.session = B
  const request = outcome(markB($))
  const reached = await Promise.race([held.entered.then(() => 'held'), request.then(() => 'returned')])
  const during = { reached, memory: structuredClone(fixture.memory.value), attempts: structuredClone(fixture.mutationAttempts) }
  fixture.controls.session = C
  held.release()
  const result = await request
  expect(during).toEqual({ reached: 'held', memory: fixture.a.rows, attempts: [] })
  expect({ a: await history(fixture, A, fixture.a), b: await history(fixture, B, fixture.b),
    c: await history(fixture, C, fixture.c), attempts: fixture.mutationAttempts, starts: fixture.starts }).toEqual({
    a: expectedHistory(fixture.a), b: expectedHistory(fixture.b), c: expectedHistory(fixture.c), attempts: [], starts: [A],
  })
  // A bounded refusal is allowed; the test does not choose a retry algorithm.
  expect(refusalText(result)).toMatch(/session.*(?:chang|differ|mismatch)|(?:chang|differ|mismatch).*session/i)
  expect([fixture.a.rows, fixture.b.rows, fixture.c.rows]).toContainEqual(fixture.memory.value)
  expect([baseline(fixture.a, A), baseline(fixture.b, B), baseline(fixture.c, C)])
    .toContainEqual(fixture.durability.value.baseline)
  expect(fixture.durability.value.memorySession).toBe(fixture.memory.value.session_id)
  expect(fixture.durability.value.baseline?.session_id).toBe(fixture.memory.value.session_id)
  expect(fixture.durability.value.baseline?.ledger).toEqual(fixture.memory.value)
})

test('FIXTURE TRACK34 session switch 14: concurrent first B prompt and mark_step wait for one complete ownership transition', async ($, on) => {
  const fixture = await setup(on)
  await beginA($, fixture)
  const held = latch()
  fixture.controls.resumeHold = held
  fixture.controls.session = B
  const text = 'Why is B concurrent work still open?'
  const first = outcome(submit($, text))
  const reached = await Promise.race([held.entered.then(() => 'held'), first.then(() => 'returned')])
  const second = outcome(markB($))
  let during: unknown
  try {
    await fixture.clock.settle()
    during = { reached, terminal: structuredClone(fixture.promptCalls),
      attempts: structuredClone(fixture.mutationAttempts), memory: structuredClone(fixture.memory.value) }
  } finally {
    held.release()
  }
  const [prompt, marked] = await Promise.all([first, second])
  expect(during).toEqual({ reached: 'held', terminal: [], attempts: [], memory: fixture.a.rows })
  expect(prompt.error).toBeUndefined()
  expect(prompt.value?.drop).toBeUndefined()
  expect(marked.error).toBeUndefined()
  expect(marked.value?.deny).toBeUndefined()
  expect(marked.value?.isError).not.toBe(true)
  expect(String(marked.value?.result)).toContain('"B saved step" marked completed')
  await expectBResult(fixture)
  const expected = await changedB(fixture)
  expect(fixture.promptCalls.map(call => ({ text: call.text, pending: call.pending })))
    .toEqual([{ text, pending: await pendingQuestion(text) }])
  // Either complete B snapshot is valid; scheduling may serialize the mark
  // before or after the prompt. A partial transition matches neither.
  expect([fixture.b.rows, expected]).toContainEqual(fixture.promptCalls[0]!.ledger)
  expect(fixture.pending.value).toEqual(await pendingQuestion(text))
  expect(fixture.memory.value).toEqual(expected)
})

test('FIXTURE TRACK34 session switch 15 CONTROL: real result-bearing mark is observed', async ($, on) => {
  const fixture = await setup(on)
  await beginA($, fixture)
  const result = await markB($)
  const expected: Ledger = { ...fixture.a.rows, steps: [{
    session_id: A, id: 'plan:1', source: 'plan', subject: 'A saved step', status: 'completed', note: 'A step context',
    startedAt: 10, endedAt: 20, resultText: B_RESULT, resultTextHash: await hash(JSON.stringify(B_RESULT)), resultRequestId: B_MARK, resultAt: NOW,
  }] }
  expect(fixture.memory.value).toEqual(expected)
  expect(fixture.mutationAttempts).toContainEqual(expected)
  expect(fixture.mutationAttempts.every(attempt => attempt.session_id === A)).toBe(true)
  expect(fixture.controls.session).toBe(A)
  expect(fixture.starts).toEqual([A])
  expect(result.deny).toBeUndefined()
  expect(result.isError).not.toBe(true)
})

// FIXTURE only: hold an admitted native call across the first destination read.
test('FIXTURE TRACK34 session switch 19: an awaited A TaskCreate never enters B memory or durable history', {
  plugins: [{ name: 'fixture-track34-store-observer-control', register(on: On) {
    on('tool.call', { tool: /^fixture__track34_store_observer_control$/ }, async (capability, e) => {
      if (!('fixture_key' in e) || typeof e.fixture_key !== 'string' || !('fixture_value' in e)) {
        return { deny: 'invalid fixture store observer control' }
      }
      await capability.store.set(e.fixture_key, e.fixture_value)
      return { result: 'fixture store observer control applied' }
    })
  } }],
}, async ($, on) => {
  const bStoreWrites: Array<{ key: string; value: unknown }> = []
  const fixture = await setup(on, bStoreWrites)
  await beginA($, fixture)
  // Positive observer control: replay only the seeded bytes. Keep these
  // entries outside the concurrent trace rather than accepting an unseen hook.
  const observerControlStart = bStoreWrites.length
  await $.tool.call({ tool: 'fixture__track34_store_observer_control',
    fixture_key: `s:${B}`, fixture_value: structuredClone(fixture.b.body) } as never)
  await $.tool.call({ tool: 'fixture__track34_store_observer_control',
    fixture_key: `h:${B}`, fixture_value: structuredClone(fixture.b.head) } as never)
  expect(bStoreWrites.slice(observerControlStart)).toEqual([
    { key: `s:${B}`, value: fixture.b.body }, { key: `h:${B}`, value: fixture.b.head },
  ])
  expect({ bodyBytes: JSON.stringify(fixture.store.held.get(`s:${B}`)),
    headBytes: JSON.stringify(fixture.store.held.get(`h:${B}`)) }).toEqual({
    bodyBytes: JSON.stringify(fixture.b.body), headBytes: JSON.stringify(fixture.b.head),
  })
  const concurrentWriteStart = bStoreWrites.length
  const held = latch()
  fixture.controls.taskHold = held
  const subject = 'A task held across the session switch'
  const task = { id: 'task:unit2-a-held-task', source: 'task' as const, subject, status: 'pending' as const,
    taskId: 'unit2-a-held-task', createdRequestId: 'unit2-a-held-call' }
  const retained: Ledger = { ...fixture.a.rows, steps: [...fixture.a.rows.steps, task] }
  const identified: Ledger = { ...fixture.a.rows, steps: [...fixture.a.rows.steps, { ...task, session_id: A }] }
  const request = outcome($.tool.call({ tool: 'TaskCreate', tool_use_id: 'unit2-a-held-call', subject,
    description: 'This task belongs to the A call admitted before B lookup.' } as never))
  // Native timers are already used by cc179-review; the mocked clock does not
  // move by itself. This bounds observation, without requiring B to bypass A.
  const timers = globalThis as unknown as {
    setTimeout: (run: () => void, ms: number) => unknown; clearTimeout: (timer: unknown) => void
  }
  let timer: unknown
  try {
    const entered = await Promise.race([held.entered.then(() => 'held'), request.then(() => 'returned')])
    expect({ nativeTaskPhase: entered, targetCalls: fixture.taskCalls }).toEqual({
      nativeTaskPhase: 'held', targetCalls: [{ subject, ledger: fixture.a.rows }],
    })
    fixture.controls.session = B
    const lookup = outcome($.tool.call({ tool: 'mcp__track__lookup_rows' } as never))
    try {
      await fixture.clock.settle()
      await Promise.race([lookup, new Promise<void>(resolve => { timer = timers.setTimeout(resolve, 100) })])
    } finally {
      if (timer !== undefined) timers.clearTimeout(timer)
      held.release()
    }
    const [created, looked] = await Promise.all([request, lookup])
    expect(fixture.memory.writes.filter(write => write.session_id === B)
      .flatMap(write => write.steps)
      .filter(step => step.taskId === task.taskId || step.createdRequestId === task.createdRequestId)).toEqual([])
    for (const write of bStoreWrites.slice(concurrentWriteStart)) {
      expect(write.value).toEqual(write.key === `s:${B}` ? fixture.b.body : fixture.b.head)
    }
    expect({ bLookupError: looked.error, bLookupDeny: looked.value?.deny,
      bLookup: JSON.parse(String(looked.value?.result)), bMemory: fixture.memory.value,
      bHistory: await history(fixture, B, fixture.b), cHistory: await history(fixture, C, fixture.c),
      owner: fixture.durability.value.memorySession, baseline: fixture.durability.value.baseline, starts: fixture.starts }).toEqual({
      bLookupError: undefined, bLookupDeny: undefined, bLookup: { ok: true, rows: [
        { label: 'S1', id: 'plan:1', kind: 'step', status: 'completed', subject: 'B saved step' },
        { label: 'Q1', id: 'question:1', kind: 'question', status: 'answered', subject: 'B answered question' },
        { label: 'Q2', id: 'question:2', kind: 'question', status: 'open', subject: 'B open question' },
      ] }, bMemory: fixture.b.rows, bHistory: expectedHistory(fixture.b), cHistory: expectedHistory(fixture.c),
      owner: B, baseline: baseline(fixture.b, B), starts: [A],
    })
    // Two supported outcomes: retain the exact A task in an A snapshot, or
    // explicitly refuse its tracking because the admitted session changed.
    const refusal = created.error ?? created.value?.deny ?? (created.value?.isError === true ? String(created.value.result) : '')
    const explicitlyRefused = /(?:session|owner).*(?:chang|differ|mismatch)|(?:chang|differ|mismatch).*(?:session|owner)/i.test(refusal)
    const allowedArchives = [expectedArchive(retained), expectedArchive(identified)]
    if (explicitlyRefused) allowedArchives.push(expectedArchive(fixture.a.rows))
    expect(allowedArchives).toContainEqual(archives(fixture))
    const aHistory = await history(fixture, A, fixture.a)
    if (aHistory.bodyBytes === JSON.stringify(fixture.a.body)) {
      expect(aHistory).toEqual(expectedHistory(fixture.a))
    } else {
      // Serializing B behind A may acknowledge A before archiving it. Its
      // only permitted new bytes describe this independently specified A row.
      const text = JSON.stringify(identified)
      const checksum = await hash(text)
      const checkpoint = await describeCheckpoint(identified, A, fixture.a.head.checkpoint)
      expect({ body: fixture.store.held.get(`s:${A}`), head: fixture.store.held.get(`h:${A}`),
        blob: fixture.files.get(`${BLOBS}/${checksum}.json`), originalBlob: aHistory.blobBytes, ledger: aHistory.ledger }).toEqual({
        body: { v: 2, session_id: A, generation: GENERATION, savedAt: expect.any(Number),
          ledger_blob: { checksum, bytes: encoder.encode(text).length }, checkpoint },
        head: { v: 1, session_id: A, generation: GENERATION, checkpoint },
        blob: text, originalBlob: fixture.a.text, ledger: identified,
      })
    }
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer)
    held.release()
    await request
  }
})

// FIXTURE only: the first recovery event is a read, never checkpoint/save.
test('FIXTURE TRACK34 session switch 20: first B lookup archives null-owner provisional rows before displaying B', async ($, on) => {
  const fixture = await setup(on)
  fixture.memory.value = structuredClone(EMPTY)
  fixture.durability.value = { isUnsaved: false, reason: '' }
  fixture.controls.identityFailure = IDENTITY_FAILURE
  const subject = 'Unknown-owner provisional task'
  const result = await outcome($.tool.call({ tool: 'TaskCreate', tool_use_id: 'unit2-unknown-call', subject,
    description: 'Keep progress while no session identity or memory owner is known.' } as never))
  const provisional: Ledger = { ...EMPTY, steps: [{ id: 'task:unit2-b-task', source: 'task', subject,
    status: 'pending', taskId: 'unit2-b-task', createdRequestId: 'unit2-unknown-call' }] }
  expect({ targetCalls: fixture.taskCalls, memory: fixture.memory.value,
    memorySession: fixture.durability.value.memorySession, a: await history(fixture, A, fixture.a),
    b: await history(fixture, B, fixture.b), c: await history(fixture, C, fixture.c),
    saved: fixture.store.held.get('saved'), archives: archives(fixture), starts: fixture.starts }).toEqual({
    targetCalls: [{ subject, ledger: EMPTY }], memory: provisional, memorySession: null,
    a: expectedHistory(fixture.a), b: expectedHistory(fixture.b), c: expectedHistory(fixture.c),
    saved: fixture.saved, archives: [], starts: [],
  })
  expect(result.error).toBeUndefined()
  expect(result.value?.deny).toBeUndefined()
  expect(result.value?.isError).not.toBe(true)
  fixture.controls.identityFailure = ''
  fixture.controls.session = B
  const lookup = await $.tool.call({ tool: 'mcp__track__lookup_rows' } as never)
  const recovery = { source_session: null, ledger: provisional }
  expect({ firstRecoveredLookup: JSON.parse(String(lookup.result)), state: await unchangedState(fixture),
    recoveryEntries: [...fixture.store.held.entries()].filter(([key]) => key.startsWith('r:')) }).toEqual({
    firstRecoveredLookup: { ok: true, rows: [
      { label: 'S1', id: 'plan:1', kind: 'step', status: 'completed', subject: 'B saved step' },
      { label: 'Q1', id: 'question:1', kind: 'question', status: 'answered', subject: 'B answered question' },
      { label: 'Q2', id: 'question:2', kind: 'question', status: 'open', subject: 'B open question' },
    ] }, state: { memory: fixture.b.rows,
      a: expectedHistory(fixture.a), b: expectedHistory(fixture.b), c: expectedHistory(fixture.c), saved: fixture.saved,
      archives: [{ v: 1, session_id: B, kind: 'session-switch', value: recovery }],
      ownership: { memorySession: B, baseline: baseline(fixture.b, B) }, starts: [] },
    recoveryEntries: [[`r:${B}:session-switch-${await hash(JSON.stringify(recovery))}`,
      { v: 1, session_id: B, kind: 'session-switch', value: recovery }]],
  })
})

// Real time bounds fixture orchestration only. A deadline is an invalid native
// run, never the ownership assertion that earns behavioral RED.
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

const selectBWhileHeld = async <T,>($: Engine, fixture: Fixture, held: Latch, request: Promise<T>) => {
  const phase = await fixtureWait(Promise.race([
    held.entered.then(() => 'native held'), request.then(() => 'native returned'),
  ]), 'native admission')
  expect(phase).toBe('native held')
  fixture.controls.session = B
  const lookup = await fixtureWait($.tool.call({ tool: 'mcp__track__lookup_rows' } as never), 'B selection before release')
  expect(lookup.deny).toBeUndefined()
  expect(lookup.isError).not.toBe(true)
  expect(await unchangedState(fixture)).toEqual(expectedSelectedB(fixture, fixture.b.rows))
}

const expectRefusedOrArchived = (result: Awaited<ReturnType<typeof outcome>>, fixture: Fixture, retained: Ledger) => {
  const response = result.value as { deny?: string; isError?: boolean; result?: unknown } | undefined
  const retainedArchives = [expectedArchive(retained), expectedArchive({ ...retained,
    steps: retained.steps.map(step => ({ ...step, session_id: A })) })]
  if (retainedArchives.some(expected => JSON.stringify(expected) === JSON.stringify(archives(fixture)))) {
    expect(result.error).toBeUndefined()
    expect(response?.deny).toBeUndefined()
    expect(response?.isError).not.toBe(true)
  } else {
    expect(archives(fixture)).toEqual(expectedArchive(fixture.a.rows))
    const refusal = result.error ?? response?.deny ?? (response?.isError === true ? String(response.result) : '')
    expect(refusal).toMatch(/(?:session|owner).*(?:chang|differ|mismatch)|(?:chang|differ|mismatch).*(?:session|owner)/i)
  }
}

test('FIXTURE TRACK34 session switch 21: held A TodoWrite cannot replace independently seeded B todos', async ($, on) => {
  const aTodo = { session_id: A, id: 'todo:a original todo', source: 'todo' as const,
    subject: 'A original todo', status: 'pending' as const }
  const bTodo = { session_id: B, id: 'todo:b private todo', source: 'todo' as const,
    subject: 'B private todo', status: 'in_progress' as const, startedAt: 700, activeTurnId: 'B-todo-turn' }
  const fixture = await setup(on, undefined, { [A]: [aTodo], [B]: [bTodo] })
  await beginA($, fixture)
  const held = latch()
  fixture.controls.todoHold = held
  const todos = [{ content: 'A replacement todo', status: 'pending' as const }]
  const retained: Ledger = { ...fixture.a.rows, steps: [fixture.a.rows.steps[0]!, {
    id: 'todo:a replacement todo', source: 'todo', subject: 'A replacement todo', status: 'pending',
  }] }
  const request = outcome($.tool.call({ tool: 'TodoWrite', tool_use_id: 'unit2-a-held-todo', todos } as never))
  try {
    await selectBWhileHeld($, fixture, held, request)
    const bSelectedWriteIndex = fixture.memory.writes.length
    expect(fixture.todoCalls).toEqual([{ todos, ledger: fixture.a.rows }])
    held.release()
    const result = await fixtureWait(request, 'TodoWrite completion')
    // Named post-await assertion: a replacement of B's todo list fails here.
    expect({ postAwaitTodoB: fixture.memory.value, bHistory: await history(fixture, B, fixture.b),
      bBaseline: fixture.durability.value.baseline }).toEqual({
      postAwaitTodoB: fixture.b.rows, bHistory: expectedHistory(fixture.b), bBaseline: baseline(fixture.b, B),
    })
    for (const write of fixture.memory.writes.filter(write => write.session_id === B)) {
      expect([{ ...EMPTY, session_id: B }, fixture.b.rows]).toContainEqual(write)
    }
    for (const write of fixture.memory.writes.slice(bSelectedWriteIndex).filter(write => write.session_id === B)) {
      expect(write).toEqual(fixture.b.rows)
    }
    expect(fixture.todoCalls).toEqual([{ todos, ledger: fixture.a.rows }])
    expectRefusedOrArchived(result, fixture, retained)
  } finally {
    held.release()
    await fixtureWait(request, 'TodoWrite cleanup')
  }
})

test('FIXTURE TRACK34 session switch 22: held A TaskUpdate cannot change B status or clock for the same taskId', async ($, on) => {
  const taskId = 'unit2-reused-task'
  const aTask = { session_id: A, id: `task:${taskId}`, source: 'task' as const, taskId,
    subject: 'A task before completion', status: 'paused' as const, startedAt: 100, note: 'A task context' }
  const bTask = { session_id: B, id: `task:${taskId}`, source: 'task' as const, taskId,
    subject: 'B distinct running task', status: 'in_progress' as const, startedAt: 800, activeTurnId: 'B-task-turn',
    note: 'B task context' }
  const fixture = await setup(on, undefined, { [A]: [aTask], [B]: [bTask] })
  await beginA($, fixture)
  const held = latch()
  fixture.controls.updateHold = held
  const retained: Ledger = { ...fixture.a.rows, steps: [fixture.a.rows.steps[0]!, {
    ...aTask, status: 'completed', endedAt: NOW,
  }] }
  const request = outcome($.tool.call({ tool: 'TaskUpdate', tool_use_id: 'unit2-a-held-update',
    taskId, status: 'completed' } as never))
  try {
    await selectBWhileHeld($, fixture, held, request)
    const bSelectedWriteIndex = fixture.memory.writes.length
    expect(fixture.updateCalls).toEqual([{ taskId, status: 'completed', ledger: fixture.a.rows }])
    held.release()
    const result = await fixtureWait(request, 'TaskUpdate completion')
    // A different B taskId would miss the broken handler's taskId-only match.
    expect({ postAwaitTaskB: fixture.memory.value, bHistory: await history(fixture, B, fixture.b),
      bBaseline: fixture.durability.value.baseline }).toEqual({
      postAwaitTaskB: fixture.b.rows, bHistory: expectedHistory(fixture.b), bBaseline: baseline(fixture.b, B),
    })
    for (const write of fixture.memory.writes.filter(write => write.session_id === B)) {
      expect([{ ...EMPTY, session_id: B }, fixture.b.rows]).toContainEqual(write)
    }
    for (const write of fixture.memory.writes.slice(bSelectedWriteIndex).filter(write => write.session_id === B)) {
      expect(write).toEqual(fixture.b.rows)
    }
    expect(fixture.updateCalls).toEqual([{ taskId, status: 'completed', ledger: fixture.a.rows }])
    expectRefusedOrArchived(result, fixture, retained)
  } finally {
    held.release()
    await fixtureWait(request, 'TaskUpdate cleanup')
  }
})

const outerObserver = { plugins: [{ name: 'fixture-track34-outer-store-control', register(on: On) {
  on('tool.call', { tool: /^fixture__track34_outer_store_control$/ }, async (capability, e) => {
    if (!('fixture_key' in e) || typeof e.fixture_key !== 'string' || !('fixture_value' in e)) {
      return { deny: 'invalid fixture outer store observer control' }
    }
    await capability.store.set(e.fixture_key, e.fixture_value)
    return { result: 'fixture outer store observer control applied' }
  })
} }] }

const proveOuterObserver = async ($: Engine, fixture: Fixture, writes: Array<{ key: string; value: unknown }>) => {
  const start = writes.length
  for (const [key, value] of [[`s:${B}`, fixture.b.body], [`h:${B}`, fixture.b.head]] as const) {
    const result = await $.tool.call({ tool: 'fixture__track34_outer_store_control',
      fixture_key: key, fixture_value: structuredClone(value) } as never)
    expect(result.result).toBe('fixture outer store observer control applied')
  }
  expect(writes.slice(start)).toEqual([
    { key: `s:${B}`, value: fixture.b.body }, { key: `h:${B}`, value: fixture.b.head },
  ])
  expect(await history(fixture, B, fixture.b)).toEqual(expectedHistory(fixture.b))
}

const sharedTurnId = 'unit2-reused-engine-turn'
const installBTransient = async (fixture: Fixture) => {
  // The engine may reuse a turn id. A session token must protect this even when
  // recordWork's turn-id-only comparison would otherwise accept the A call.
  const turn: Turn = { currentId: sharedTurnId, gatedTurnId: null, eventOrder: 3,
    freshness: { turnId: sharedTurnId, edits: ['B-edit'], bash: ['B-bash'], steps: ['plan:1'],
      completed: [], waiting: [], held: [], nudged: [] } }
  const pending: Pending = { inputs: [{ id: 31, head: 'Why is B pending?', excerpt: 'Why is B pending?',
    textHash: await hash(JSON.stringify('Why is B pending?')), turnId: sharedTurnId }], nextId: 32 }
  fixture.turn.value = structuredClone(turn)
  fixture.pending.value = structuredClone(pending)
  return { turn, pending }
}

test('FIXTURE TRACK34 session switch 23: outer mutation wrapper cannot save B after a native A failure skips its ledger write',
  outerObserver, async ($, on) => {
  const writes: Array<{ key: string; value: unknown }> = []
  const fixture = await setup(on, writes)
  await beginA($, fixture)
  await proveOuterObserver($, fixture, writes)
  fixture.turn.value = { currentId: sharedTurnId, gatedTurnId: null }
  const held = latch()
  fixture.controls.updateHold = held
  fixture.controls.updateSuccess = false
  const taskId = 'unit2-native-failure'
  const request = outcome($.tool.call({ tool: 'TaskUpdate', tool_use_id: 'unit2-a-failed-update',
    taskId, status: 'completed' } as never))
  try {
    await selectBWhileHeld($, fixture, held, request)
    expect(fixture.updateCalls).toEqual([{ taskId, status: 'completed', ledger: fixture.a.rows }])
    const expectedTransient = await installBTransient(fixture)
    const afterBSelected = writes.length
    held.release()
    const result = await fixtureWait(request, 'outer mutation completion')
    // No post-await ledger callback ran: a ledger-only guard cannot pass this.
    expect({ staleOuterBStoreWrites: writes.slice(afterBSelected), memory: fixture.memory.value,
      bHistory: await history(fixture, B, fixture.b), bBaseline: fixture.durability.value.baseline,
      turn: fixture.turn.value, pending: fixture.pending.value }).toEqual({
      staleOuterBStoreWrites: [], memory: fixture.b.rows, bHistory: expectedHistory(fixture.b),
      bBaseline: baseline(fixture.b, B), ...expectedTransient,
    })
    expect(result).toEqual({ value: expect.objectContaining({ result: { success: false } }) })
    expect(fixture.updateCalls).toEqual([{ taskId, status: 'completed', ledger: fixture.a.rows }])
  } finally {
    held.release()
    await fixtureWait(request, 'outer mutation cleanup')
  }
})

test('FIXTURE TRACK34 session switch 24: outer read-only branch cannot add held A Bash freshness to B with the same turn id',
  outerObserver, async ($, on) => {
  const writes: Array<{ key: string; value: unknown }> = []
  const fixture = await setup(on, writes)
  await beginA($, fixture)
  await proveOuterObserver($, fixture, writes)
  fixture.turn.value = { currentId: sharedTurnId, gatedTurnId: null }
  const held = latch()
  fixture.controls.workHold = held
  const command = 'fixture A work command'
  const request = outcome($.tool.call({ tool: 'Bash', tool_use_id: 'unit2-a-held-bash', command } as never))
  try {
    await selectBWhileHeld($, fixture, held, request)
    expect(fixture.workCalls).toEqual([{ command, ledger: fixture.a.rows }])
    const expectedTransient = await installBTransient(fixture)
    const afterBSelected = writes.length
    held.release()
    const result = await fixtureWait(request, 'outer read-only completion')
    expect({ staleOuterBFacts: { turn: fixture.turn.value, pending: fixture.pending.value },
      writes: writes.slice(afterBSelected), memory: fixture.memory.value,
      bHistory: await history(fixture, B, fixture.b), bBaseline: fixture.durability.value.baseline }).toEqual({
      staleOuterBFacts: expectedTransient, writes: [], memory: fixture.b.rows,
      bHistory: expectedHistory(fixture.b), bBaseline: baseline(fixture.b, B),
    })
    expect(result).toEqual({ value: expect.objectContaining({ result: 'fixture A command completed' }) })
    expect(fixture.workCalls).toEqual([{ command, ledger: fixture.a.rows }])
  } finally {
    held.release()
    await fixtureWait(request, 'outer read-only cleanup')
  }
})

const mintNullOwner = async ($: Engine, fixture: Fixture) => {
  fixture.memory.value = structuredClone(EMPTY)
  fixture.durability.value = { isUnsaved: false, reason: '' }
  expect(fixture.durability.value.memorySession).toBeUndefined()
  fixture.controls.identityFailure = IDENTITY_FAILURE
  const subject = 'Unknown-owner recovery control'
  const result = await outcome($.tool.call({ tool: 'TaskCreate', tool_use_id: 'unit2-null-recovery', subject,
    description: 'Preserve these provisional rows once, before loading durable history.' } as never))
  const provisional: Ledger = { ...EMPTY, steps: [{ id: 'task:unit2-b-task', source: 'task', subject,
    status: 'pending', taskId: 'unit2-b-task', createdRequestId: 'unit2-null-recovery' }] }
  expect({ resultError: result.error, deny: result.value?.deny, isError: result.value?.isError,
    memory: fixture.memory.value, owner: fixture.durability.value.memorySession,
    calls: fixture.taskCalls, archives: archives(fixture) }).toEqual({
    resultError: undefined, deny: undefined, isError: undefined,
    memory: provisional, owner: null, calls: [{ subject, ledger: EMPTY }], archives: [],
  })
  fixture.controls.identityFailure = ''
  return provisional
}

const nullRecoveryEntries = async (id: string, provisional: Ledger) => {
  const value = { source_session: null, ledger: provisional }
  return [[`r:${id}:session-switch-${await hash(JSON.stringify(value))}`,
    { v: 1, session_id: id, kind: 'session-switch', value }]]
}

for (const [number, door] of [[25, 'submit'], [26, 'append']] as const) {
  test(`FIXTURE TRACK34 session switch ${number}: first B ${door} archives null-owner rows exactly once before B work`, async ($, on) => {
    const fixture = await setup(on)
    const provisional = await mintNullOwner($, fixture)
    fixture.controls.session = B
    const text = door === 'submit' ? 'Why is B recovery pending?' : 'B recovery appended work'
    const event = appendB('prompt', text)
    const result = door === 'submit' ? await submit($, text) : await $.session.append(event as never)
    const expectedMemory = door === 'submit' ? fixture.b.rows : { ...fixture.b.rows,
      prompts: [...fixture.b.rows.prompts, { rowKey: 'eeeeeeee-0000-4000-8000', head: text, turnId: null, at: expect.any(Number) }] }
    const entries = await nullRecoveryEntries(B, provisional)
    const expectedState = { memory: expectedMemory, a: expectedHistory(fixture.a), b: expectedHistory(fixture.b),
      c: expectedHistory(fixture.c), saved: fixture.saved, archives: entries.map(([, value]) => value),
      ownership: { memorySession: B, baseline: baseline(fixture.b, B) }, starts: [] }
    expect({ firstRecoveredDoor: await unchangedState(fixture),
      recoveryEntries: [...fixture.store.held.entries()].filter(([key]) => key.startsWith('r:')) }).toEqual({
      firstRecoveredDoor: expectedState, recoveryEntries: entries,
    })
    if (door === 'submit') {
      expect(fixture.promptCalls.map(call => ({ text: call.text, ledger: call.ledger, pending: call.pending })))
        .toEqual([{ text, ledger: fixture.b.rows, pending: await pendingQuestion(text) }])
      expect(result).not.toEqual(expect.objectContaining({ drop: expect.any(String) }))
    } else {
      expect(fixture.session.appended()).toEqual([event])
      expect(result).toEqual({ message: event.message, uuid: event.uuid })
    }
    await $.tool.call({ tool: 'mcp__track__lookup_rows' } as never)
    expect(await unchangedState(fixture)).toEqual(expectedState)
    expect([...fixture.store.held.entries()].filter(([key]) => key.startsWith('r:'))).toEqual(entries)
    expect(fixture.taskCalls).toHaveLength(1)
  })
}

test('FIXTURE TRACK34 session switch 27: null-owner recovery to the same session id archives once before loading that id', async ($, on) => {
  const fixture = await setup(on)
  const provisional = await mintNullOwner($, fixture)
  // session.id was A before the outage and recovers to A; null is not pristine.
  expect(fixture.controls.session).toBe(A)
  const lookup = await $.tool.call({ tool: 'mcp__track__lookup_rows' } as never)
  const entries = await nullRecoveryEntries(A, provisional)
  expect({ sameIdRecoveredRows: fixture.memory.value, lookup: JSON.parse(String(lookup.result)),
    state: await unchangedState(fixture) }).toEqual({
    sameIdRecoveredRows: fixture.a.rows, lookup: { ok: true, rows: [
      { label: 'S1', id: 'plan:1', kind: 'step', status: 'completed', subject: 'A saved step' },
      { label: 'Q1', id: 'question:1', kind: 'question', status: 'answered', subject: 'A answered question' },
      { label: 'Q2', id: 'question:2', kind: 'question', status: 'open', subject: 'A open question' },
    ] }, state: { memory: fixture.a.rows, a: expectedHistory(fixture.a), b: expectedHistory(fixture.b),
      c: expectedHistory(fixture.c), saved: fixture.saved, archives: entries.map(([, value]) => value),
      ownership: { memorySession: A, baseline: baseline(fixture.a, A) }, starts: [] },
  })
  const checkpoint = await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: A } as never)
  expect(JSON.parse(String(checkpoint.result)).ok).toBe(true)
  expect({ memory: fixture.memory.value, baselineLedger: fixture.durability.value.baseline?.ledger,
    recoveryEntries: [...fixture.store.held.entries()].filter(([key]) => key.startsWith('r:')),
    b: await history(fixture, B, fixture.b), c: await history(fixture, C, fixture.c), calls: fixture.taskCalls.length }).toEqual({
    memory: fixture.a.rows, baselineLedger: fixture.a.rows, recoveryEntries: entries,
    b: expectedHistory(fixture.b), c: expectedHistory(fixture.c), calls: 1,
  })
})

const mechanicalRestoreCaller = { plugins: [{ name: 'fixture-track34-mechanical-restore', register(on: On) {
  on('tool.call', { tool: /^fixture__track34_restore$/ }, async ($, e) =>
    $.tool.call({ ...e, tool: 'mcp__track__restore_tracker' }))
} }] }

test('FIXTURE TRACK34 session switch 28: inner validated restore returns a JSON failure receipt after owner change',
  mechanicalRestoreCaller, async ($, on) => {
  const fixture = await setup(on)
  const held = latch()
  let heldSnapshot = false
  on('session.append', { door: 'note' }, async (_, e, next) => {
    if (!heldSnapshot && e.message.type === 'user' && e.message.content.some(part =>
      part.type === 'text' && typeof part.text === 'string' && part.text.startsWith('Track source snapshot from session '))) {
      heldSnapshot = true
      held.enter()
      await held.released
    }
    return next(e)
  })
  await beginA($, fixture)
  const request = outcome($.tool.call({ tool: 'fixture__track34_restore', from_session: C, replace: true,
    expected_checkpoint: fixture.c.head.checkpoint, tool_use_id: 'unit2-inner-restore-owner-change' } as never))
  try {
    const phase = await fixtureWait(Promise.race([
      held.entered.then(() => 'held'), request.then(() => 'returned'),
    ]), 'inner restore source-snapshot admission')
    if (phase !== 'held') throw new Error('INVALID FIXTURE: validated inner restore returned before its source-snapshot append')
    fixture.controls.session = B
    const lookup = await fixtureWait($.tool.call({ tool: 'mcp__track__lookup_rows' } as never), 'inner restore B selection before release')
    expect(lookup.deny).toBeUndefined()
    expect(lookup.isError).not.toBe(true)
    expect(await unchangedState(fixture)).toEqual(expectedSelectedB(fixture, fixture.b.rows))
    held.release()
    const result = await fixtureWait(request, 'inner restore completion')
    expect(await unchangedState(fixture)).toEqual(expectedSelectedB(fixture, fixture.b.rows))
    let receipt: unknown
    try { receipt = JSON.parse(String(result.value?.result)) }
    catch (error) { receipt = { invalidReceipt: result.value?.result ?? result.error ?? String(error) } }
    expect({ innerValidatedRestoreReceipt: receipt }).toEqual({ innerValidatedRestoreReceipt: {
      v: 1, ok: false, source_session: C, destination_session: A, revision: 0, checksum: '',
      counts: { questions: 0, answers: 0, steps: 0 },
      reason: expect.stringMatching(/session owner changed|owner.*changed/i),
    } })
  } finally {
    held.release()
    await fixtureWait(request, 'inner restore cleanup')
  }
})

test('FIXTURE TRACK34 session switch 29: outer validated restore returns a JSON failure receipt without claiming completed A work was undone',
  mechanicalRestoreCaller, async ($, on) => {
  const fixture = await setup(on)
  const held = latch()
  let gateArmed = false
  on('env.set', { name: 'TRACK_GATE_SNAPSHOT' }, async () => {
    if (gateArmed) {
      gateArmed = false
      held.enter()
      await held.released
    }
    return { value: {} }
  })
  await beginA($, fixture)
  gateArmed = true
  const request = outcome($.tool.call({ tool: 'fixture__track34_restore', from_session: C, replace: true,
    expected_checkpoint: fixture.c.head.checkpoint, tool_use_id: 'unit2-outer-restore-owner-change' } as never))
  let lookupRequest: typeof request | undefined
  try {
    const phase = await fixtureWait(Promise.race([
      held.entered.then(() => 'held'), request.then(() => 'returned'),
    ]), 'outer restore gate publication')
    if (phase !== 'held') throw new Error('INVALID FIXTURE: validated outer restore returned before its gate publication')
    const capturedA = structuredClone(fixture.memory.value)
    expect(capturedA.session_id).toBe(A)
    expect(capturedA.steps).toEqual([expect.objectContaining({ sourceId: `${C}:plan:1`,
      subject: 'C saved step', resultText: 'C complete saved step result.' })])
    expect(capturedA.questions.filter(question => question.restoredFrom === C)).toEqual([
      expect.objectContaining({ sourceId: `${C}:Q1`, head: 'C answered question', answerText: 'C complete saved answer.' }),
      expect.objectContaining({ sourceId: `${C}:Q2`, head: 'C open question', status: 'open' }),
    ])
    fixture.controls.session = B
    lookupRequest = outcome($.tool.call({ tool: 'mcp__track__lookup_rows' } as never))
    // B selects its rows before publishing the gate queued behind held A.
    // Observe that selection without awaiting the blocked lookup response.
    const timers = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }
    let observingSelection = true
    const selection = (async () => {
      while (observingSelection) {
        if (fixture.memory.value.session_id === B
          && fixture.durability.value.memorySession === B
          && fixture.durability.value.baseline?.session_id === B) return
        await new Promise<void>(resolve => { timers.setTimeout(resolve, 1) })
      }
    })()
    try {
      await fixtureWait(selection, 'outer restore B selection observation before release')
    } finally {
      observingSelection = false
      await selection
    }
    expect(await unchangedState(fixture)).toEqual(expectedSelectedB(fixture, fixture.b.rows, capturedA))
    held.release()
    const lookup = await fixtureWait(lookupRequest, 'outer restore B lookup completion')
    expect(lookup.error).toBeUndefined()
    expect(lookup.value?.deny).toBeUndefined()
    expect(lookup.value?.isError).not.toBe(true)
    expect(await unchangedState(fixture)).toEqual(expectedSelectedB(fixture, fixture.b.rows, capturedA))
    const result = await fixtureWait(request, 'outer restore completion')
    expect(await unchangedState(fixture)).toEqual(expectedSelectedB(fixture, fixture.b.rows, capturedA))
    let receipt: unknown
    try { receipt = JSON.parse(String(result.value?.result)) }
    catch (error) { receipt = { invalidReceipt: result.value?.result ?? result.error ?? String(error) } }
    expect({ outerValidatedRestoreReceipt: receipt }).toEqual({ outerValidatedRestoreReceipt: {
      v: 1, ok: false, source_session: C, destination_session: A, revision: 0, checksum: '',
      counts: { questions: 0, answers: 0, steps: 0 },
      reason: expect.stringMatching(/session owner changed|owner.*changed/i),
    } })
    expect(String((receipt as { reason?: unknown }).reason)).toMatch(/not (?:undone|acknowledged)/i)
  } finally {
    held.release()
    await fixtureWait(Promise.all([request, lookupRequest]), 'outer restore cleanup')
  }
})

test('FIXTURE TRACK34 session switch 30: inner post-apply restore failure does not claim completed A work was unrecorded',
  mechanicalRestoreCaller, async ($, on) => {
  const fixture = await setup(on)
  const held = latch()
  let heldNotice = false
  on('session.append', { door: 'note' }, async (_, e, next) => {
    if (!heldNotice && e.message.type === 'system' && e.message.content.some(part =>
      part.type === 'text' && typeof part.text === 'string' && part.text.startsWith('Track source snapshot from session '))) {
      heldNotice = true
      held.enter()
      await held.released
    }
    return next(e)
  })
  await beginA($, fixture)
  const request = outcome($.tool.call({ tool: 'fixture__track34_restore', from_session: C, replace: true,
    expected_checkpoint: fixture.c.head.checkpoint, tool_use_id: 'unit2-inner-post-apply-restore-owner-change' } as never))
  try {
    const phase = await fixtureWait(Promise.race([
      held.entered.then(() => 'held'), request.then(() => 'returned'),
    ]), 'inner post-apply restore person notice')
    if (phase !== 'held') throw new Error('INVALID FIXTURE: validated inner restore returned before its post-apply system notice')
    const capturedA = structuredClone(fixture.memory.value)
    expect(capturedA.session_id).toBe(A)
    expect(capturedA.steps).toEqual([expect.objectContaining({ sourceId: `${C}:plan:1`,
      subject: 'C saved step', resultText: 'C complete saved step result.' })])
    expect(capturedA.questions.filter(question => question.restoredFrom === C)).toEqual([
      expect.objectContaining({ sourceId: `${C}:Q1`, head: 'C answered question', answerText: 'C complete saved answer.' }),
      expect.objectContaining({ sourceId: `${C}:Q2`, head: 'C open question', status: 'open' }),
    ])
    fixture.controls.session = B
    const lookup = await fixtureWait($.tool.call({ tool: 'mcp__track__lookup_rows' } as never),
      'inner post-apply restore B selection before release')
    expect(lookup.deny).toBeUndefined()
    expect(lookup.isError).not.toBe(true)
    expect(await unchangedState(fixture)).toEqual(expectedSelectedB(fixture, fixture.b.rows, capturedA))
    held.release()
    const result = await fixtureWait(request, 'inner post-apply restore completion')
    expect(await unchangedState(fixture)).toEqual(expectedSelectedB(fixture, fixture.b.rows, capturedA))
    let receipt: unknown
    try { receipt = JSON.parse(String(result.value?.result)) }
    catch (error) { receipt = { invalidReceipt: result.value?.result ?? result.error ?? String(error) } }
    expect({ innerPostApplyRestoreReceipt: receipt }).toEqual({ innerPostApplyRestoreReceipt: {
      v: 1, ok: false, source_session: C, destination_session: A, revision: 0, checksum: '',
      counts: { questions: 0, answers: 0, steps: 0 },
      reason: expect.stringMatching(/session owner changed|owner.*changed/i),
    } })
    expect({ innerPostApplyRestoreContext: result.value?.context }).toEqual({ innerPostApplyRestoreContext:
      expect.arrayContaining([expect.stringMatching(/session owner changed|owner.*changed/i)]),
    })
    expect({ innerPostApplyRestoreTruthfulReason: (receipt as { reason?: unknown }).reason }).toEqual({
      innerPostApplyRestoreTruthfulReason: expect.stringMatching(/not (?:undone|acknowledged)/i),
    })
  } finally {
    held.release()
    await fixtureWait(request, 'inner post-apply restore cleanup')
  }
})

test('FIXTURE TRACK34 session switch 31: an admitted A prompt append never adds its row to B after the owner changes', async ($, on) => {
  const held = latch()
  let armed = false
  let heldOnce = false
  const stateGetPayloads: Array<{ plugin: unknown; key: unknown }> = []
  // Register before setup's atom providers so the durability read reaches this
  // relay after captureMintOwner reads A's identity and before it can return.
  on('state.get', async (_, e, next) => {
    stateGetPayloads.push({ plugin: e.plugin, key: e.key })
    if (e.plugin === 'track' && e.key === 'durability' && armed && !heldOnce) {
      armed = false
      heldOnce = true
      held.enter()
      await held.released
    }
    return next(e)
  })
  const fixture = await setup(on)
  await beginA($, fixture)
  armed = true
  const request = outcome($.session.append(appendB('prompt', 'A late prompt must not enter B') as never))
  try {
    const phase = await fixtureWait(Promise.race([
      held.entered.then(() => 'held'), request.then(() => 'returned'),
    ]), 'post-admission prompt durability read')
    if (phase !== 'held') {
      throw new Error(`INVALID FIXTURE: A prompt append returned before its post-admission durability read; state.get payloads=${JSON.stringify(stateGetPayloads)}; append outcome=${JSON.stringify(await request)}`)
    }
    if (fixture.memory.value.session_id !== A || fixture.controls.session !== A || fixture.identityReads.at(-1) !== A) {
      throw new Error('INVALID FIXTURE: prompt durability hold did not follow A ownership admission and identity read')
    }
    fixture.controls.session = B
    const lookup = await fixtureWait($.tool.call({ tool: 'mcp__track__lookup_rows' } as never),
      'post-admission prompt B selection before release')
    try {
      expect(lookup.deny).toBeUndefined()
      expect(lookup.isError).not.toBe(true)
      expect(JSON.parse(String(lookup.result)).ok).toBe(true)
      expect(await unchangedState(fixture)).toEqual(expectedSelectedB(fixture, fixture.b.rows))
    } catch (error) {
      throw new Error(`INVALID FIXTURE: B selection before prompt release failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    held.release()
    const result = await fixtureWait(request, 'post-admission prompt completion')
    expect(result.error).toBeUndefined()
    expect(result.value?.deny).toBeUndefined()
    expect({ postAdmissionPromptCrossOwnerBPrompts: fixture.memory.value.prompts }).toEqual({
      postAdmissionPromptCrossOwnerBPrompts: fixture.b.rows.prompts,
    })
    expect({ postAdmissionPromptCrossOwnerBState: await unchangedState(fixture) }).toEqual({
      postAdmissionPromptCrossOwnerBState: expectedSelectedB(fixture, fixture.b.rows),
    })
  } finally {
    held.release()
    await fixtureWait(request, 'post-admission prompt cleanup')
  }
})

test('FIXTURE TRACK34 session switch 32: a prompt admitted during an identity outage never adds its row to B after recovery', async ($, on) => {
  const held = latch()
  let armed = false
  let heldOnce = false
  const stateGetPayloads: Array<{ plugin: unknown; key: unknown }> = []
  // The unfiltered relay must precede setup's atom providers. Hold only the
  // durability read after ensureOwner fails and captureMintOwner reads A.
  on('state.get', async (_, e, next) => {
    stateGetPayloads.push({ plugin: e.plugin, key: e.key })
    if (e.plugin === 'track' && e.key === 'durability' && armed && !heldOnce) {
      armed = false
      heldOnce = true
      held.enter()
      await held.released
    }
    return next(e)
  })
  const fixture = await setup(on)
  await beginA($, fixture)
  const identityStart = fixture.identityReads.length
  fixture.controls.session = A
  fixture.controls.identityFailure = IDENTITY_FAILURE
  fixture.controls.identityFailOnce = true
  armed = true
  const event = appendB('prompt', 'A outage prompt must not enter B after identity recovers')
  const request = outcome($.session.append(event as never))
  try {
    const phase = await fixtureWait(Promise.race([
      held.entered.then(() => 'held'), request.then(() => 'returned'),
    ]), 'identity-outage prompt durability read')
    if (phase !== 'held') {
      throw new Error(`INVALID FIXTURE: outage prompt append returned before its durability read; state.get payloads=${JSON.stringify(stateGetPayloads)}; append outcome=${JSON.stringify(await request)}`)
    }
    try {
      expect(fixture.identityReads.slice(identityStart)).toEqual([IDENTITY_FAILURE, A])
      expect({ selected: fixture.controls.session, failure: fixture.controls.identityFailure,
        failOnce: fixture.controls.identityFailOnce }).toEqual({ selected: A, failure: '', failOnce: false })
      expect(await unchangedState(fixture)).toEqual(expectedStillA(fixture))
    } catch (error) {
      throw new Error(`INVALID FIXTURE: outage prompt hold did not follow one failed identity read and recovered A capture: ${error instanceof Error ? error.message : String(error)}`)
    }
    fixture.controls.session = B
    const lookup = await fixtureWait($.tool.call({ tool: 'mcp__track__lookup_rows' } as never),
      'identity-outage prompt B selection before release')
    try {
      expect(lookup.deny).toBeUndefined()
      expect(lookup.isError).not.toBe(true)
      expect(JSON.parse(String(lookup.result)).ok).toBe(true)
      expect(await unchangedState(fixture)).toEqual(expectedSelectedB(fixture, fixture.b.rows))
    } catch (error) {
      throw new Error(`INVALID FIXTURE: B selection before outage prompt release failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    held.release()
    const result = await fixtureWait(request, 'identity-outage prompt completion')
    expect(result.error).toBeUndefined()
    expect(result.value?.deny).toBeUndefined()
    expect(result.value).toEqual({ message: event.message, uuid: event.uuid })
    expect({ outagePromptCrossOwnerBPrompts: fixture.memory.value.prompts }).toEqual({
      outagePromptCrossOwnerBPrompts: fixture.b.rows.prompts,
    })
    expect({ outagePromptCrossOwnerBState: await unchangedState(fixture) }).toEqual({
      outagePromptCrossOwnerBState: expectedSelectedB(fixture, fixture.b.rows),
    })
  } finally {
    held.release()
    await fixtureWait(request, 'identity-outage prompt cleanup')
  }
})

test('FIXTURE TRACK34 session switch 33 CONTROL: one identity outage still records a provisional prompt in A without a switch', async ($, on) => {
  const fixture = await setup(on)
  await beginA($, fixture)
  const identityStart = fixture.identityReads.length
  fixture.controls.identityFailure = IDENTITY_FAILURE
  fixture.controls.identityFailOnce = true
  const text = 'A provisional prompt survives one identity outage without switching'
  const event = appendB('prompt', text)
  const result = await fixtureWait(outcome($.session.append(event as never)), 'no-switch outage prompt completion')
  expect(result.error).toBeUndefined()
  expect(result.value?.deny).toBeUndefined()
  expect(result.value).toEqual({ message: event.message, uuid: event.uuid })
  expect(fixture.session.appended()).toEqual([event])
  expect(fixture.identityReads.slice(identityStart, identityStart + 2)).toEqual([IDENTITY_FAILURE, A])
  expect({ failure: fixture.controls.identityFailure, failOnce: fixture.controls.identityFailOnce })
    .toEqual({ failure: '', failOnce: false })
  const expectedMemory = { ...fixture.a.rows, prompts: [...fixture.a.rows.prompts,
    { rowKey: 'eeeeeeee-0000-4000-8000', head: text, turnId: null, at: expect.any(Number) }] }
  expect({ outagePromptNoSwitchAState: await unchangedState(fixture) }).toEqual({
    outagePromptNoSwitchAState: { ...expectedStillA(fixture), memory: expectedMemory },
  })
})

for (const switchToB of [true, false]) {
  const name = switchToB
    ? '34: an A prompt held at the classifier-setting read cannot add pending input to B'
    : '35 CONTROL: an A question held at the classifier-setting read enters A pending without a switch'
  test(`FIXTURE TRACK34 session switch ${name}`, async ($, on) => {
    const held = latch()
    let armed = false
    let heldOnce = false
    const storeGetKeys: string[] = []
    // Relay before setup's store provider. This read occurs only after the
    // composer prompt's ensureOwner admission and before its pending write.
    on('store.get', async (_, e, next) => {
      storeGetKeys.push(e.key)
      if (e.key === 'classifier' && armed && !heldOnce) {
        armed = false
        heldOnce = true
        held.enter()
        await held.released
      }
      return next(e)
    })
    const fixture = await setup(on)
    await beginA($, fixture)
    // Question wording must still be recorded with classification disabled;
    // no background model call can account for the pending mutation here.
    fixture.store.held.set('classifier', { isOn: false })
    const identityStart = fixture.identityReads.length
    const text = 'Why is A still pending after its classifier-setting read?'
    armed = true
    const request = outcome(submit($, text))
    try {
      const phase = await fixtureWait(Promise.race([
        held.entered.then(() => 'held'), request.then(() => 'returned'),
      ]), 'prompt.submit classifier-setting read')
      if (phase !== 'held') {
        throw new Error(`INVALID FIXTURE: A prompt returned before its classifier-setting read; store.get keys=${JSON.stringify(storeGetKeys)}; prompt outcome=${JSON.stringify(await request)}`)
      }
      try {
        expect(fixture.identityReads.slice(identityStart)).toEqual([A])
        expect(fixture.controls.session).toBe(A)
        expect(await unchangedState(fixture)).toEqual(expectedStillA(fixture))
        expect(fixture.pending.value).toEqual({ inputs: [], nextId: 1 })
        expect(fixture.promptCalls).toEqual([])
        expect(fixture.modelCalls).toEqual([])
      } catch (error) {
        throw new Error(`INVALID FIXTURE: classifier-setting hold did not follow successful A ownership admission: ${error instanceof Error ? error.message : String(error)}`)
      }
      let expectedB: Awaited<ReturnType<typeof installBTransient>> | undefined
      if (switchToB) {
        fixture.controls.session = B
        const lookup = await fixtureWait($.tool.call({ tool: 'mcp__track__lookup_rows' } as never),
          'classifier-setting prompt B selection before release')
        try {
          expect(lookup.deny).toBeUndefined()
          expect(lookup.isError).not.toBe(true)
          expect(JSON.parse(String(lookup.result)).ok).toBe(true)
          expect(await unchangedState(fixture)).toEqual(expectedSelectedB(fixture, fixture.b.rows))
          expectedB = await installBTransient(fixture)
          expect({ pending: fixture.pending.value, turn: fixture.turn.value, activity: fixture.activity.value })
            .toEqual({ ...expectedB, activity: idle() })
        } catch (error) {
          throw new Error(`INVALID FIXTURE: B selection and independent pending seed before prompt release failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      held.release()
      const result = await fixtureWait(request, 'classifier-setting prompt completion')
      expect(result.error).toBeUndefined()
      expect(result.value?.drop).toBeUndefined()
      expect(result.value?.text).toBe(text)
      expect(fixture.promptCalls.map(call => call.text)).toEqual([text])
      expect(fixture.modelCalls).toEqual([])
      if (expectedB !== undefined) {
        // Named behavioral RED: the complete independent B pending seed must
        // survive, including its next id, without the admitted A question.
        expect({ postClassifierPromptCrossOwnerBPending: fixture.pending.value }).toEqual({
          postClassifierPromptCrossOwnerBPending: expectedB.pending,
        })
        expect({ postClassifierPromptCrossOwnerBState: await unchangedState(fixture),
          pending: fixture.pending.value, turn: fixture.turn.value, activity: fixture.activity.value }).toEqual({
          postClassifierPromptCrossOwnerBState: expectedSelectedB(fixture, fixture.b.rows),
          ...expectedB, activity: idle(),
        })
        expect(fixture.promptCalls.map(call => ({ ledger: call.ledger, pending: call.pending,
          turn: call.turn, activity: call.activity }))).toEqual([{
          ledger: fixture.b.rows, ...expectedB, activity: idle(),
        }])
      } else {
        expect({ classifierPromptNoSwitchAPending: fixture.pending.value }).toEqual({
          classifierPromptNoSwitchAPending: { ...await pendingQuestion(text), nextId: 2 },
        })
        expect(fixture.pending.value.inputs.map(input => input.id)).toEqual([1])
        expect(await unchangedState(fixture)).toEqual(expectedStillA(fixture))
        expect(fixture.promptCalls.map(call => ({ ledger: call.ledger, pending: call.pending })))
          .toEqual([{ ledger: fixture.a.rows, pending: { ...await pendingQuestion(text), nextId: 2 } }])
      }
    } finally {
      held.release()
      await fixtureWait(request, 'classifier-setting prompt cleanup')
    }
  })
}
