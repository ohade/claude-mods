// TRACK-14 4a-fix refuter round 2, 2026-10-12: summary starvation was
// fixed only below 40 columns, and blank arrow seats hid fully fitting rows.
// FIXTURE: native descriptions and dispatch, not painted terminal pixels.
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
  [40, 12, 1], [40, 12, 3], [40, 12, 5],
  [50, 11, 1], [50, 11, 3], [50, 11, 5],
  [60, 10, 1], [60, 11, 3], [60, 11, 5],
]
for (const [width, height, count] of cases) test(`${width}x${height} with ${count} questions keeps every step reachable`, async ($, on) => {
  const clock = mock.clock(on)
  const steps = stepsOf(12)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps, questions: questionsOf(count) })
  atomStore(on, 'activity', IDLE)
  atomStore(on, 'scroll', { questions: null, steps: 0 })
  on('ui.scroll', () => ({}))
  const ui = await $.ui.mount(pane('dock', width, height))
  const seen = new Set<string>()
  for (let i = 0; i < steps.length; i++) {
    expect((await ui.find({ key: 'steps' }))?.props.height).toBeGreaterThanOrEqual(1)
    const rows = (await ui.findAll({ type: 'Box' })).filter(row => String(row.key ?? '').startsWith('row-s-'))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) seen.add(String(row.key))
    await $.ui.scroll({ component: 'Pane', requestId: 'track', offset: 0, by: 1, bodyRows: height, contentRows: height, origin: { kind: 'person' } } as never)
    await clock.advance(100)
    await ui.redraw()
  }
  expect([...seen].sort()).toEqual(steps.map(step => `row-s-${step.id}`).sort())
  expect(ledger.value.steps).toEqual(steps)
  expect(ledger.writes).toHaveLength(0)
})

test('60x14 with three steps draws all three without a blank arrow seat stealing a row', async ($, on) => {
  mock.clock(on)
  const steps = stepsOf(3)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps })
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', 60, 14))
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.filter(row => String(row.key ?? '').startsWith('row-s-')).map(row => row.key)).toEqual(['row-s-plan:2', 'row-s-plan:1', 'row-s-plan:3'])
  // Nothing in the region is cut off: it holds every task row and every heading drawn.
  const headings = boxes.filter(row => String(row.key ?? '').startsWith('step-group-')).length
  expect((await ui.find({ key: 'steps' }))?.props.height).toBeGreaterThanOrEqual(3 + headings)
  expect(String((await ui.find({ key: 'steps-hidden' }))?.text ?? '')).toBe('')
  expect(ledger.writes).toHaveLength(0)
})

test('empty short sections retain their empty ring marker instead of a zero-over-zero count', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', 17, 12))
  expect((await ui.find({ key: 'questions-ring' }))?.text).toBe('○ —')
  expect((await ui.find({ key: 'steps-ring' }))?.text).toBe('○ —')
})
