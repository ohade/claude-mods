// CC-170 correction round 1. These fail on the merged banner base and lock items 1-9.
import { expect, mock, test } from 'claude-code/testing'
import type { Activity, Ledger, Step } from '../types'
import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'

const CANCELLED = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."
const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected."
const REFUSED = 'Permission to use Agent has been denied.'

const step = (id: string, extra: Partial<Step> = {}): Step => ({ id, source: 'plan', subject: id, status: 'pending', ...extra })
const setup = (on: On, steps: Step[]) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps })
  const turn = atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  const activity = atomStore<Activity>(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  return { ledger, turn, activity }
}
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never)
const view = (ledger: { value: Ledger }) => ledger.value.steps.map(s => ({ id: s.id, status: s.status, note: s.note, followUp: s.followUp }))

test('a Read result that only quotes the cancel sentence does not park the step', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Read' }, () => ({ result: `184\tconst CANCELLED = "${CANCELLED}"`, isError: true }))
  await call($, { tool: 'Read', tool_use_id: 'toolu_r', file_path: '/x/lifecycle-events.test.tsx' })
  expect(view(ledger)).toEqual([{ id: 'plan:1', status: 'in_progress', note: undefined, followUp: undefined }])
})

test('a result that starts with the cancel sentence but is not an error does not park the step', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Bash' }, () => ({ result: CANCELLED }))
  await call($, { tool: 'Bash', tool_use_id: 'toolu_b', command: 'make' })
  expect(view(ledger)).toEqual([{ id: 'plan:1', status: 'in_progress', note: undefined, followUp: undefined }])
})

test('a rejection sentence at the start of an error result marks the step refused', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Bash' }, () => ({ result: REJECTED, isError: true }))
  await call($, { tool: 'Bash', tool_use_id: 'toolu_b', command: 'make' })
  expect(view(ledger)).toEqual([{ id: 'plan:1', status: 'paused', note: 'refused', followUp: undefined }])
})

test('a Grep line that quotes a permission denial does not park the step', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Grep' }, () => ({ result: 'docs/notes.md:12: Permission to use Bash has been denied.', isError: true }))
  await call($, { tool: 'Grep', tool_use_id: 'toolu_g', pattern: 'denied' })
  expect(view(ledger)).toEqual([{ id: 'plan:1', status: 'in_progress', note: undefined, followUp: undefined }])
})

test('the words user denied permission inside a result do not park the step', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Read' }, () => ({ result: 'the log says user denied permission for the deploy', isError: true }))
  await call($, { tool: 'Read', tool_use_id: 'toolu_r', file_path: '/x/log.txt' })
  expect(view(ledger)).toEqual([{ id: 'plan:1', status: 'in_progress', note: undefined, followUp: undefined }])
})

test('a permission denial that starts an error result marks the step refused', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Agent' }, () => ({ result: REFUSED, isError: true }))
  await call($, { tool: 'Agent', tool_use_id: 'toolu_ag', description: 'review', prompt: 'go' })
  expect(view(ledger)).toEqual([{ id: 'plan:1', status: 'paused', note: 'refused', followUp: undefined }])
})

test('two in-progress steps of this turn make a cancel change nothing', async ($, on) => {
  const { ledger } = setup(on, [
    step('plan:1', { status: 'in_progress', activeTurnId: 't1' }),
    step('plan:2', { status: 'in_progress', activeTurnId: 't1' }),
  ])
  on('tool.call', { tool: 'Bash' }, () => ({ result: CANCELLED, isError: true }))
  await call($, { tool: 'Bash', tool_use_id: 'toolu_b', command: 'make' })
  expect(view(ledger).every(s => s.status === 'in_progress' && s.note === undefined)).toBe(true)
})

test('an in-progress step with no turn id is not a cancel owner', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress' })])
  on('tool.call', { tool: 'Bash' }, () => ({ result: CANCELLED, isError: true }))
  await call($, { tool: 'Bash', tool_use_id: 'toolu_b', command: 'make' })
  expect(view(ledger)).toEqual([{ id: 'plan:1', status: 'in_progress', note: undefined, followUp: undefined }])
})

test('a cancelled Agent launch does not mark a delegated step from another turn', async ($, on) => {
  const { ledger } = setup(on, [
    step('plan:1', { status: 'in_progress', delegated: true, activeTurnId: 't0' }),
    step('plan:2', { status: 'in_progress', activeTurnId: 't1' }),
  ])
  on('tool.call', { tool: 'Agent' }, () => ({ result: CANCELLED, isError: true }))
  await call($, { tool: 'Agent', tool_use_id: 'toolu_ag', description: 'review', prompt: 'go' })
  expect(view(ledger)[0]).toEqual({ id: 'plan:1', status: 'in_progress', note: undefined, followUp: undefined })
  expect(view(ledger)[1]).toEqual({ id: 'plan:2', status: 'paused', note: 'cancelled by you', followUp: undefined })
})

test('a stale open step id does not rewrite a paused step after the next turn starts', async ($, on) => {
  const { ledger, turn } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Bash' }, () => ({ result: CANCELLED, isError: true }))
  await call($, { tool: 'mcp__track__mark_step', id: 'plan:1', status: 'paused', note: 'blocked on vendor' })
  await $.turn.start({ text: 'next', turnId: 't2' } as never)
  await call($, { tool: 'Bash', tool_use_id: 'toolu_b', command: 'ls' })
  expect(turn.value.openStepId).toBeUndefined()
  expect(view(ledger)).toEqual([{ id: 'plan:1', status: 'paused', note: 'blocked on vendor', followUp: undefined }])
})

test('a shell task flags the in-progress step of this turn, not an older paused delegated step', async ($, on) => {
  const { ledger } = setup(on, [
    step('plan:1', { status: 'paused', delegated: true, activeTurnId: 't0' }),
    step('plan:2', { status: 'in_progress', activeTurnId: 't1' }),
  ])
  on('tool.call', { tool: 'Bash' }, () => ({ result: { backgroundTaskId: 'b1' } }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await call($, { tool: 'Bash', tool_use_id: 'toolu_b', command: 'sleep 9', run_in_background: true })
  await $.prompt.submit({ text: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' } } as never)
  expect(view(ledger).map(s => [s.id, s.followUp])).toEqual([['plan:1', undefined], ['plan:2', true]])
})

test('completing a cancelled step clears the cancel reason and the cancel mark', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { subject: 'Launch the agent', status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Agent' }, () => ({ result: CANCELLED, isError: true }))
  await call($, { tool: 'Agent', tool_use_id: 'toolu_ag', description: 'review', prompt: 'go' })
  await call($, { tool: 'mcp__track__mark_step', id: 'plan:1', status: 'completed' })
  const ui = await $.ui.mount(pane('dock')) as { findAll: (q: { type: string }) => Promise<Array<{ text?: string }>> }
  const texts = (await ui.findAll({ type: 'Text' })).map(el => String(el.text ?? ''))
  expect(view(ledger)[0]).toEqual({ id: 'plan:1', status: 'completed', note: undefined, followUp: undefined })
  expect(texts.includes('cancelled by you')).toBe(false)
  expect(texts.includes('⊘')).toBe(false)
})

test('a checkpoint round trip keeps a cancel reason on the paused step', async ($, on) => {
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps: [step('plan:1', { subject: 'Launch', status: 'paused', note: 'cancelled by you' })] })
  pluginStore(on)
  let session = SESSION
  on('session.id', () => ({ value: session }))
  const expected = JSON.parse(String((await call($, { tool: 'mcp__track__checkpoint', expected_session: session })).result))
  session = '11111111-2222-4333-8444-555555555555'
  ledger.value = { ...EMPTY }
  const result = JSON.parse(String((await call($, { tool: 'mcp__track__restore_tracker', from_session: SESSION, expected_checkpoint: expected, tool_use_id: 'toolu_restore' })).result))
  expect(result.ok).toBe(true)
  expect(ledger.value.steps[0]).toMatchObject({ status: 'paused', note: 'cancelled by you' })
})

test('TaskUpdate and TodoWrite clear a finished-work flag when they change status', async ($, on) => {
  const { ledger } = setup(on, [
    step('task:7', { source: 'task', taskId: '7', status: 'in_progress', activeTurnId: 't1', followUp: true }),
    step('todo:ship it', { source: 'todo', subject: 'Ship it', status: 'in_progress', activeTurnId: 't1', followUp: true }),
  ])
  on('tool.call', { tool: 'TaskUpdate' }, () => ({ result: { success: true, taskId: '7', updatedFields: ['status'] } }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { newTodos: [{ content: 'Ship it', status: 'completed' }] } }))
  await call($, { tool: 'TaskUpdate', taskId: '7', status: 'completed' })
  expect(ledger.value.steps[0]).toMatchObject({ status: 'completed', followUp: undefined })
  await call($, { tool: 'TodoWrite', todos: [{ content: 'Ship it', status: 'completed' }] })
  expect(ledger.value.steps.find(s => s.id === 'todo:ship it')).toMatchObject({ status: 'completed', followUp: undefined })
})

test('two finished tasks of one step nudge once, and a second finish does not nudge again', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', delegated: true, activeTurnId: 't1' })])
  const lines: string[] = []
  let n = 0
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: `ag${++n}` } }) as never)
  on('prompt.submit', (_, e) => {
    lines.push(...((e as { context?: string[] }).context ?? []))
    return { text: e.text }
  })
  await call($, { tool: 'Agent', tool_use_id: 'toolu_1', description: 'a', prompt: 'go', run_in_background: true })
  await call($, { tool: 'Agent', tool_use_id: 'toolu_2', description: 'b', prompt: 'go', run_in_background: true })
  await $.prompt.submit({ text: '<task-notification><task-id>ag1</task-id></task-notification><task-notification><task-id>ag2</task-id></task-notification>', origin: { kind: 'task-notification' } } as never)
  await $.prompt.submit({ text: '<task-notification><task-id>ag1</task-id></task-notification>', origin: { kind: 'task-notification' } } as never)
  expect(lines.filter(line => line.includes('background work finished'))).toHaveLength(1)
  expect(ledger.value.steps[0]?.status).toBe('in_progress')
  expect(ledger.value.steps[0]?.followUp).toBe(true)
})

test('a finished task drops its owner id from activity', async ($, on) => {
  const { activity } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Bash' }, () => ({ result: { backgroundTaskId: 'b1' } }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await call($, { tool: 'Bash', tool_use_id: 'toolu_b', command: 'sleep 9', run_in_background: true })
  expect(activity.value.owners?.b1).toEqual(['plan:1'])
  await $.prompt.submit({ text: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' } } as never)
  expect(activity.value.tasks ?? []).not.toContain('b1')
  expect(activity.value.owners?.b1).toBeUndefined()
})
