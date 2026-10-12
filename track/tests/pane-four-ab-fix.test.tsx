// TRACK-14 4ab refuter, 2026-10-13: footer wrapping displaced content;
// started clocks disabled borders; section labels could wrap off their action.
// FIXTURE: native descriptions and virtual time, not terminal paint.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] }
const states = ['waiting', 'in_progress', 'pending', 'paused', 'completed']
const stepsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `plan:${i + 1}`, source: 'plan', subject: `Task ${i + 1}`, status: states[i % states.length] }))
const questionsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, head: `Question ${i + 1}`, at: i + 1, turnId: 'fixture-turn', status: 'open', askedRequestId: `question-${i + 1}` }))

// Counts are proposed from 6d93866 source; the lead must run this same file on
// a 6d93866 archive before accepting them as an observed baseline.
const floors = [[80, 15, 3, 6, 3], [60, 10, 1, 3, 3], [80, 10, 1, 3, 3], [60, 9, 2, 0, 2], [80, 9, 2, 0, 2]]
for (const [width, height, q, s, floor] of floors) test(`${width}x${height} q${q}/s${s} retains the baseline ${floor} content rows`, async ($, on) => {
  mock.clock(on)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, questions: questionsOf(q), steps: stepsOf(s) })
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', width, height))
  const prefix = s > 0 ? 'row-s-' : 'row-q-'
  const rows = (await ui.findAll({ type: 'Box' })).filter(el => String(el.key ?? '').startsWith(prefix))
  console.log('TRACK14_FOOTER_FLOOR ' + JSON.stringify({ width, height, questions: q, steps: s, actual: rows.length, expected: floor }))
  expect(rows.length).toBeGreaterThanOrEqual(floor)
  if (q > 0) expect((await ui.findAll({ type: 'Box' })).filter(el => String(el.key ?? '').startsWith('row-q-')).length).toBeGreaterThanOrEqual(1)
  expect(ledger.writes).toHaveLength(0)
})

for (const width of [17, 30, 60, 80]) test(`footer words share a wrapping item with their first Button at ${width} columns`, async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, questions: questionsOf(1), steps: stepsOf(3) })
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', width, 30))
  for (const [key, word, button] of [['footer-questions-first', 'footer-question-word', 'clear-questions'], ['footer-steps-first', 'footer-step-word', 'clear-steps']]) {
    const group = await ui.find({ key })
    expect(group).toBeDefined()
    expect(group?.props).toMatchObject({ flexDirection: 'row', flexShrink: 0 })
    const children = group?.children as Array<{ props?: { key?: string }; children?: Array<{ props?: { key?: string } }> }>
    expect(children.some(el => el.props?.key === word)).toBe(true)
    expect(children.some(el => el.props?.key === button || el.children?.some(child => child.props?.key === button))).toBe(true)
  }
})

const START = 1_800_000_000_000
for (const [before, after, framedAfter] of [[3_599_000, 3_600_000, true], [359_999_000, 360_000_000, false]] as const) test(`clock ${before}ms to ${after}ms has a stable seven-cell frame policy`, async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(START + before)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: [{ id: 'plan:1', source: 'plan', subject: 'Measured work', status: 'in_progress', startedAt: START }] })
  atomStore(on, 'activity', { ...IDLE, isWorking: true })
  const ui = await $.ui.mount(pane('dock', 80, 30))
  const frame = async () => (await ui.find({ key: 'steps-frame' }))?.props.borderStyle === 'round'
  expect(await frame()).toBe(true)
  expect((await ui.find({ key: 's-time-slot-plan:1' }))?.props.width).toBe(7)
  await clock.advance(after - before)
  await ui.redraw()
  expect(await frame()).toBe(framedAfter)
  expect((await ui.findAll({ type: 'Text' })).map(el => el.text)).toContain(after === 3_600_000 ? '1h 00m' : '100h 00m')
  for (let i = 0; i < 3; i++) {
    await clock.advance(60_000)
    await ui.redraw()
    expect(await frame()).toBe(framedAfter)
  }
  expect(ledger.writes).toHaveLength(0)
})

test('heading visibility is monotone except where the whole list fits only without headings', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, steps: stepsOf(3) })
  atomStore(on, 'activity', IDLE)
  const samples: Array<{ height: number; headings: boolean; tasks: number; wholeOnly: boolean }> = []
  for (let height = 8; height <= 24; height++) {
    const ui = await $.ui.mount(pane('dock', 40, height))
    const boxes = await ui.findAll({ type: 'Box' })
    const rows = Number(boxes.find(el => el.key === 'steps')?.props.height ?? 0)
    const bareRows = 3 * (1 + Number(boxes.some(el => String(el.key ?? '').startsWith('s-metadata-'))))
    const wholeOnly = rows >= bareRows && rows < bareRows + 3
    const sample = { height, headings: boxes.some(el => String(el.key ?? '').startsWith('step-group-')), tasks: boxes.filter(el => String(el.key ?? '').startsWith('row-s-')).length, wholeOnly }
    if (wholeOnly) {
      expect(sample.headings).toBe(false)
      expect(sample.tasks).toBe(3)
    }
    samples.push(sample)
    await ui.unmount()
  }
  console.log('TRACK14_HEADING_BAND ' + JSON.stringify(samples))
  const outsideBand = samples.filter(sample => !sample.wholeOnly)
  const first = outsideBand.findIndex(sample => sample.headings)
  expect(first).toBeGreaterThanOrEqual(0)
  expect(outsideBand.slice(first).every(sample => sample.headings)).toBe(true)
})
