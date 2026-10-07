import { expect, mock, test } from 'claude-code/testing'

import { EMPTY, atomStore, pane } from './kit'
import type { Engine, On } from './kit'

// Each step row ends in a wall clock: running while the step is under way, and once it is done,
// how long it took. Under an hour it reads m:ss and moves every second; past an hour it reads
// 1h 05m and moves once a minute.

type StepRow = { id: string; status: string; startedAt?: number; endedAt?: number }
type Held = { steps: StepRow[] }

const T0 = 1_800_000_000_000
const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [] }

const plan = (n: number, status: string, times: { startedAt?: number; endedAt?: number } = {}) => ({
  id: `plan:${n}`,
  source: 'plan',
  subject: `step ${n}`,
  status,
  ...times,
})

const texts = async (ui: { findAll: (q: { type: string }) => Promise<Array<{ text?: string }>> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? ''))

const mark = ($: Engine, id: string, status: string) => $.tool.call({ tool: 'mcp__track__mark_step', id, status } as never)

const drawAt = async ($: Engine, on: On, steps: unknown[], at: number) => {
  atomStore(on, 'ledger', { ...EMPTY, steps })
  atomStore(on, 'activity', IDLE)
  const tick = atomStore(on, 'tick', 0)
  const clock = mock.clock(on)
  await clock.set(at)
  const ui = await $.ui.mount(pane('dock', 60, 30))

  return { ui, clock, tick }
}

test('a step starts its clock when it goes in progress and stops it when done', async ($, on) => {
  const ledger = atomStore<Held>(on, 'ledger', { ...EMPTY, steps: [plan(1, 'pending')] } as Held)
  const clock = mock.clock(on)
  await clock.set(T0)

  await mark($, 'plan:1', 'in_progress')
  await clock.advance(125_000)
  await mark($, 'plan:1', 'completed')

  expect(ledger.value.steps[0]).toMatchObject({ status: 'completed', startedAt: T0, endedAt: T0 + 125_000 })
})

test('a done step shows how long it took', async ($, on) => {
  const { ui } = await drawAt($, on, [plan(1, 'completed', { startedAt: T0, endedAt: T0 + 125_000 })], T0 + 999_000)

  expect(await texts(ui)).toContain('2:05')
})

test('a running step shows its time so far, and the clock moves every second', async ($, on) => {
  const { ui, clock, tick } = await drawAt($, on, [plan(1, 'in_progress', { startedAt: T0 - 7_000 })], T0)

  expect(await texts(ui)).toContain('0:07')
  await clock.advance(3_000)
  expect(tick.writes.length).toBeGreaterThanOrEqual(3)
})

test('past an hour the clock reads hours and minutes and moves once a minute', async ($, on) => {
  const { ui, clock, tick } = await drawAt($, on, [plan(1, 'in_progress', { startedAt: T0 - 3_700_000 })], T0)

  expect(await texts(ui)).toContain('1h 01m')
  await clock.advance(59_000)
  expect(tick.writes.length).toBeLessThanOrEqual(1)
})

test('a todo keeps its clock when the list is written again', async ($, on) => {
  const ledger = atomStore<Held>(on, 'ledger', EMPTY as Held)
  const clock = mock.clock(on)
  await clock.set(T0)
  let todos = [{ content: 'Write the parser', status: 'in_progress', activeForm: 'Writing' }]
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: todos } }))

  await $.tool.call({ tool: 'TodoWrite', todos } as never)
  await clock.advance(42_000)
  todos = [{ content: 'Write the parser', status: 'completed', activeForm: 'Writing' }]
  await $.tool.call({ tool: 'TodoWrite', todos } as never)

  expect(ledger.value.steps[0]).toMatchObject({ status: 'completed', startedAt: T0, endedAt: T0 + 42_000 })
})

test('a pending step shows no clock', async ($, on) => {
  const { ui } = await drawAt($, on, [plan(1, 'pending')], T0)

  expect((await texts(ui)).some(t => /^\d+:\d\d$|^\d+h \d\dm$/.test(t))).toBe(false)
})
