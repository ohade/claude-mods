// FIXTURE: 2026-10-19 native Stop repair replaced an in-progress plan because
// an existing step had no way to acknowledge the request it already covered.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Pending, PendingInput, Step } from '../types'

const MARK = 'mcp__track__mark_step'
const REQUEST = 'Can you continue the existing work?'
const OTHER = 'Can you inspect another file?'
const FIRST = '11111111-2222-4333-8444-555555555555'
const SECOND = 'aaaaaaaa-2222-4333-8444-555555555555'
const ACTIVE: Step = { id: 'plan:1', source: 'plan', subject: 'Original work', status: 'in_progress', startedAt: 100, activeTurnId: 'turn-1' }
const input = (id = 1, head = REQUEST, request = FIRST): PendingInput => ({
  id, head, excerpt: head, rowKey: request.slice(0, request.lastIndexOf('-')), textHash: 'a'.repeat(64), turnId: 'turn-1',
})
const prepare = (on: On, row = ACTIVE, inputs = [input()]) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, session_id: SESSION, v: 1, steps: [{ ...row }] })
  const pending = atomStore<Pending>(on, 'pending', { inputs, nextId: inputs.length + 1 })
  atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'scroll', { questions: null, steps: null })
  const store = pluginStore(on)
  logs(on)
  on('session.id', () => ({ value: SESSION }))
  on('env.get', { name: /^(?!(?:CLAUDE_CONFIG_DIR|HOME)$)/ }, () => ({ value: undefined }))
  on('env.set', () => ({ value: {} }))
  on('classic.Stop', () => ({}))
  const pool = blobPool(on)
  return { ledger, pending, store, pool }
}
const mark = ($: Engine, extra: Record<string, unknown> = {}) => $.tool.call({
  tool: MARK, tool_use_id: 'mark-call', id: 'plan:1', status: 'in_progress', source_text: REQUEST, ...extra,
} as never)

test('TRACK-8 reusing a step acknowledges its exact request without replacing work or its clock', async ($, on) => {
  const f = prepare(on)
  await mark($)
  expect(f.pending.value.inputs[0]?.covered).toBe('steps')
  expect(f.ledger.value.steps).toHaveLength(1)
  expect(f.ledger.value.steps[0]).toMatchObject(ACTIVE)
  expect((await f.pool.logical(f.store, `s:${SESSION}`) as { ledger: Ledger }).ledger.steps[0]).toMatchObject(ACTIVE)
})

test('TRACK-8 a reuse request id takes precedence over another request text', async ($, on) => {
  const f = prepare(on, ACTIVE, [input(), input(2, OTHER, SECOND)])
  await mark($, { source_request_id: SECOND })
  expect(f.pending.value.inputs[0]?.covered).toBeUndefined()
  expect(f.pending.value.inputs[1]?.covered).toBe('steps')
})

test('TRACK-8 completing work that was open can acknowledge its request', async ($, on) => {
  const f = prepare(on)
  await mark($, { status: 'completed' })
  expect(f.pending.value.inputs[0]?.covered).toBe('steps')
  expect(f.ledger.value.steps[0]?.status).toBe('completed')
})

test('TRACK-8 an unchanged already saved step can acknowledge its request', async ($, on) => {
  const f = prepare(on)
  await mark($, { source_text: undefined, tool_use_id: 'first-mark' })
  expect(f.pending.value.inputs[0]?.covered).toBeUndefined()
  await mark($)
  expect(f.pending.value.inputs[0]?.covered).toBe('steps')
  expect(f.ledger.value.steps[0]).toMatchObject(ACTIVE)
})

for (const scenario of [
  { name: 'an unknown step', extra: { id: 'plan:99' } },
  { name: 'an invalid status', extra: { status: 'invalid' } },
  { name: 'a denied subagent call', extra: { agentId: 'worker' } },
  { name: 'a different request', extra: { source_text: OTHER } },
  { name: 'no explicit request', extra: { source_text: undefined } },
  { name: 'a cleared step', extra: {}, row: { ...ACTIVE, cleared: true as const } },
  { name: 'an old completed row', extra: { status: 'completed' }, row: { ...ACTIVE, status: 'completed' as const, endedAt: 200 } },
]) {
  test(`TRACK-8 reuse cannot cover through ${scenario.name}`, async ($, on) => {
    const f = prepare(on, scenario.row ?? ACTIVE)
    await mark($, scenario.extra)
    expect(f.pending.value.inputs[0]?.covered).toBeUndefined()
    expect(f.ledger.value.steps.map(row => row.id)).toEqual(['plan:1'])
  })
}

test('TRACK-8 a failed reused-step save cannot acknowledge its request', async ($, on) => {
  const f = prepare(on)
  f.store.faults.write = 'disk unavailable'
  expect(String((await mark($, { status: 'paused' })).result)).toContain('unsaved')
  expect(f.pending.value.inputs[0]?.covered).toBeUndefined()
})

test('TRACK-8 a classifier-labelled question still needs its own question row after step reuse', async ($, on) => {
  const f = prepare(on, ACTIVE, [{ ...input(), label: 'question' }])
  await mark($)
  expect(f.pending.value.inputs[0]?.covered).toBeUndefined()
  const held = await $.classic.Stop({ session_id: SESSION, stop_hook_active: false } as never)
  expect(held.block).toContain('classifier labelled')
  expect(held.block).toContain('mcp__track__track_question')
})

test('TRACK-8 Stop repair preserves the running plan when its existing step acknowledges the request', async ($, on) => {
  const f = prepare(on)
  const held = await $.classic.Stop({ session_id: SESSION, stop_hook_active: false } as never)
  expect(held.block).toContain('mcp__track__mark_step, keeping its current status and the same source_text')
  expect(held.block).toContain('use after when steps already exist')
  await mark($)
  expect(f.pending.value.inputs[0]?.covered).toBe('steps')
  expect(f.ledger.value.steps[0]).toMatchObject(ACTIVE)
  expect(f.ledger.value.steps).toHaveLength(1)
  expect((await $.classic.Stop({ session_id: SESSION, stop_hook_active: false } as never)).block).toBeUndefined()
})

test('TRACK-8 the native mark_step schema exposes explicit request association', async ($, on) => {
  prepare(on)
  let properties: Record<string, unknown> = {}
  on('ui.panes', () => ({ value: [] }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => {
    if (e.name === 'mark_step') properties = (e.inputSchema as { properties: Record<string, unknown> }).properties
    return { value: { tool: `mcp__track__${e.name}` } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: false })
  expect(properties.source_text).toMatchObject({ type: 'string' })
  expect(properties.source_request_id).toMatchObject({ type: 'string' })
})

// FIXTURE: 2026-10-19 review reproduced two completion calls both treating
// the same row as open, and an off-schema questionId entering request state.
test('TRACK-8 parallel completion cannot let a completed repeat cover a second request', async ($, on) => {
  const f = prepare(on, ACTIVE, [input(), input(2, OTHER, SECOND)])
  await Promise.all([
    mark($, { status: 'completed', tool_use_id: 'complete-first' }),
    mark($, { status: 'completed', source_text: OTHER, tool_use_id: 'complete-second' }),
  ])
  expect(f.pending.value.inputs.filter(row => row.covered === 'steps')).toHaveLength(1)
  expect(f.ledger.value.steps).toHaveLength(1)
  expect(f.ledger.value.steps[0]?.status).toBe('completed')
})

test('TRACK-8 step association cannot set an off-schema question id', async ($, on) => {
  const f = prepare(on)
  await mark($, { questionId: 7 })
  expect(f.pending.value.inputs[0]?.covered).toBe('steps')
  expect(f.pending.value.inputs[0]?.questionId).toBeUndefined()
})

test('TRACK-8 deliberately reopening completed work can cover its request', async ($, on) => {
  const f = prepare(on, { ...ACTIVE, status: 'completed', endedAt: 200 })
  await mark($)
  expect(f.pending.value.inputs[0]?.covered).toBe('steps')
  expect(f.ledger.value.steps[0]?.status).toBe('in_progress')
})

test('TRACK-8 a sourceless unchanged mark keeps its existing result text', async ($, on) => {
  prepare(on)
  const result = await mark($, { source_text: undefined })
  expect(result.result).toBe('Step plan:1 "Original work" marked in_progress.')
})

// FIXTURE: UI-1, 2026-10-20 review: track_steps without after, or with after: '',
// deleted unfinished work while presenting the new rows as successful registration.
const registerPlan = ($: Engine, extra: Record<string, unknown> = {}) => $.tool.call({
  tool: 'mcp__track__track_steps', tool_use_id: 'plan-call', steps: ['New work'], source_text: REQUEST, ...extra,
} as never)

for (const status of ['pending', 'in_progress', 'waiting', 'paused'] as const) {
  test(`UI-1 implicit replacement preserves ${status} work and refuses registration`, async ($, on) => {
    const original = { ...ACTIVE, status }
    const f = prepare(on, original)
    const result = await registerPlan($)
    expect(f.ledger.value.steps).toEqual([original])
    expect(f.pending.value.inputs[0]?.covered).toBeUndefined()
    expect(String(result.result)).toContain('replace: true')
    expect(String(result.result)).toContain('plan:1')
    expect(String(result.result)).toContain('Original work')
  })
}

for (const after of ['', '   ', null, 3, false]) {
  test(`UI-1 invalid after ${JSON.stringify(after)} cannot replace or acknowledge work`, async ($, on) => {
    const f = prepare(on)
    await registerPlan($, { after, replace: true })
    expect(f.ledger.value.steps).toEqual([ACTIVE])
    expect(f.pending.value.inputs[0]?.covered).toBeUndefined()
  })
}

test('UI-1 explicit replacement is usable and keeps unrelated task rows', async ($, on) => {
  const f = prepare(on)
  const task: Step = { id: 'task:7', source: 'task', taskId: '7', subject: 'Separate task', status: 'waiting' }
  f.ledger.value.steps.push(task)
  await registerPlan($, { replace: true })
  expect(f.ledger.value.steps.find(row => row.id === task.id)).toEqual({ ...task, session_id: SESSION })
  expect(f.ledger.value.steps.filter(row => row.source === 'plan')).toMatchObject([
    { id: 'plan:1', subject: 'New work', status: 'pending' },
  ])
  expect(f.pending.value.inputs[0]?.covered).toBe('steps')
})

test('UI-1 insertion preserves unfinished work and registers its addition', async ($, on) => {
  const f = prepare(on)
  await registerPlan($, { after: 'plan:1' })
  expect(f.ledger.value.steps[0]).toEqual({ ...ACTIVE, session_id: SESSION })
  expect(f.ledger.value.steps[1]).toMatchObject({ id: 'plan:2', subject: 'New work', status: 'pending' })
  expect(f.pending.value.inputs[0]?.covered).toBe('steps')
})

test('UI-1 a completed plan can be replaced without a redundant flag', async ($, on) => {
  const f = prepare(on, { ...ACTIVE, status: 'completed', endedAt: 200 })
  await registerPlan($)
  expect(f.ledger.value.steps).toMatchObject([{ id: 'plan:1', subject: 'New work', status: 'pending' }])
  expect(f.pending.value.inputs[0]?.covered).toBe('steps')
})

test('UI-1 the native track_steps schema exposes explicit replacement', async ($, on) => {
  prepare(on)
  let properties: Record<string, unknown> = {}
  on('ui.panes', () => ({ value: [] }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => {
    if (e.name === 'track_steps') properties = (e.inputSchema as { properties: Record<string, unknown> }).properties
    return { value: { tool: `mcp__track__${e.name}` } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: false })
  expect(properties.replace).toMatchObject({ type: 'boolean' })
})
