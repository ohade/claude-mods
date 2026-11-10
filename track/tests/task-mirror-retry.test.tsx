// FIXTURE: TaskCreate and TaskUpdate with a competing writer. Real hooks and engine, state in memory.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { On } from './kit'
import type { Ledger, Step } from '../types'

const existing: Step = { id: 'task:7', source: 'task', subject: 'Write the parser', status: 'pending', taskId: '7' }
const competitor: Step = { id: 'task:9', source: 'task', subject: 'Added by another writer', status: 'pending', taskId: '9' }

// The first write loses its compare-and-set: a competing writer adds `competitor` just before it lands.
const prepare = (on: On, rows: Step[]) => {
  let ledger: ReturnType<typeof atomStore<Ledger>>
  let injected = false
  on('state.set', { plugin: 'track', key: ['ledger'] }, async (_, event, next) => {
    if (!injected) {
      injected = true
      ledger.value = { ...ledger.value, steps: [...ledger.value.steps, competitor] }
      ledger.version++
    }
    return next(event)
  })
  ledger = atomStore(on, 'ledger', { ...EMPTY, session_id: SESSION, steps: rows })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 4 })
  mock.clock(on)
  pluginStore(on)

  return ledger
}

test('a TaskCreate that loses its write adds its step to the current ledger and keeps the competing one', async ($, on) => {
  const ledger = prepare(on, [])
  on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '7', subject: 'Write the parser' } } }))
  await $.tool.call({ tool: 'TaskCreate', subject: 'Write the parser', description: 'x', tool_use_id: 'toolu_create' })
  expect(ledger.value.steps.map(row => row.id)).toEqual(['task:9', 'task:7'])
})

test('a TaskUpdate that loses its write updates its step in the current ledger and keeps the competing one', async ($, on) => {
  const ledger = prepare(on, [existing])
  on('tool.call', { tool: 'TaskUpdate' }, (_, e) => ({ result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }))
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'completed', tool_use_id: 'toolu_update' })
  expect(ledger.value.steps.map(row => `${row.id}:${row.status}`)).toEqual(['task:7:completed', 'task:9:pending'])
})
