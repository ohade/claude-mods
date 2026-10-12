// TRACK-14 4a-fix, lead takeover 2026-10-13: state headings were drawn whenever the
// steps region had two rows, even when they pushed tasks out of view. Refuter
// sweep: 60x10 with three steps showed only S2 under ACTIVE, where c98f8f8
// showed all three. Headings must not cost tasks below min(3, steps).
// FIXTURE: native descriptions, not painted terminal pixels.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] }
const states = ['waiting', 'in_progress', 'pending', 'paused', 'completed']
const stepsOf = (count: number) => Array.from({ length: count }, (_, i) => ({
  id: `plan:${i + 1}`, source: 'plan', subject: `Task ${i + 1}`, status: states[i % states.length],
}))
const questionsOf = (count: number) => Array.from({ length: count }, (_, i) => ({
  id: i + 1, head: `Question ${i + 1}`, at: i + 1, turnId: 'fixture-turn', status: 'open', askedRequestId: `question-${i + 1}`,
}))

const cases = [
  [60, 10, 0], [80, 10, 0], [80, 9, 0],
  [62, 11, 3], [62, 11, 5], [64, 11, 3], [64, 11, 5],
]
for (const [width, height, count] of cases) test(`${width}x${height} with ${count} questions shows all three steps on first draw`, async ($, on) => {
  mock.clock(on)
  const steps = stepsOf(3)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps, questions: questionsOf(count) })
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', width, height))
  const rows = (await ui.findAll({ type: 'Box' })).filter(row => String(row.key ?? '').startsWith('row-s-'))
  expect(rows.map(row => String(row.key)).sort()).toEqual(['row-s-plan:1', 'row-s-plan:2', 'row-s-plan:3'])
  expect(String((await ui.find({ key: 'steps-hidden' }))?.text ?? '')).toBe('')
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})
