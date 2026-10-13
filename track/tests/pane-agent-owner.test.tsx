// TRACK-14, Ohad 2026-10-13: a step whose subagent is running showed "main" and a plain dot,
// because only an explicit delegated:true marked it. A running agent launched during the step
// now marks it on screen: owner "agent" and the amber hourglass. Display only; the ledger keeps
// the flag the session set.
// FIXTURE: native mod descriptions and dispatch, not terminal paint.
import { expect, mock, test } from 'claude-code/testing'
import type { Activity, Ledger, Step } from '../types'
import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'
import type { Engine } from './kit'

const step = (id: string, extra: Partial<Step> = {}): Step => ({ id, source: 'plan', subject: `Work ${id}`, status: 'pending', ...extra })
const BASE: Activity = { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] }
const STEPS = [step('plan:1', { status: 'in_progress', activeTurnId: 't1' }), step('plan:2', { status: 'pending' })]

const drawn = async ($: Engine, on: Parameters<Parameters<typeof test>[1]>[1], act: Activity) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, steps: STEPS })
  atomStore<Activity>(on, 'activity', act)
  const ui = await $.ui.mount(pane('dock', 80, 20))
  const owner = String((await ui.find({ key: 's-owner-plan:1' }))?.text ?? '')
  const glyph = String((await ui.find({ key: 's-status-plan:1' }))?.text ?? '')
  const other = String((await ui.find({ key: 's-owner-plan:2' }))?.text ?? '')
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
  return { owner, glyph, other }
}

test('an Agent call in flight that started during the step shows the step as agent work', async ($, on) => {
  const row = await drawn($, on, { ...BASE, agentCalls: ['toolu_ag'], owners: { toolu_ag: ['plan:1'] }, ownerOrder: ['toolu_ag'] })
  expect(row.owner).toBe('agent')
  expect(row.glyph).toContain('⧗')
  expect(row.other).toBe('main')
})

test('a running background agent launched during the step shows the step as agent work', async ($, on) => {
  const row = await drawn($, on, { ...BASE, background: ['ag1'], owners: { ag1: ['plan:1'] }, ownerOrder: ['ag1'] })
  expect(row.owner).toBe('agent')
  expect(row.glyph).toContain('⧗')
})

test('a finished agent or a shell task does not make the step agent work', async ($, on) => {
  const row = await drawn($, on, { ...BASE, tasks: ['sh1'], owners: { ag1: ['plan:1'], sh1: ['plan:1'] }, ownerOrder: ['ag1', 'sh1'] })
  expect(row.owner).toBe('main')
  expect(row.glyph).not.toContain('⧗')
})

test('a foreground Agent call records its step while it runs and forgets it after', async ($, on) => {
  mock.clock(on)
  atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps: STEPS })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  const activity = atomStore<Activity>(on, 'activity', BASE)
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  let during: Activity['owners']
  on('tool.call', { tool: 'Agent' }, () => {
    during = activity.value.owners
    return { result: { status: 'completed', content: [] } } as never
  })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_fg', prompt: 'count' } as never)
  expect(during).toEqual({ toolu_fg: ['plan:1'] })
  expect(activity.value.owners?.toolu_fg).toBeUndefined()
  expect(activity.value.agentCalls).toEqual([])
})
