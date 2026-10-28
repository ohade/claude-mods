import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Activity, Ledger, Pending, PendingInput, Prompt, Question, Turn } from '../types'

// WO plan:17 (2026-10-27): turn.start also fires for a subagent's loop (agentId set). plan:7
// guarded only the activity update; the handler still made the subagent's turn the current one,
// replaced the main turn's freshness record, filtered and bound pending inputs to it, and bound
// unbound prompts and questions to it. A subagent's turn.start must leave the main turn's state
// alone; a main turn.start still resets and binds as before (C1).

const EDIT = 'track: this turn changed files but no step was created or marked. Reuse a step with mark_step or register one with track_steps, then finish.'

const invoke = ($: Engine, tool: string, input: object = {}) => $.tool.call({ tool, tool_use_id: `${tool}-call`, ...input } as never)
const response = ($: Engine, text = 'The requested work is ready.') => $.session.append({
  door: 'response', uuid: '11111111-2222-4333-8444-555555555555',
  message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
  origin: { kind: 'model', model: 'fixture' },
} as never)
const stop = ($: Engine) => $.classic.Stop({ session_id: SESSION, stop_hook_active: false, background_tasks: [] } as never)
const start = ($: Engine, turnId: string, agentId?: string) =>
  $.turn.start({ text: '', turnId, ...(agentId !== undefined && { agentId }) } as never)
const complete = ($: Engine, turnId: string, agentId?: string) =>
  $.turn.complete({ answer: 'done', reason: 'answer', turnId, durationMs: 1, isAborted: false, ...(agentId !== undefined && { agentId }) } as never)
const input = (id: number, turnId: string | null, extra: Partial<PendingInput> = {}): PendingInput =>
  ({ id, head: `input ${id}`, excerpt: `input ${id}`, textHash: `hash-${id}`, turnId, ...extra })
const prompt = (turnId: string | null): Prompt => ({ rowKey: 'row-1', turnId, head: 'a prompt', at: 1 })
const question = (turnId: string | null): Question => ({ id: 1, head: 'a question', at: 1, turnId, status: 'open' })

// The Stop claim helper is modelled as in step-freshness.test.tsx: it blocks once on the
// untracked_edit candidate when the snapshot carries the main response receipt.
const prepare = async ($: Engine, on: On) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps: [] })
  const turn = atomStore<Turn>(on, 'turn', { currentId: null, gatedTurnId: null, eventOrder: 0 })
  const activity = atomStore<Activity>(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [], owners: {} })
  const pending = atomStore<Pending>(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on)
  logs(on)
  const claim = { taken: false }
  const env = new Map<string, string>([['CLAUDE_PLUGIN_ROOT', '/fixture/track'], ['CLAUDE_CONFIG_DIR', '/fixture/config']])
  on('session.id', () => ({ value: SESSION }))
  on('session.messages', () => ({ value: [] }))
  on('session.append', (_, e, next) => next(e))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
  on('tool.call', { tool: /^(Edit|Write|MultiEdit|NotebookEdit|Bash)$/ }, () => ({ result: 'fixture success' }))
  on('env.get', (_, e) => ({ value: env.get(e.name) }))
  on('env.set', (_, e) => { env.set(e.name, String(e.value)); return { value: {} } })
  on('process.run', { argv: /^\/.*\/hooks\/stop-gate\.py$/ }, () => {
    const snapshot = JSON.parse(env.get('TRACK_GATE_SNAPSHOT') ?? '{}')
    const candidate = snapshot.candidates?.find((row: { kind: string }) => row.kind === 'untracked_edit')
    const responseKnown = snapshot.response?.turn_id === snapshot.turn_id && typeof snapshot.response?.request_id === 'string'
    const answer = candidate !== undefined && responseKnown && !claim.taken ? { decision: 'block', reason: EDIT } : {}
    if ('decision' in answer) claim.taken = true
    return { value: { exitCode: 0, stdout: JSON.stringify(answer), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await start($, 't1')
  return { ledger, turn, pending, activity }
}

test('P1 the main turn keeps its freshness record across a subagent turn', async ($, on) => {
  const fixture = await prepare($, on)
  await invoke($, 'Edit')
  await start($, 'a1', 'ag1')
  await complete($, 'a1', 'ag1')

  expect(fixture.turn.value.freshness?.turnId).toBe('t1')
  expect(fixture.turn.value.freshness?.edits).toEqual(['Edit-call'])
})

test('P2 the current turn stays the main turn after a subagent turn starts', async ($, on) => {
  const fixture = await prepare($, on)
  await start($, 'a1', 'ag1')

  expect(fixture.turn.value.currentId).toBe('t1')
})

test('P3 a subagent turn neither drops a main-turn input nor binds an unbound one', async ($, on) => {
  const fixture = await prepare($, on)
  fixture.pending.value = { inputs: [input(1, 't1', { label: 'not_question' }), input(2, null)], nextId: 3 }
  await start($, 'a1', 'ag1')

  expect(fixture.pending.value.inputs.map(i => [i.id, i.turnId])).toEqual([[1, 't1'], [2, null]])
})

test('P4 a subagent turn does not bind an unbound prompt or question', async ($, on) => {
  const fixture = await prepare($, on)
  fixture.ledger.value = { ...fixture.ledger.value, prompts: [prompt(null)], questions: [question(null)] }
  await start($, 'a1', 'ag1')

  expect(fixture.ledger.value.prompts.map(p => p.turnId)).toEqual([null])
  expect(fixture.ledger.value.questions.map(q => q.turnId)).toEqual([null])
})

test('P5 the main turn Stop still blocks an edit without a step after a subagent ran inside it', async ($, on) => {
  await prepare($, on)
  await invoke($, 'Edit')
  await start($, 'a1', 'ag1')
  await complete($, 'a1', 'ag1')
  await response($)

  expect((await stop($)).block).toBe(EDIT)
})

test('C1 control: a main turn.start still resets freshness, drops a spent input and binds unbound rows', async ($, on) => {
  const fixture = await prepare($, on)
  await invoke($, 'Edit')
  await complete($, 't1')
  fixture.pending.value = { inputs: [input(1, 't1', { label: 'not_question' }), input(2, null)], nextId: 3 }
  fixture.ledger.value = { ...fixture.ledger.value, prompts: [prompt(null)], questions: [question(null)] }
  await start($, 't2')

  expect(fixture.turn.value.currentId).toBe('t2')
  expect(fixture.turn.value.freshness?.turnId).toBe('t2')
  expect(fixture.turn.value.freshness?.edits).toEqual([])
  expect(fixture.pending.value.inputs.map(i => [i.id, i.turnId])).toEqual([[2, 't2']])
  expect(fixture.ledger.value.prompts.map(p => p.turnId)).toEqual(['t2'])
  expect(fixture.ledger.value.questions.map(q => q.turnId)).toEqual(['t2'])
})

// A live background agent must not change how a MAIN turn.start resets and binds (refuter r1, m3).
test('C2 control: a main turn.start with a background agent still running resets and binds as C1', async ($, on) => {
  const fixture = await prepare($, on)
  await invoke($, 'Edit')
  await complete($, 't1')
  fixture.activity.value = { ...fixture.activity.value, background: ['ag1'] }
  fixture.pending.value = { inputs: [input(1, 't1', { label: 'not_question' }), input(2, null)], nextId: 3 }
  fixture.ledger.value = { ...fixture.ledger.value, prompts: [prompt(null)], questions: [question(null)] }
  await start($, 't2')

  expect(fixture.turn.value.currentId).toBe('t2')
  expect(fixture.turn.value.freshness?.turnId).toBe('t2')
  expect(fixture.turn.value.freshness?.edits).toEqual([])
  expect(fixture.pending.value.inputs.map(i => [i.id, i.turnId])).toEqual([[2, 't2']])
  expect(fixture.ledger.value.prompts.map(p => p.turnId)).toEqual(['t2'])
  expect(fixture.ledger.value.questions.map(q => q.turnId)).toEqual(['t2'])
  expect(fixture.activity.value.isWorking).toBe(true)
  expect(fixture.activity.value.mainTurnId).toBe('t2')
})
