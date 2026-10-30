import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Step } from '../types'

// WO plan:30 / plan:16c (Ohad, 2026-10-29 18:49Z, "diagnose then clear all"): a ledger write that
// leaves 0 unfinished steps ends the "clear all" arm, whether or not the pane renders. P1 and P2
// change steps only through the plugin's tools after arming; P3 pins the stamp guard on the
// render-scheduled callback (refuter r3-c1).

type Found = { key?: string; text: string; props: Record<string, unknown> }
type Drawn = { press: (q: { key: string }) => Promise<void>; redraw: () => Promise<void>; find: (q: { key?: string; type?: string; text?: string | RegExp }) => Promise<Found | undefined>; findAll: (q: { key?: string; type?: string; text?: string | RegExp }) => Promise<Found[]>; unmount: () => Promise<void> }

const step = (id: string, subject: string, status: Step['status'] = 'pending'): Step => ({ id, source: 'plan', subject, status })
const MIXED = [step('plan:1', 'Open one'), step('plan:2', 'Open two', 'in_progress'), step('plan:3', 'Done three', 'completed')]
const ALLDONE = MIXED.map(s => ({ ...s, status: 'completed' as const }))
const NEW = [step('plan:4', 'New open four'), step('plan:5', 'New open five', 'in_progress')]
// track_steps with after "last" inserts after plan:3 and numbers from the highest plan id.
const ALL_IDS = ['plan:1', 'plan:2', 'plan:3', 'plan:4', 'plan:5']

const prepare = async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, session_id: SESSION, steps: MIXED })
  const arm = atomStore<number | null>(on, 'clearArm' as never, null)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.messages', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  const ui = (await $.ui.mount(pane('dock', 60))) as unknown as Drawn
  return { clock, ledger, arm, ui }
}

const ids = (l: { value: Ledger }) => l.value.steps.map(s => s.id)
const unfinished = (l: { value: Ledger }) => l.value.steps.filter(s => s.status !== 'completed').map(s => s.id)
// The red confirmation texts drawn now, one per copy of the control.
const redConfirms = async (ui: Drawn) => (await ui.findAll({ type: 'Text', text: /confirm/ })).filter(el => el.props.color === 'error')
// Completes every unfinished seeded step through mark_step; returns any deny.
const completeAll = async ($: Engine) => {
  const markedOne = await $.tool.call({ tool: 'mcp__track__mark_step', id: 'plan:1', status: 'completed', tool_use_id: 'toolu_m1' } as never)
  const markedTwo = await $.tool.call({ tool: 'mcp__track__mark_step', id: 'plan:2', status: 'completed', tool_use_id: 'toolu_m2' } as never)
  return [markedOne.deny, markedTwo.deny].filter(deny => deny !== undefined)
}
// Adds two open steps after the last plan row through track_steps; returns any refusal.
const addTwo = async ($: Engine) => {
  const added = await $.tool.call({ tool: 'mcp__track__track_steps', steps: ['New open four', 'New open five'], after: 'last', tool_use_id: 'toolu_t' } as never)
  return [added.deny].filter(deny => deny !== undefined)
}

test('P1 completing the last open step ends the arm with no render in between (r3-b1 through tools)', async ($, on) => {
  const { ui, ledger, clock } = await prepare($, on)
  await ui.press({ key: 'clear-steps' })
  // A press that writes only hook-answered atoms does not redraw the pane; a render at 2 unfinished schedules nothing.
  await ui.redraw()
  const armedShown = (await redConfirms(ui)).length
  // The pane is hidden, so no render sees 0 unfinished.
  await ui.unmount()
  const denies = await completeAll($)
  await clock.advance(2000)
  denies.push(...await addTwo($))
  const added = { ids: ids(ledger), unfinished: unfinished(ledger) }
  const shownAgain = (await $.ui.mount(pane('dock', 60))) as unknown as Drawn
  await shownAgain.redraw()
  const shown = (await redConfirms(shownAgain)).length
  await shownAgain.press({ key: 'clear-steps' })
  expect({ armedShown, denies, added, shown, ids: ids(ledger) }).toEqual({ armedShown: 2, denies: [], added: { ids: ALL_IDS, unfinished: ['plan:4', 'plan:5'] }, shown: 0, ids: ALL_IDS })
})

test('P2 a press handled before the scheduled callback runs (r3-b2 through tools)', async ($, on) => {
  const { ui, ledger } = await prepare($, on)
  await ui.press({ key: 'clear-steps' })
  // A press that writes only hook-answered atoms does not redraw the pane; a render at 2 unfinished schedules nothing.
  await ui.redraw()
  const armedShown = (await redConfirms(ui)).length
  const denies = await completeAll($)
  // A render at 0 unfinished schedules the after(0) callback; the clock stays put, so it has not run.
  await ui.redraw()
  denies.push(...await addTwo($))
  const added = { ids: ids(ledger), unfinished: unfinished(ledger) }
  await ui.redraw()
  const shown = (await redConfirms(ui)).length
  await ui.press({ key: 'clear-steps' })
  expect({ armedShown, denies, added, shown, ids: ids(ledger) }).toEqual({ armedShown: 2, denies: [], added: { ids: ALL_IDS, unfinished: ['plan:4', 'plan:5'] }, shown: 0, ids: ALL_IDS })
})

test('P3 the scheduled callback does not end a newer arm (a one-press clear, then a fresh arm)', async ($, on) => {
  const { ui, ledger, clock, arm } = await prepare($, on)
  await ui.press({ key: 'clear-steps' })
  const first = arm.value
  await clock.advance(1000)
  ledger.value = { ...ledger.value, steps: ALLDONE }
  await ui.redraw()
  await ui.press({ key: 'clear-steps' })
  const idsAfterZeroPress = ids(ledger)
  ledger.value = { ...ledger.value, steps: NEW }
  await ui.redraw()
  await ui.press({ key: 'clear-steps' })
  const second = arm.value
  await clock.settle()
  await ui.redraw()
  const shown = (await redConfirms(ui)).length
  const kept = arm.value
  await ui.press({ key: 'clear-steps' })
  expect({ idsAfterZeroPress, newer: second !== null && second !== first, kept: kept === second, shown, ids: ids(ledger) }).toEqual({ idsAfterZeroPress: [], newer: true, kept: true, shown: 2, ids: [] })
})
