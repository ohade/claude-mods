// FIXTURE: TRACK-53. The pane shows steps as pending while the model works, because only
// mark_step moves a row. A tool result must carry one in-turn reminder when this turn updated
// a step, steps are still pending, and none is in_progress. The Stop and next-prompt nudges
// in step-freshness.test.tsx are separate and arrive too late for this case.
import { mock, test, expect } from 'claude-code/testing'
import type { ToolCallResult } from 'claude-code'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Activity, Ledger, Step, Turn } from '../types'

const REMINDER = 'track: steps are pending and none is in_progress. Mark the step this work belongs to with mark_step.'
const step = (extra: Partial<Step> = {}): Step => ({ id: 'plan:1', source: 'plan', subject: 'Finish the change', status: 'pending', ...extra })
const invoke = ($: Engine, tool: string, input: object = {}) => $.tool.call({ tool, tool_use_id: `${tool}-${Math.random()}`, ...input } as never)
const mark = ($: Engine, status: Step['status'], id = 'plan:1') => invoke($, 'mcp__track__mark_step', { id, status })
const contextOf = async ($: Engine, command: string) => ((await invoke($, 'Bash', { command })) as { context?: readonly string[] }).context

const prepare = async ($: Engine, on: On, steps: Step[]) => {
  mock.clock(on)
  atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps })
  atomStore<Turn>(on, 'turn', { currentId: null, gatedTurnId: null, eventOrder: 0 })
  atomStore<Activity>(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [], owners: {} })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on)
  const env = new Map<string, string>([['CLAUDE_PLUGIN_ROOT', '/fixture/track'], ['CLAUDE_CONFIG_DIR', '/fixture/config']])
  const work = { value: { result: 'fixture success' } as ToolCallResult }
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, e, next) => next(e))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', { tool: /^(Edit|Write|MultiEdit|NotebookEdit|Bash)$/ }, () => work.value)
  on('env.get', (_, e) => ({ value: env.get(e.name) }))
  on('env.set', (_, e) => { env.set(e.name, String(e.value)); return { value: {} } })
  await $.turn.start({ text: 'Continue the agreed work', turnId: 't1' } as never)
}

test('work after a step update with steps pending and none in_progress carries one reminder per turn', async ($, on) => {
  await prepare($, on, [step({ status: 'in_progress' }), step({ id: 'plan:2', subject: 'Second change' })])
  await mark($, 'completed')
  expect(await contextOf($, 'git status')).toEqual([REMINDER])
  expect(await contextOf($, 'git diff')).toBeUndefined()
})

test('no reminder while a step is in_progress', async ($, on) => {
  await prepare($, on, [step({ status: 'in_progress' }), step({ id: 'plan:2', subject: 'Second change' })])
  await mark($, 'in_progress', 'plan:1')
  expect(await contextOf($, 'git status')).toBeUndefined()
})

test('no reminder in a turn that updated no step', async ($, on) => {
  await prepare($, on, [step()])
  expect(await contextOf($, 'git status')).toBeUndefined()
})
