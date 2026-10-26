import { expect, mock, test } from 'claude-code/testing'

import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine, On } from './kit'

// Track unit "track_steps after: last" (joint ruling 2026-10-26T22:22Z): the sentinel "last" for
// `after` is resolved inside the atomic ledger update, to the last stored PLAN row in ledger order,
// whatever its status or cleared flag. With no plan row the creation path runs. Task and todo rows,
// and every retained row, stay unchanged.

type StepRow = { id: string; source: string; subject: string; status: string; cleared?: true }
type Held = { steps: StepRow[] }

const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never)

const plan = (n: number, status = 'pending', extra: Partial<StepRow> = {}): StepRow => ({ id: `plan:${n}`, source: 'plan', subject: `step ${n}`, status, ...extra })
const task = { id: 'task:7', source: 'task', subject: 'native task', status: 'in_progress', session_id: SESSION }
const todo = { id: 'todo:ship it', source: 'todo', subject: 'Ship it', status: 'pending', session_id: SESSION }

const prepare = (on: On, steps: StepRow[]) => {
  mock.clock(on)
  const ledger = atomStore<Held>(on, 'ledger', { ...EMPTY, steps })
  atomStore(on, 'scroll', { questions: null, steps: null })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/fixture/config' })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  return ledger
}

const rows = (ledger: { value: Held }) => ledger.value.steps.map(s => [s.id, s.subject, s.status, s.cleared === true])

test('T1 after "last" inserts after a completed, cleared plan row and keeps that row', async ($, on) => {
  const ledger = prepare(on, [plan(1, 'completed', { cleared: true })])
  const result = await call($, { tool: 'mcp__track__track_steps', steps: ['New work'], after: 'last' })
  expect(String(result.result)).toMatch(/^Inserted after /)
  expect(rows(ledger)).toEqual([
    ['plan:1', 'step 1', 'completed', true],
    ['plan:2', 'New work', 'pending', false],
  ])
})

test('T2 after "last" lands after the last PLAN row and leaves task and todo rows untouched', async ($, on) => {
  const ledger = prepare(on, [plan(1, 'completed'), task, plan(2, 'in_progress'), todo])
  const result = await call($, { tool: 'mcp__track__track_steps', steps: ['New work'], after: 'last' })
  expect(String(result.result)).toMatch(/^Inserted after /)
  expect(ledger.value.steps).toEqual([
    expect.objectContaining(plan(1, 'completed')),
    task,
    expect.objectContaining(plan(2, 'in_progress')),
    expect.objectContaining({ id: 'plan:3', source: 'plan', subject: 'New work', status: 'pending' }),
    todo,
  ])
  expect(ledger.value.steps[1]).toEqual(task)
  expect(ledger.value.steps[4]).toEqual(todo)
})

test('T3 after "last" with no plan row takes the creation path and keeps the task rows', async ($, on) => {
  const ledger = prepare(on, [task, todo])
  const result = await call($, { tool: 'mcp__track__track_steps', steps: ['First', 'Second'], after: 'last' })
  expect(String(result.result)).toMatch(/^Tracking 2 steps/)
  expect(ledger.value.steps).toEqual([
    task,
    todo,
    expect.objectContaining({ id: 'plan:1', source: 'plan', subject: 'First', status: 'pending' }),
    expect.objectContaining({ id: 'plan:2', source: 'plan', subject: 'Second', status: 'pending' }),
  ])
})

// "last" must give exactly what naming the last plan id gives.
for (const after of ['last', 'plan:2']) {
  test(`T4 with open visible rows, after "${after}" inserts after plan:2`, async ($, on) => {
    const ledger = prepare(on, [plan(1, 'completed'), plan(2, 'in_progress')])
    const result = await call($, { tool: 'mcp__track__track_steps', steps: ['New work'], after })
    expect(String(result.result)).toMatch(/^Inserted after /)
    expect(rows(ledger)).toEqual([
      ['plan:1', 'step 1', 'completed', false],
      ['plan:2', 'step 2', 'in_progress', false],
      ['plan:3', 'New work', 'pending', false],
    ])
  })
}

test('T4 with a task row trailing the plan, the anchor is the last PLAN row, not the task row', async ($, on) => {
  const ledger = prepare(on, [plan(1, 'pending'), plan(2, 'in_progress'), task])
  const result = await call($, { tool: 'mcp__track__track_steps', steps: ['New work'], after: 'last' })
  expect(String(result.result)).toMatch(/^Inserted after /)
  const ids = ledger.value.steps.map(s => s.id)
  expect(ids).toEqual(['plan:1', 'plan:2', 'plan:3', 'task:7'])
  // Anchoring on the last visible row would put the new step after the task row instead.
  expect(ids).not.toEqual(['plan:1', 'plan:2', 'task:7', 'plan:3'])
})

// Another writer adds a completed plan row after the caller's first view and before its write.
// The compare-and-set misses, the update retries, and "last" must resolve against the retried value.
test('T5 after "last" resolves inside the atomic update, after a plan row another writer added', async ($, on) => {
  let ledger: ReturnType<typeof atomStore<Held>>
  let inserted = false
  on('state.set', { plugin: 'track', key: ['ledger'] }, async (_, e, next) => {
    if (!inserted && (e.value as Held).steps.some(row => row.subject === 'New work')) {
      inserted = true
      ledger.value = { ...ledger.value, steps: [...ledger.value.steps, plan(2, 'completed', { subject: 'other writer' })] }
      ledger.version += 1
    }
    return next(e)
  })
  ledger = prepare(on, [plan(1, 'in_progress'), task])
  const result = await call($, { tool: 'mcp__track__track_steps', steps: ['New work'], after: 'last' })
  expect(String(result.result)).toMatch(/^Inserted after /)
  expect(inserted).toBe(true)
  expect(rows(ledger)).toEqual([
    ['plan:1', 'step 1', 'in_progress', false],
    ['task:7', 'native task', 'in_progress', false],
    ['plan:2', 'other writer', 'completed', false],
    ['plan:3', 'New work', 'pending', false],
  ])
})
