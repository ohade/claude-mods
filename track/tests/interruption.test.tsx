// FIXTURE: the supported aborted-turn event parks only work owned by that main turn.
import { expect, mock, test } from 'claude-code/testing'
import type { Ledger, Step } from '../types'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine, On } from './kit'

type OwnedStep = Step & { activeTurnId?: string }
type Held = Omit<Ledger, 'steps'> & { steps: OwnedStep[] }
const step = (id: string, extra: Partial<OwnedStep> = {}): OwnedStep => ({ id, source: 'plan', subject: id, status: 'pending', ...extra })
const setup = (on: On, steps: OwnedStep[], currentId = 't1') => {
  mock.clock(on)
  const ledger = atomStore<Held>(on, 'ledger', { ...EMPTY, v: 1, steps })
  const turn = atomStore(on, 'turn', { currentId, gatedTurnId: null })
  const activity = atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [] })
  const store = pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { ledger, turn, activity, store }
}
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never)
const finish = ($: Engine, turnId = 't1', isAborted = true, agentId?: string) => $.turn.complete({
  answer: '', reason: isAborted ? 'aborted' : 'answer', turnId, durationMs: 1, isAborted,
  ...(agentId !== undefined && { agentId }),
} as never)

test('an interrupted main turn pauses its own marked work and durably keeps every other row', async ($, on) => {
  const others = [
    step('earlier', { status: 'in_progress', activeTurnId: 't0' }),
    step('delegated', { status: 'in_progress', delegated: true, activeTurnId: 't1' }),
    step('done', { status: 'completed' }), step('later'), step('needs-you', { status: 'waiting' }),
    step('cleared', { status: 'in_progress', activeTurnId: 't1', cleared: true }),
  ]
  const { ledger, store, activity } = setup(on, [step('plan:1'), ...others])
  await call($, { tool: 'mcp__track__mark_step', id: 'plan:1', status: 'in_progress' })
  await finish($)
  expect(ledger.value.steps[0]?.status).toBe('paused')
  expect(ledger.value.steps[0]?.note).toBe('interrupted')
  expect(ledger.value.steps[0]?.activeTurnId).toBeUndefined()
  expect(ledger.value.steps.slice(1)).toEqual(others)
  expect(activity.value.isWorking).toBe(false)
  const saved = store.held.get(`s:${SESSION}`) as { ledger: Ledger } | undefined
  expect(saved?.ledger.steps).toEqual(ledger.value.steps)
})

test('an interrupted turn also parks a successful TaskUpdate from that turn', async ($, on) => {
  const { ledger } = setup(on, [step('task:7', { source: 'task', taskId: '7' })])
  on('tool.call', { tool: 'TaskUpdate' }, () => ({ result: { success: true, taskId: '7', updatedFields: ['status'] } }))
  await call($, { tool: 'TaskUpdate', taskId: '7', status: 'in_progress' })
  await finish($)
  expect(ledger.value.steps[0]?.status).toBe('paused')
  expect(ledger.value.steps[0]?.note).toBe('interrupted')
})

test('an interrupted turn also parks successful TodoWrite work from that turn', async ($, on) => {
  const { ledger } = setup(on, [])
  const newTodos = [{ content: 'Current work', status: 'in_progress', activeForm: 'Working' }]
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos } }))
  await call($, { tool: 'TodoWrite', todos: newTodos })
  await finish($)
  expect(ledger.value.steps[0]?.status).toBe('paused')
  expect(ledger.value.steps[0]?.note).toBe('interrupted')
})

test('a normal completion does not claim unfinished steps were interrupted', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1')])
  await call($, { tool: 'mcp__track__mark_step', id: 'plan:1', status: 'in_progress' })
  const before = structuredClone(ledger.value)
  await finish($, 't1', false)
  expect(ledger.value).toEqual(before)
})

test('an aborted agent turn cannot park the main turn or stop its working banner', async ($, on) => {
  const { ledger, activity } = setup(on, [step('plan:1')])
  await call($, { tool: 'mcp__track__mark_step', id: 'plan:1', status: 'in_progress' })
  const before = structuredClone(ledger.value)
  await finish($, 'agent-turn', true, 'agent-1')
  expect(ledger.value).toEqual(before)
  expect(activity.value.isWorking).toBe(true)
})

test('a stale aborted completion leaves a newer turn and its work running', async ($, on) => {
  const { ledger, activity } = setup(on, [step('plan:1')], 't2')
  await call($, { tool: 'mcp__track__mark_step', id: 'plan:1', status: 'in_progress' })
  const before = structuredClone(ledger.value)
  await finish($, 't1')
  expect(ledger.value).toEqual(before)
  expect(activity.value.isWorking).toBe(true)
})

test('a reload of this session keeps turn ownership until its abort arrives', async ($, on) => {
  const { ledger, store } = setup(on, [])
  store.held.set(`s:${SESSION}`, { v: 1, savedAt: 1, ledger: { ...EMPTY, steps: [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })] } })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await finish($)
  expect(ledger.value.steps[0]?.status).toBe('paused')
  expect(ledger.value.steps[0]?.note).toBe('interrupted')
})

test('a cross-session restore keeps interruption reasons but cannot inherit active turn ownership', async ($, on) => {
  const old = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
  const { ledger, store } = setup(on, [])
  store.held.set(`s:${old}`, { v: 1, savedAt: 1, ledger: { ...EMPTY, steps: [
    step('plan:1', { status: 'in_progress', activeTurnId: 't1' }),
    step('plan:2', { status: 'paused', note: 'interrupted' }),
  ] } })
  await call($, { tool: 'mcp__track__restore_tracker', from_session: old })
  await finish($)
  expect(ledger.value.steps.map(s => s.status)).toEqual(['in_progress', 'paused'])
  expect(ledger.value.steps.every(s => s.activeTurnId === undefined)).toBe(true)
  expect(ledger.value.steps[1]?.note).toBe('interrupted')
})
