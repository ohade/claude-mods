// FIXTURE: render descriptions. Ohad 2026-11-10: "If you must must must use 3 rows, do it in 3
// rows, I don't want the plus". A step or question shows its whole text on up to three lines;
// only text needing a fourth line is cut, with an ellipsis. No row draws an expand control, and
// no row gives up width to one (Codex's 2fff299 finding: a shared control column cut short titles).
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'
import { wrappedLines } from '../hooks/terminal-text'

const THREE = 'Prismantis fork: failing test for an answer reply that holds a code block'
const QTHREE = 'Should the explainer keep the suite run for the four unchanged tests?'
const HUGE = 'Ohad decision for Codex narrated step 11: may the full suite run four existing unchanged tests that give their own fixture children a temporary home, and keep their names and their order in the list'
const NEIGHBOUR = 'Review task output before merging the pane layout update'

type Drawn = { findAll: (query: { type: 'Text' }) => Promise<{ text?: string }[]> }
const shown = async (ui: Drawn, start: string) => (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').find(t => t.startsWith(start))
const controls = async (ui: { findAll: (query: object) => Promise<{ key?: string }[]> }) =>
  (await ui.findAll({})).map(el => el.key ?? '').filter(key => /^x-[sq]-|^s-fold|^q-fold/.test(key))

test('a step and a question that need three lines show whole, with no expand control', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 2,
    questions: [{ id: 1, head: QTHREE, at: 1, turnId: 'turn', status: 'open' }],
    steps: [{ id: 'plan:1', source: 'plan', subject: THREE, status: 'pending' }] })
  // A question row gives most of a 41-column pane to its controls, so it is checked at 60.
  let ui = await $.ui.mount(pane('dock', 41, 40))
  const step = await ui.find({ key: 's-text-plan:1' })
  expect(await shown(ui, 'Prismantis fork')).toBe(THREE)
  expect(await controls(ui)).toEqual([])
  // Guard the fixture: the text really needs a third line at the drawn width.
  expect(wrappedLines(THREE, Number(step?.props.width))).toBe(3)
  await ui.unmount()
  ui = await $.ui.mount(pane('dock', 60, 40))
  const question = await ui.find({ key: 'q-text-1' })
  expect(await shown(ui, 'Should the explainer')).toBe(QTHREE)
  expect(await controls(ui)).toEqual([])
  expect(wrappedLines(QTHREE, Number(question?.props.width))).toBe(3)
  await ui.unmount()
})

test('text needing a fourth line is cut at three lines with an ellipsis and no control', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, steps: [{ id: 'plan:1', source: 'plan', subject: HUGE, status: 'pending' }] })
  const ui = await $.ui.mount(pane('dock', 41, 40))
  const step = await ui.find({ key: 's-text-plan:1' })
  const text = await shown(ui, 'Ohad decision')
  expect(wrappedLines(HUGE, Number(step?.props.width))).toBeGreaterThan(3)
  expect(text?.endsWith('…')).toBe(true)
  expect(wrappedLines(text ?? '', Number(step?.props.width))).toBe(3)
  expect(await controls(ui)).toEqual([])
  await ui.unmount()
})

test('a short title beside a long one keeps its full width and shows whole', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, steps: [
    { id: 'plan:1', source: 'plan', subject: HUGE, status: 'pending' },
    { id: 'plan:2', source: 'plan', subject: NEIGHBOUR, status: 'pending' },
  ] })
  const ui = await $.ui.mount(pane('dock', 41, 40))
  expect(await shown(ui, 'Review task output')).toBe(NEIGHBOUR)
  const long = await ui.find({ key: 's-text-plan:1' })
  const short = await ui.find({ key: 's-text-plan:2' })
  expect(Number(short?.props.width)).toBe(Number(long?.props.width))
  expect(wrappedLines(NEIGHBOUR, Number(short?.props.width))).toBeLessThanOrEqual(2)
  await ui.unmount()
})
