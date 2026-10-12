// TRACK-14 4a follow-up, lead 2026-10-13: a list that scrolled anyway kept its
// headings even when they hid tasks (refuter on 6d93866: 310 twelve-step cases
// below min(3, n) where c98f8f8 met it; 143 three-step cases with metadata below
// showing 1 task where c98f8f8 showed 2). Headings must keep at least as many
// tasks as min(3, n) or as the list shows without them, whichever is smaller.
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

// [width, height, questions, steps, tasks c98f8f8 shows on first draw]
const cases = [[60, 10, 0, 12, 3], [80, 9, 0, 12, 3], [64, 11, 3, 12, 3], [40, 12, 0, 3, 2]]
for (const [width, height, count, n, base] of cases) test(`${width}x${height}, ${count} questions, ${n} steps shows at least ${base} tasks on first draw`, async ($, on) => {
  mock.clock(on)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: stepsOf(n), questions: questionsOf(count) })
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', width, height))
  const rows = (await ui.findAll({ type: 'Box' })).filter(row => String(row.key ?? '').startsWith('row-s-'))
  expect(rows.length).toBeGreaterThanOrEqual(base)
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})

test('growing a 40-column pane never turns headings back off once they show', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, steps: stepsOf(3) })
  atomStore(on, 'activity', IDLE)
  const shown: boolean[] = []
  for (let height = 8; height <= 24; height++) {
    const ui = await $.ui.mount(pane('dock', 40, height))
    shown.push((await ui.findAll({ type: 'Box' })).some(row => String(row.key ?? '').startsWith('step-group-')))
    await ui.unmount()
  }
  const first = shown.indexOf(true)
  expect(first).toBeGreaterThanOrEqual(0)
  expect(shown.slice(first).every(Boolean)).toBe(true)
})
