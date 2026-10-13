// TRACK-14, Ohad 2026-10-13 (screenshot after the line-count run): with nothing running and Q1
// deferred, the banner said only "Paused", though the session waited on his answer. And a step
// marked completed straight from pending showed no clock beside steps that showed "<1m".
// FIXTURE: native mod descriptions and dispatch, not terminal paint.
import { expect, mock, test } from 'claude-code/testing'
import type { Activity, Ledger, Step } from '../types'
import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'

const IDLE: Activity = { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] }
const step = (id: string, status: Step['status']): Step => ({ id, source: 'plan', subject: `Work ${id}`, status })
const question = (status: 'open' | 'deferred') => ({ id: 1, head: 'Output format?', at: 1, turnId: 't1', status, askedRequestId: 'q-1' })

for (const status of ['open', 'deferred'] as const) test(`an idle session with a ${status} question shows Waiting on you naming it`, async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, questions: [question(status)], steps: [step('plan:1', 'paused'), step('plan:2', 'pending')] })
  atomStore<Activity>(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', 80, 20))
  const rows = (await ui.findAll({ type: 'Box' })).filter(el => /^banner-/.test(String(el.key ?? '')))
  expect(rows.map(el => el.key)).toEqual(['banner-paused', 'banner-you'])
  const you = String(rows.find(el => el.key === 'banner-you')?.text ?? '')
  expect(you).toContain('Waiting on you')
  expect(you).toContain('Q1')
  await ui.unmount()
})

test('an idle session with only an open question shows Waiting on you, not Paused', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, questions: [question('open')], steps: [step('plan:1', 'completed')] })
  atomStore<Activity>(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', 80, 20))
  const rows = (await ui.findAll({ type: 'Box' })).filter(el => /^banner-/.test(String(el.key ?? '')))
  expect(rows.map(el => el.key)).toEqual(['banner-you'])
  await ui.unmount()
})

test('while the session works, an open question does not add Waiting on you', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, questions: [question('open')], steps: [{ ...step('plan:1', 'in_progress'), startedAt: 0 }] })
  atomStore<Activity>(on, 'activity', { ...IDLE, isWorking: true })
  const ui = await $.ui.mount(pane('dock', 80, 20))
  const rows = (await ui.findAll({ type: 'Box' })).filter(el => /^banner-/.test(String(el.key ?? '')))
  expect(rows.map(el => el.key)).toEqual(['banner-working'])
  await ui.unmount()
})

test('a step completed straight from pending shows <1m like its neighbours', async ($, on) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps: [step('plan:1', 'pending')] })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  atomStore<Activity>(on, 'activity', { ...IDLE, isWorking: true })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  await $.tool.call({ tool: 'mcp__track__mark_step', id: 'plan:1', status: 'completed', tool_use_id: 'toolu_s' } as never)
  const done = ledger.value.steps[0]
  expect(done?.status).toBe('completed')
  expect(done?.startedAt).toBeDefined()
  expect(done?.endedAt).toBe(done?.startedAt)
  const ui = await $.ui.mount(pane('dock', 80, 20))
  expect(String((await ui.find({ key: 's-clock-plan:1' }))?.text ?? '')).toBe('<1m')
  await ui.unmount()
})
