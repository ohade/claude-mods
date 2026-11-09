// FIXTURE: render descriptions. Ohad 2026-11-09, looking at the live pane: "it's a mess". The
// fold control sat between the text and the clock, so "+ 37m" read as plus 37 minutes, and an
// opened saved result started under [ R ] instead of under the row text. Agreed fix: the clock
// comes first and the control after it, in a column every step row keeps while any step folds
// (so clocks stay aligned), and an opened result starts where the row text starts.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pane } from './kit'

const START = 1_800_000_000_000
const LONG = 'Prismantis fork: failing test for an answer reply whose segment holds a list, code, table or long code block, then the same test green after the fix, then a Codex review'
const RESULT = 'Number labels bold, color merged (purple), same for every status, and the suite stays green.'
const done = (id: string, subject: string, extra: Record<string, unknown> = {}) =>
  ({ id, source: 'plan', subject, status: 'completed', startedAt: START, endedAt: START + 120_000, ...extra })

test('the fold control follows the clock, and every step row keeps its column so clocks align', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, steps: [done('plan:1', LONG), done('plan:2', 'Short step')] })
  const ui = await $.ui.mount(pane('dock', 80, 30))
  const all = await ui.findAll({})
  const at = (key: string) => all.findIndex(el => el.key === key)
  expect(at('s-clock-plan:1')).toBeGreaterThan(-1)
  // Guard the fixture: the long subject needs a third line, so its row draws the control.
  expect(at('s-fold-plan:1')).toBeGreaterThan(-1)
  expect(at('s-fold-plan:1')).toBeGreaterThan(at('s-clock-plan:1'))
  const long = await ui.find({ key: 's-text-plan:1' })
  const short = await ui.find({ key: 's-text-plan:2' })
  // Same clock label, so equal text widths mean the two clocks end in the same column.
  expect(Number(short?.props.width)).toBe(Number(long?.props.width))
  await ui.unmount()
})

test('an opened saved result starts where the row text starts, not under [ R ]', async ($, on) => {
  mock.clock(on)
  const steps = [done('plan:1', 'Short step', { resultText: RESULT })]
  const ledger = { ...EMPTY, session_id: SESSION, steps }
  atomStore(on, 'ledger', ledger)
  atomStore(on, 'durability', { isUnsaved: false, reason: '', baseline: { session_id: SESSION, ledger }, memorySession: SESSION })
  atomStore(on, 'reveal', { 'step-result:plan:1': 'r' })
  const ui = await $.ui.mount(pane('dock', 80, 30))
  // Guard the fixture: the saved result is drawn.
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain(RESULT)
  const result = await ui.find({ key: 's-result-text-plan:1' })
  const text = await ui.find({ key: 's-text-plan:1' })
  // "[ R ]" takes six cells and the row gap one more.
  expect(Number(result?.props.marginLeft)).toBe(7)
  expect(Number(result?.props.width)).toBe(Number(text?.props.width) - 7)
  await ui.unmount()
})
