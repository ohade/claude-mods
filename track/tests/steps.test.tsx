import { expect, mock, test } from 'claude-code/testing'

import { EMPTY, atomStore, pluginStore } from './kit'
import type { Engine } from './kit'

// Steps from the model's tools: parallel calls, failed Task updates, restored steps, todo ids.

type StepRow = { id: string; source: string; subject: string; status: string; taskId?: string }
type Held = { steps: StepRow[] }

const OLD_SESSION = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'

const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never)

const plan = (n: number, status = 'pending'): StepRow => ({ id: `plan:${n}`, source: 'plan', subject: `step ${n}`, status })

// Both calls read the register before either writes: each must still get ids of its own.
test('two track_steps calls in flight at once insert steps with distinct ids', async ($, on) => {
  const ledger = atomStore<Held>(on, 'ledger', { ...EMPTY, steps: [plan(1)] }, { holdReads: 2 })
  atomStore(on, 'scroll', { questions: null, steps: null })

  await Promise.all([
    call($, { tool: 'mcp__track__track_steps', steps: ['first insert'], after: 'plan:1' }),
    call($, { tool: 'mcp__track__track_steps', steps: ['second insert'], after: 'plan:1' }),
  ])

  const ids = ledger.value.steps.map(s => s.id)
  expect(ids).toHaveLength(3)
  expect(new Set(ids).size).toBe(3)
})

test('of two restore_steps calls in flight at once, the second refuses to overwrite the first', async ($, on) => {
  const ledger = atomStore<Held>(on, 'ledger', EMPTY as Held, { holdReads: 2 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on, { [`s:${OLD_SESSION}`]: { v: 1, savedAt: 1, ledger: { ...EMPTY, steps: [plan(1), plan(2)] } } })

  const results = await Promise.all([
    call($, { tool: 'mcp__track__restore_steps', from_session: OLD_SESSION }),
    call($, { tool: 'mcp__track__restore_steps', from_session: OLD_SESSION }),
  ])

  expect(results.filter(r => JSON.stringify(r).includes('already has'))).toHaveLength(1)
  expect(ledger.value.steps.map(s => s.id)).toEqual(['plan:1', 'plan:2'])
})

test('a TaskUpdate that did not succeed leaves its step as it was', async ($, on) => {
  const ledger = atomStore<Held>(on, 'ledger', { ...EMPTY, steps: [{ id: 'task:7', source: 'task', subject: 'write it', status: 'pending', taskId: '7' }] })
  on('tool.call', { tool: 'TaskUpdate' }, () => ({ result: { success: false, taskId: '7', updatedFields: [], error: 'Task not found' } }))

  await call($, { tool: 'TaskUpdate', taskId: '7', status: 'completed' })

  expect(ledger.value.steps[0]?.status).toBe('pending')
})

// Task ids start again at 1 in every session: a restored step must not answer to the new
// session's Task of the same id, nor share an id with it.
test('restored steps keep no Task link, so a new Task with the same id leaves them alone', async ($, on) => {
  const old = [
    { id: 'task:3', source: 'task', subject: 'old task', status: 'in_progress', taskId: '3' },
    { id: 'plan:1', source: 'plan', subject: 'old plan step', status: 'pending', taskId: '4' },
  ]
  const ledger = atomStore<Held>(on, 'ledger', EMPTY as Held)
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on, { [`s:${OLD_SESSION}`]: { v: 1, savedAt: 1, ledger: { ...EMPTY, steps: old } } })
  on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '3', subject: 'new task' } } }))
  on('tool.call', { tool: 'TaskUpdate' }, (_, e) => ({ result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }))

  await call($, { tool: 'mcp__track__restore_steps', from_session: OLD_SESSION })
  await call($, { tool: 'TaskCreate', subject: 'new task', description: 'x' })
  await call($, { tool: 'TaskUpdate', taskId: '3', status: 'completed' })
  await call($, { tool: 'TaskUpdate', taskId: '4', status: 'completed' })

  const restored = ledger.value.steps.filter(s => s.subject.startsWith('old'))
  expect(restored.map(s => s.status)).toEqual(['in_progress', 'pending'])
  expect(restored.every(s => s.taskId === undefined)).toBe(true)
  const ids = ledger.value.steps.map(s => s.id)
  expect(new Set(ids).size).toBe(ids.length)
})

test('two todos with the same normalized title get distinct ids', async ($, on) => {
  // A status change stamps the step's clock, so the test stands in the engine's clock.
  mock.clock(on)
  const ledger = atomStore<Held>(on, 'ledger', EMPTY as Held)
  const newTodos = [
    { content: 'Fix the bug', status: 'pending', activeForm: 'Fixing' },
    { content: 'fix the bug!', status: 'in_progress', activeForm: 'Fixing' },
  ]
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos } }))

  await call($, { tool: 'TodoWrite', todos: newTodos })

  const ids = ledger.value.steps.map(s => s.id)
  expect(ids).toHaveLength(2)
  expect(new Set(ids).size).toBe(2)
})
