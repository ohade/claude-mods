import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Step } from '../types'

// WO plan:16b (Ohad, 2026-10-28 ~07:50Z, live check of plan:16): "it should stay and be red and
// ask me to confirm on that frame, not disappear." While "clear all" is armed, both copies of the
// steps' control read as a red confirmation for as long as the arm lasts (10 s), with no toast;
// at expiry the pane draws the normal label again without any key press.

type Found = { key?: string; text: string; props: Record<string, unknown> }
type Drawn = { press: (q: { key: string }) => Promise<void>; redraw: () => Promise<void>; find: (q: { key?: string; type?: string; text?: string | RegExp }) => Promise<Found | undefined>; findAll: (q: { key?: string; type?: string; text?: string | RegExp }) => Promise<Found[]> }

// Reopens a step when clearSteps first reads the arm: after a press began, before its ledger write.
type Trap = { on: boolean; fire: (l: { value: Ledger }) => void }

const step = (id: string, subject: string, status: Step['status'] = 'pending'): Step => ({ id, source: 'plan', subject, status })
const MIXED = [step('plan:1', 'Open one'), step('plan:2', 'Open two', 'in_progress'), step('plan:3', 'Done three', 'completed')]
const DONE = [step('plan:1', 'Done one', 'completed'), step('plan:2', 'Done two', 'completed')]
const COPIES = ['clear-steps', 'clear-steps-bottom']

const prepare = async ($: Engine, on: On, steps: Step[], trap?: Trap, columns = 60) => {
  const clock = mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, session_id: SESSION, steps })
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  if (trap !== undefined) {
    let value: number | null = null
    let version = 1
    on('state.get', { plugin: 'track', key: ['clearArm'] }, () => {
      if (trap.on) { trap.on = false; trap.fire(ledger) }
      return { value: { value, version } }
    })
    on('state.set', { plugin: 'track', key: ['clearArm'] }, (_, e) => {
      if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
      value = e.value as number | null
      version += 1
      return { value: { isSet: true, version } }
    })
  }
  pluginStore(on)
  const toasts: string[] = []
  on('session.id', () => ({ value: SESSION }))
  on('session.messages', () => ({ value: [] }))
  on('ui.toast', (_, e) => { toasts.push(String(e.text)); return { value: undefined } })
  const ui = (await $.ui.mount(pane('dock', columns))) as unknown as Drawn
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

// Refuter r1 (plan:16b): the three probes from plan16b/refuter/probe.template.tsx, as pins.
test('(g) an older arm\'s expiry timer does not end a newer arm', async ($, on) => {
  const { ui, ledger, clock } = await prepare($, on, MIXED)
  await ui.press({ key: 'clear-steps' })
  await clock.advance(1000)
  await ui.press({ key: 'clear-steps' })
  expect(ids(ledger)).toEqual([])
  ledger.value = { ...ledger.value, steps: MIXED }
  await ui.redraw()
  await clock.advance(1000)
  await ui.press({ key: 'clear-steps' })
  expect(ids(ledger)).toEqual(['plan:1', 'plan:2', 'plan:3'])
  await clock.advance(8500)

  expect(await redConfirms(ui)).toHaveLength(2)
  await ui.press({ key: 'clear-steps' })
  expect(ids(ledger)).toEqual([])
})

test('(h) the confirmation leaves once no unfinished step is left', async ($, on) => {
  const { ui, ledger } = await prepare($, on, MIXED)
  await ui.press({ key: 'clear-steps' })
  expect(await redConfirms(ui)).toHaveLength(2)
  ledger.value = { ...ledger.value, steps: MIXED.map(s => ({ ...s, status: 'completed' as const })) }
  await ui.redraw()

  expect(await redConfirms(ui)).toEqual([])
  for (const text of await controlTexts(ui)) expect(text).not.toMatch(/confirm/)
})

test('(i) a step reopened before the write is not cleared by one press', async ($, on) => {
  const trap: Trap = { on: false, fire: l => { l.value = { ...l.value, steps: [step('plan:1', 'Done one', 'in_progress'), step('plan:2', 'Done two', 'completed')] } } }
  const { ui, ledger } = await prepare($, on, DONE, trap)
  trap.on = true
  await ui.press({ key: 'clear-steps' })

  expect(trap.on).toBe(false)
  expect(ids(ledger)).toEqual(['plan:1', 'plan:2'])
})

// Refuter r2 (plan:16b): probe-resurrect, probe-compact and probe-dim from plan16b/refuter-r2/, as pins.
test('(j) the arm ends when no unfinished step is left; new unfinished steps need a fresh arm', async ($, on) => {
  const { ui, ledger, clock } = await prepare($, on, MIXED)
  await ui.press({ key: 'clear-steps' })
  expect(await redConfirms(ui)).toHaveLength(2)
  ledger.value = { ...ledger.value, steps: MIXED.map(s => ({ ...s, status: 'completed' as const })) }
  await ui.redraw()
  expect(await redConfirms(ui)).toEqual([])
  await clock.advance(2000)
  ledger.value = { ...ledger.value, steps: [step('plan:4', 'New open four'), step('plan:5', 'New open five', 'in_progress')] }
  await ui.redraw()
  const shown = await redConfirms(ui)
  await ui.press({ key: 'clear-steps' })

  expect({ redAfterReappear: shown.length, idsAfterOnePress: ids(ledger) }).toEqual({ redAfterReappear: 0, idsAfterOnePress: ['plan:4', 'plan:5'] })
})

test('(k) a compact pane also asks to confirm, in red, on both copies', async ($, on) => {
  const { ui, ledger } = await prepare($, on, MIXED, undefined, 36)
  for (const text of await controlTexts(ui)) expect(text).toMatch(/all/)
  await ui.press({ key: 'clear-steps' })

  expect(ids(ledger)).toEqual(['plan:1', 'plan:2', 'plan:3'])
  for (const text of await controlTexts(ui)) expect(text).toMatch(/confirm/)
  expect(await redConfirms(ui)).toHaveLength(2)
})

test('(l) the armed control is not drawn dim; the unarmed one is', async ($, on) => {
  const { ui } = await prepare($, on, MIXED)
  for (const key of COPIES) expect((await ui.find({ key }))?.props.dimColor).toBe(true)
  await ui.press({ key: 'clear-steps' })

  for (const key of COPIES) expect((await ui.find({ key }))?.props.dimColor).toBe(false)
})
