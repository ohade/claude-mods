// FIXTURE: render descriptions. Requested by Ohad 2026-11-09: rows were too long to read
// ("it needs to be more bullet length"). A folded row is cut with an ellipsis, and an explicit
// control shows the whole text. Ohad later allowed a second line before the cut; the fold itself
// is covered in two-line-rows.test.tsx. This file keeps the region budget.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'
import { wrappedLines } from '../hooks/terminal-text'

const LONG = 'Ohad decision for Codex narrated step 11: may the full suite run four existing unchanged tests that give their own fixture children a temporary home'

test('the step region budgets two lines per folded row, so eight long steps all fit a pane their whole text would overflow', async ($, on) => {
  atomStore(on, 'ledger', { ...EMPTY, steps: Array.from({ length: 8 }, (_, i) => ({ id: `plan:${i + 1}`, source: 'plan', subject: `${i + 1} ${LONG}`, status: 'pending' })) })
  mock.clock(on)
  const ui = await $.ui.mount(pane('dock', 80, 30))
  const rows = await Promise.all(Array.from({ length: 8 }, (_, i) => ui.find({ key: `row-s-plan:${i + 1}` })))
  expect(rows.filter(row => row !== undefined)).toHaveLength(8)
  // Guard the fixture: each subject needs a third line, so whole-text rows would not fit.
  const text = await ui.find({ key: 's-text-plan:1' })
  expect(wrappedLines(`1 ${LONG}`, Number(text?.props.width))).toBeGreaterThan(2)
  await ui.unmount()
})
