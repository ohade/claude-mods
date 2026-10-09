// CC-170 cases 1, 4 and 5. A user cancel or a permission denial is not a model-chosen pause.
import { expect, mock, test } from 'claude-code/testing'
import type { Ledger, Step } from '../types'
import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'

const CANCELLED = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."
const REFUSED = 'Permission to use Agent has been denied.'
const OLD = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'

const step = (id: string, extra: Partial<Step> = {}): Step => ({ id, source: 'plan', subject: id, status: 'pending', ...extra })
const setup = (on: On, steps: Step[]) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  const store = pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  return { ledger, store }
}
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never)
const textsOf = async ($: Engine) => {
  const ui = await $.ui.mount(pane('dock')) as { findAll: (q: { type: string }) => Promise<Array<{ text?: string }>> }
  return (await ui.findAll({ type: 'Text' })).map(el => String(el.text ?? ''))
}

test('a tool the user cancelled marks its in-progress step cancelled by you', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { subject: 'Launch the agent', status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Agent' }, () => ({ result: CANCELLED, isError: true }))
  await call($, { tool: 'Agent', tool_use_id: 'toolu_ag', description: 'review', prompt: 'go' })
  expect(ledger.value.steps[0]).toMatchObject({ status: 'paused', note: 'cancelled by you' })
  expect(await textsOf($)).toEqual(expect.arrayContaining(['S1. Launch the agent', 'cancelled by you', '⊘']))
})

test('a model pause keeps its note when a later cancel arrives after the step is already paused', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { subject: 'Launch the agent', status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Agent' }, () => ({ result: CANCELLED, isError: true }))
  await call($, { tool: 'mcp__track__mark_step', id: 'plan:1', status: 'paused', note: 'paused by Ohad' })
  await call($, { tool: 'Agent', tool_use_id: 'toolu_ag', description: 'review', prompt: 'go' })
  expect(ledger.value.steps[0]).toMatchObject({ status: 'paused', note: 'paused by Ohad' })
})

test('a permission denial the transcript shows marks the owning step refused', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Agent' }, () => ({ result: REFUSED, isError: true }))
  await call($, { tool: 'Agent', tool_use_id: 'toolu_ag', description: 'review', prompt: 'go' })
  expect(ledger.value.steps[0]).toMatchObject({ status: 'paused', note: 'refused' })
})

test('a paused delegated step is not rewritten by a cancelled Agent launch', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'paused', delegated: true, note: 'paused by Ohad' })])
  on('tool.call', { tool: 'Agent' }, () => ({ result: CANCELLED, isError: true }))
  await call($, { tool: 'Agent', tool_use_id: 'toolu_ag', description: 'review', prompt: 'go' })
  expect(ledger.value.steps[0]).toMatchObject({ status: 'paused', note: 'paused by Ohad', delegated: true })
})

test('an ordinary tool error, a waiting step, and a subagent call stay as they were', async ($, on) => {
  const steps = [
    step('plan:1', { status: 'in_progress', activeTurnId: 't1' }),
    step('plan:2', { status: 'waiting' }),
  ]
  const { ledger } = setup(on, steps)
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'command not found', isError: true }))
  on('tool.call', { tool: 'Agent' }, () => ({ result: CANCELLED }))
  await call($, { tool: 'Bash', tool_use_id: 'toolu_b', command: 'false' })
  expect(ledger.value.steps[0]?.status).toBe('in_progress')
  expect(ledger.value.steps[0]?.note).toBeUndefined()
  expect(ledger.value.steps[1]).toEqual(steps[1])
  await call($, { tool: 'Agent', tool_use_id: 'toolu_ag', agentId: 'agent-1', description: 'review', prompt: 'go' })
  expect(ledger.value.steps[0]?.status).toBe('in_progress')
  expect(ledger.value.steps[0]?.note).toBeUndefined()
  expect(ledger.value.steps[1]).toEqual(steps[1])
})

test('a finished background agent flags its still-open step and nudges once, without changing status', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { subject: 'Consult peers', status: 'in_progress', delegated: true, activeTurnId: 't1' })])
  let submitted: { context?: string[] } | undefined
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } }) as never)
  on('prompt.submit', (_, e) => {
    submitted = e as { context?: string[] }
    return { text: e.text }
  })
  await call($, { tool: 'Agent', tool_use_id: 'toolu_ag', description: 'review', prompt: 'go', run_in_background: true })
  await $.prompt.submit({ text: '<task-notification><task-id>ag1</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' } } as never)
  expect(ledger.value.steps[0]?.status).toBe('in_progress')
  expect(ledger.value.steps[0]?.delegated).toBe(true)
  const nudges = (submitted?.context ?? []).filter(line => line.includes('background work finished'))
  expect(nudges).toEqual(['track: background work finished while plan:1 is still delegated in_progress; update it with mcp__track__mark_step.'])
  expect(await textsOf($)).toEqual(expect.arrayContaining(['S1. Consult peers', 'update status']))
})

test('a finished task does not flag an older paused delegated step', async ($, on) => {
  const { ledger } = setup(on, [
    step('plan:1', { status: 'paused', delegated: true }),
    step('plan:2', { status: 'completed', delegated: true }),
  ])
  let submitted: { context?: string[] } | undefined
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } }) as never)
  on('prompt.submit', (_, e) => {
    submitted = e as { context?: string[] }
    return { text: e.text }
  })
  await call($, { tool: 'Agent', tool_use_id: 'toolu_ag', description: 'review', prompt: 'go', run_in_background: true })
  await $.prompt.submit({ text: '<task-notification><task-id>ag1</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' } } as never)
  expect(ledger.value.steps.map(s => s.status)).toEqual(['paused', 'completed'])
  expect((ledger.value.steps[0] as Step & { followUp?: true }).followUp).toBeUndefined()
  expect((ledger.value.steps[1] as Step & { followUp?: true }).followUp).toBeUndefined()
  expect((submitted?.context ?? []).filter(line => line.includes('background work finished'))).toHaveLength(0)
})

test('a finished shell task flags the in-progress step that launched it', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Bash' }, () => ({ result: { backgroundTaskId: 'b1' } }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await call($, { tool: 'Bash', tool_use_id: 'toolu_b', command: 'sleep 9', run_in_background: true })
  await $.prompt.submit({ text: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' } } as never)
  expect(ledger.value.steps[0]?.status).toBe('in_progress')
  expect((ledger.value.steps[0] as Step & { followUp?: true }).followUp).toBe(true)
})

test('a handoff restore keeps cancel, pause, and interrupted reasons on the row', async ($, on) => {
  const { ledger, store } = setup(on, [])
  store.held.set(`s:${OLD}`, { v: 1, savedAt: 1, ledger: { ...EMPTY, steps: [
    step('plan:1', { subject: 'Launch', status: 'paused', note: 'cancelled by you' }),
    step('plan:2', { subject: 'Turn', status: 'paused', note: 'interrupted' }),
    step('plan:3', { subject: 'Parked', status: 'paused', note: 'later' }),
  ] } })
  await call($, { tool: 'mcp__track__restore_tracker', from_session: OLD })
  expect(ledger.value.steps.map(s => [s.status, s.note])).toEqual([
    ['paused', 'cancelled by you'],
    ['paused', 'interrupted'],
    ['paused', 'later'],
  ])
  const texts = await textsOf($)
  expect(texts).toEqual(expect.arrayContaining(['cancelled by you', 'interrupted', '⊘']))
  expect(texts).not.toContain('later')
  expect(texts.filter(text => text === '⏸').length).toBeGreaterThanOrEqual(2)
})
