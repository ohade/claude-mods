// FIXTURE: U3 must reset reuse eligibility and rebuild todo maps on a lost CAS.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Pending, Step } from '../types'

const REQUEST = 'Continue the existing work'
const active: Step = { id: 'plan:1', source: 'plan', sourceId: 'original-row', subject: 'Original work', status: 'in_progress', startedAt: 100, activeTurnId: 't1' }
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never)
const prepare = (on: On, rows: Step[], eligible: (proposal: Ledger) => boolean, competing: (current: Ledger) => Ledger) => {
  let ledger: ReturnType<typeof atomStore<Ledger>>
  const probe = { injected: false }
  on('state.set', { plugin: 'track', key: ['ledger'] }, async (_, event, next) => {
    if (!probe.injected && eligible(event.value as Ledger)) {
      probe.injected = true
      ledger.value = competing(ledger.value)
      ledger.version++
    }
    return next(event)
  })
  ledger = atomStore(on, 'ledger', { ...EMPTY, session_id: SESSION, steps: rows })
  const pending = atomStore<Pending>(on, 'pending', { inputs: [{ id: 1, head: REQUEST, excerpt: REQUEST, rowKey: '11111111-2222-4333-8444', textHash: 'a'.repeat(64), turnId: 't1' }], nextId: 2 })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 4 })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'scroll', { questions: null, steps: null })
  mock.clock(on)
  mock.env(on, { CLAUDE_CONFIG_DIR: '/fixture/config' })
  const store = pluginStore(on)
  const pool = blobPool(on)
  on('session.id', () => ({ value: SESSION }))
  on('ui.log', () => ({ value: undefined }))
  return { ledger, pending, probe, store, pool }
}

test('U3 losing mark_step retry cannot acknowledge through its old reusable row', async ($, on) => {
  const winner: Step = { id: 'plan:1', source: 'plan', sourceId: 'original-row', subject: 'Original work', status: 'completed', startedAt: 100, endedAt: 200 }
  const f = prepare(on, [active], proposal => proposal.steps[0]?.status === 'completed', current => ({ ...current, steps: [winner] }))
  const result = await call($, { tool: 'mcp__track__mark_step', tool_use_id: 'reuse-retry', id: 'plan:1', status: 'completed', source_text: REQUEST })
  expect(result.deny).toBeUndefined()
  expect(f.probe.injected).toBe(true)
  expect(f.pending.value.inputs[0]?.covered).toBeUndefined()
  const expected = { ...winner, session_id: SESSION }
  expect(f.ledger.value.steps).toEqual([expected])
  expect((await f.pool.logical(f.store, `s:${SESSION}`) as { ledger: Ledger }).ledger.steps).toEqual([expected])
})

test('U3 TodoWrite retry rebuilds current clocks and duplicate-title identities', async ($, on) => {
  const before: Step = { id: 'todo:fix', source: 'todo', subject: 'Fix!', status: 'pending' }
  const first: Step = { ...before, status: 'in_progress', startedAt: 25, activeTurnId: 'other', note: 'First writer clock' }
  const second: Step = { ...first, id: 'todo:fix#2', startedAt: 35, note: 'Second writer clock' }
  const f = prepare(on, [active, before], proposal => proposal.steps.some(row => row.id === 'todo:fix#2'), current => ({ ...current, steps: [active, first, second] }))
  const todos = [{ content: 'Fix!', status: 'in_progress' as const, activeForm: 'Fixing' }, { content: 'fix', status: 'in_progress' as const, activeForm: 'Fixing' }]
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: todos } }))
  const result = await call($, { tool: 'TodoWrite', tool_use_id: 'todo-retry', todos })
  expect(result.deny).toBeUndefined()
  expect(f.probe.injected).toBe(true)
  const expected = [active, { ...first, activeTurnId: 't1' }, { ...second, subject: 'fix', activeTurnId: 't1' }].map(row => ({ ...row, session_id: SESSION }))
  expect(f.ledger.value.steps).toEqual(expected)
  expect(new Set(f.ledger.value.steps.map(row => row.id)).size).toBe(3)
  expect((await f.pool.logical(f.store, `s:${SESSION}`) as { ledger: Ledger }).ledger.steps).toEqual(expected)
})
