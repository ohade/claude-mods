// FIXTURE: TRACK-46 A5. "clear completed" hides a finished step. When the same
// step is started again, it is active work: it must come back into view with a
// running clock, its old result must go, and the saved rows must agree.
// A completed step marked completed again stays hidden.
import { expect, mock, test } from 'claude-code/testing'
import type { Ledger, Step } from '../types'
import { EMPTY, SESSION, atomStore, blobPool, pluginStore } from './kit'
import type { Engine, On } from './kit'

const hidden = (id: string, extra: Partial<Step> = {}): Step => ({
  id, source: 'plan', subject: id, status: 'completed', cleared: true, startedAt: 1, endedAt: 2,
  resultText: 'old result', resultTextHash: 'old-hash', resultAt: 2, ...extra,
})
const setup = (on: On, steps: Step[]) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [] })
  const store = pluginStore(on)
  const pool = blobPool(on)
  on('session.id', () => ({ value: SESSION }))
  return { ledger, store, pool }
}
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never)

const expectActive = (row: Step | undefined, label: string) => {
  expect(row?.status, label).toBe('in_progress')
  expect(row?.cleared, `${label}: the reopened step is visible`).toBeUndefined()
  expect(row?.startedAt !== undefined && row?.endedAt === undefined, `${label}: its clock runs`).toBe(true)
  expect(row?.resultText, `${label}: the old result is gone`).toBeUndefined()
}

test('A5 mark_step reopening a hidden completed step makes it visible, also in the saved rows', async ($, on) => {
  const { ledger, store, pool } = setup(on, [hidden('plan:1')])
  await call($, { tool: 'mcp__track__mark_step', id: 'plan:1', status: 'in_progress' })
  expectActive(ledger.value.steps[0], 'mark_step')
  const saved = await pool.logical(store, `s:${SESSION}`) as { ledger: Ledger } | undefined
  expect(saved?.ledger.steps[0]?.cleared, 'the saved row is visible after a reload').toBeUndefined()
})

test('A5 TaskUpdate reopening a hidden completed task makes it visible', async ($, on) => {
  const { ledger } = setup(on, [hidden('task:7', { source: 'task', taskId: '7' })])
  on('tool.call', { tool: 'TaskUpdate' }, () => ({ result: { success: true, taskId: '7', updatedFields: ['status'] } }))
  await call($, { tool: 'TaskUpdate', taskId: '7', status: 'in_progress' })
  expectActive(ledger.value.steps[0], 'TaskUpdate')
})

test('A5 TodoWrite reopening a hidden completed todo makes it visible', async ($, on) => {
  const { ledger } = setup(on, [hidden('todo:current work', { source: 'todo', subject: 'Current work' })])
  const newTodos = [{ content: 'Current work', status: 'in_progress', activeForm: 'Working' }]
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos } }))
  await call($, { tool: 'TodoWrite', todos: newTodos })
  expectActive(ledger.value.steps.find(s => s.id === 'todo:current work'), 'TodoWrite')
})

test('A5 control: a hidden completed step marked completed again stays hidden', async ($, on) => {
  const { ledger } = setup(on, [hidden('plan:1')])
  await call($, { tool: 'mcp__track__mark_step', id: 'plan:1', status: 'completed' })
  expect(ledger.value.steps[0]?.status).toBe('completed')
  expect(ledger.value.steps[0]?.cleared).toBe(true)
})
