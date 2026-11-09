// FIXTURE: render descriptions. Ohad 2026-11-09, looking at the live pane: "it's a mess". An
// opened saved result started under [ R ] instead of under the row text; it now starts where the
// row text starts. (The fold control this file also covered was removed on 2026-11-10.)
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pane } from './kit'

const START = 1_800_000_000_000
const RESULT = 'Number labels bold, color merged (purple), same for every status, and the suite stays green.'
const done = (id: string, subject: string, extra: Record<string, unknown> = {}) =>
  ({ id, source: 'plan', subject, status: 'completed', startedAt: START, endedAt: START + 120_000, ...extra })

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
