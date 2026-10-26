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

const setup = async (on: On) => {
  const files = new Map<string, string>()
  const a = await seed(A, await savedRows(A, 'A'), files)
  const b = await seed(B, await savedRows(B, 'B'), files)
  const c = await seed(C, await savedRows(C, 'C'), files)
  const saved = { [A]: a.entry, [B]: b.entry, [C]: c.entry }
  const controls = { session: A, identityFailure: '', readFailure: '', resumeHold: undefined as Latch | undefined,
    modelReply: async (_text: string): Promise<'question' | 'not_question'> => 'not_question' }
  const lease: { leaseFailure?: string } = {}
  const identityReads: string[] = []
  const readRefusals: string[] = []
  const modelCalls: string[] = []
  const promptCalls: PromptObservation[] = []
  const taskCalls: Array<{ subject: unknown; ledger: Ledger }> = []
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
    identityReads.push(controls.identityFailure || controls.session)
    if (controls.identityFailure !== '') throw new Error(controls.identityFailure)
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
    return { result: { task: { id: 'unit2-b-task' } } }
  })
  return { a, b, c, saved, files, controls, lease, clock, session, memory, pending, turn, activity, durability,
    pool, store, lines, identityReads, readRefusals, modelCalls, promptCalls, taskCalls, mutationAttempts, starts }
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


test('FIXTURE TRACK34 session switch 16: failed B resume passes one composer prompt through with an unrecorded notice', async ($, on) => {
  const fixture = await setup(on)
  await beginA($, fixture)
  fixture.controls.session = B
  fixture.controls.readFailure = READ_FAILURE
  const text = 'B composer work must reach the model even when Track cannot resume.'
  const result = await submit($, text)
  expect({ untrackedPromptPassThrough: fixture.promptCalls.map(call => ({
    text: call.text, ledger: call.ledger, pending: call.pending,
    temporary: temporary({ turn: { value: call.turn }, activity: { value: call.activity } }),
    hasResumeCause: call.context.some(line => line.includes(READ_FAILURE)),
    hasUnrecordedNotice: call.context.some(line => line.includes('Track did not record this prompt.')),
  })), drop: result.drop, readRefusals: fixture.readRefusals, pending: fixture.pending.value,
  temporary: temporary(fixture), state: await unchangedState(fixture) }).toEqual({
    untrackedPromptPassThrough: [{ text, ledger: fixture.a.rows, pending: { inputs: [], nextId: 1 },
      temporary: emptyTemporary, hasResumeCause: true, hasUnrecordedNotice: true }],
    drop: undefined, readRefusals: expect.arrayContaining([READ_FAILURE]), pending: { inputs: [], nextId: 1 },
    temporary: emptyTemporary, state: expectedStillA(fixture),
  })
})

test('FIXTURE TRACK34 session switch 17: failed B resume refuses expected-checkpoint restore before target work with a v1 receipt', async ($, on) => {
  const fixture = await setup(on)
  await beginA($, fixture)
  const restoreTimelineStart = fixture.store.locks.timeline.length
  fixture.controls.session = B
  fixture.controls.readFailure = READ_FAILURE
  const result = await $.tool.call({ tool: 'mcp__track__restore_tracker', from_session: A,
    expected_checkpoint: fixture.a.head.checkpoint, tool_use_id: 'unit2-b-restore-refused' } as never)
  const restoreSourceReads = fixture.store.locks.timeline.slice(restoreTimelineStart).filter(event => event === `get:s:${A}`)
  expect({ restoreSourceReadsBeforeRefusal: restoreSourceReads }).toEqual({ restoreSourceReadsBeforeRefusal: [] })
  let receipt: unknown = { invalidReceipt: 'missing result' }
  try {
    if (typeof result.result === 'string') receipt = JSON.parse(result.result)
  } catch {
    // Keep malformed product output inside the named receipt assertion.
    receipt = { invalidReceipt: 'malformed JSON result' }
  }
  expect({ ownershipGuardReceipt: receipt, deny: result.deny,
    readRefusals: fixture.readRefusals, appended: fixture.session.appended(), pending: fixture.pending.value,
    temporary: temporary(fixture), state: await unchangedState(fixture) }).toEqual({
    ownershipGuardReceipt: { v: 1, ok: false, source_session: A, destination_session: B, revision: 0, checksum: '',
      counts: { questions: 0, answers: 0, steps: 0 }, reason: expect.any(String) },
    deny: undefined, readRefusals: expect.arrayContaining([READ_FAILURE]), appended: [], pending: { inputs: [], nextId: 1 },
    temporary: emptyTemporary, state: expectedStillA(fixture),
  })
  expect((receipt as { reason: string }).reason).toContain(READ_FAILURE)
})

test('FIXTURE TRACK34 session switch 18: first B reorder_steps refuses failed resume before ordering or save work', async ($, on) => {
  const fixture = await setup(on)
  await beginA($, fixture)
  const ledgerWriteStart = fixture.memory.writes.length
  fixture.controls.session = B
  fixture.controls.readFailure = READ_FAILURE
  // The sole visible id is valid. This checks admission, not positive reordering.
  const result = await $.tool.call({ tool: 'mcp__track__reorder_steps', ids: ['plan:1'],
    tool_use_id: 'unit2-b-reorder-refused' } as never)
  expect({ reorderLedgerWritesBeforeRefusal: fixture.memory.writes.slice(ledgerWriteStart) })
    .toEqual({ reorderLedgerWritesBeforeRefusal: [] })
  expect({ ownershipGuardRefusal: { deny: result.deny, result: result.result }, readRefusals: fixture.readRefusals,
    pending: fixture.pending.value, temporary: temporary(fixture), state: await unchangedState(fixture) }).toEqual({
    ownershipGuardRefusal: { deny: expect.any(String), result: undefined }, readRefusals: expect.arrayContaining([READ_FAILURE]),
    pending: { inputs: [], nextId: 1 }, temporary: emptyTemporary, state: expectedStillA(fixture),
  })
  expect(result.deny).toContain(READ_FAILURE)
})
