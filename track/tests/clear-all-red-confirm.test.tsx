import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Step } from '../types'

// WO plan:16b (Ohad, 2026-10-28 ~07:50Z, live check of plan:16): "it should stay and be red and
// ask me to confirm on that frame, not disappear." While "clear all" is armed, both copies of the
// steps' control read as a red confirmation for as long as the arm lasts (10 s), with no toast;
// at expiry the pane draws the normal label again without any key press.

type Found = { key?: string; text: string; props: Record<string, unknown> }
type Drawn = { press: (q: { key: string }) => Promise<void>; find: (q: { key?: string; type?: string; text?: string | RegExp }) => Promise<Found | undefined>; findAll: (q: { key?: string; type?: string; text?: string | RegExp }) => Promise<Found[]> }

const step = (id: string, subject: string, status: Step['status'] = 'pending'): Step => ({ id, source: 'plan', subject, status })
const MIXED = [step('plan:1', 'Open one'), step('plan:2', 'Open two', 'in_progress'), step('plan:3', 'Done three', 'completed')]
const DONE = [step('plan:1', 'Done one', 'completed'), step('plan:2', 'Done two', 'completed')]
const COPIES = ['clear-steps', 'clear-steps-bottom']

const prepare = async ($: Engine, on: On, steps: Step[]) => {
  const clock = mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, session_id: SESSION, steps })
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on)
  const toasts: string[] = []
  on('session.id', () => ({ value: SESSION }))
  on('session.messages', () => ({ value: [] }))
  on('ui.toast', (_, e) => { toasts.push(String(e.text)); return { value: undefined } })
  const ui = (await $.ui.mount(pane('dock'))) as unknown as Drawn
  return { clock, ledger, toasts, ui }
}

const ids = (l: { value: Ledger }) => l.value.steps.map(s => s.id)
// The red confirmation texts drawn now, one per copy of the control.
const redConfirms = async (ui: Drawn) => (await ui.findAll({ type: 'Text', text: /confirm/ })).filter(el => el.props.color === 'error')
const controlTexts = async (ui: Drawn) => Promise.all(COPIES.map(async key => (await ui.find({ key }))?.text ?? `missing ${key}`))

test('(a) after the first press both copies of the control ask to confirm, in red', async ($, on) => {
  const { ui } = await prepare($, on, MIXED)
  await ui.press({ key: 'clear-steps' })

  const texts = await controlTexts(ui)
  for (const text of texts) expect(text).toMatch(/confirm/)
  expect(texts.join(' ')).toMatch(/2 unfinished steps/)
  expect(await redConfirms(ui)).toHaveLength(2)
})

test('(b) arming shows no toast', async ($, on) => {
  const { ui, ledger, toasts } = await prepare($, on, MIXED)
  await ui.press({ key: 'clear-steps' })

  expect(ids(ledger)).toEqual(['plan:1', 'plan:2', 'plan:3'])
  expect(toasts).toEqual([])
})

test('(c) a press 9 seconds after arming clears', async ($, on) => {
  const { ui, ledger, clock } = await prepare($, on, MIXED)
  await ui.press({ key: 'clear-steps' })
  expect(ids(ledger)).toEqual(['plan:1', 'plan:2', 'plan:3'])
  await clock.advance(9000)
  await ui.press({ key: 'clear-steps' })

  expect(ids(ledger)).toEqual([])
})

test('(d) a press 10.001 seconds after arming arms again and shows the red confirmation', async ($, on) => {
  const { ui, ledger, clock } = await prepare($, on, MIXED)
  await ui.press({ key: 'clear-steps' })
  await clock.advance(10001)
  await ui.press({ key: 'clear-steps' })

  expect(ids(ledger)).toEqual(['plan:1', 'plan:2', 'plan:3'])
  expect(await redConfirms(ui)).toHaveLength(2)
})

test('(e) when the arm expires the pane draws the normal label again, with no key press', async ($, on) => {
  const { ui, clock } = await prepare($, on, MIXED)
  await ui.press({ key: 'clear-steps' })
  expect(await redConfirms(ui)).toHaveLength(2)
  await clock.advance(10001)

  expect(await redConfirms(ui)).toEqual([])
  for (const text of await controlTexts(ui)) {
    expect(text).toMatch(/clear all/)
    expect(text).not.toMatch(/confirm/)
  }
})

test('(f) control: with no unfinished step one press clears and no confirmation is drawn', async ($, on) => {
  const { ui, ledger } = await prepare($, on, DONE)
  expect(await redConfirms(ui)).toEqual([])
  await ui.press({ key: 'clear-steps' })

  expect(ids(ledger)).toEqual([])
  expect(await redConfirms(ui)).toEqual([])
})
