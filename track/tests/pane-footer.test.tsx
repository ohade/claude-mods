// TRACK-14 4b, 2026-10-12: duplicated clears occupy headers and footer.
// FIXTURE: native descriptions/dispatch; no claim about terminal focus or paint.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] }
const keys = ['clear-questions', 'clear-answered', 'clear-steps', 'clear-completed']
const hotkeys = ['q', 'a', 's', 'c']
const steps = [
  { id: 'plan:1', source: 'plan', subject: 'First', status: 'pending' },
  { id: 'plan:2', source: 'plan', subject: 'Second', status: 'in_progress' },
  { id: 'plan:3', source: 'plan', subject: 'Third', status: 'waiting' },
]
const questions = [{ id: 1, head: 'Question', at: 1, turnId: 't', status: 'open', askedRequestId: 'question-1' }]

for (const width of [17, 30, 60, 80]) test(`one footer owns all canonical controls at ${width} columns`, async ($, on) => {
  mock.clock(on)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, questions, steps })
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', width, 30))
  const all = await ui.findAll({})
  const footer = all.findIndex(el => el.key === 'bottom-bar')
  const banner = all.findIndex(el => el.key === 'banner')
  const controls = all.filter(el => el.type === 'Button' && String(el.key ?? '').startsWith('clear-'))
  expect(controls.map(el => el.key)).toEqual(keys)
  expect(controls.map(el => el.props.hotkey)).toEqual(hotkeys)
  expect(controls.every(el => all.indexOf(el) > footer && all.indexOf(el) < banner)).toBe(true)
  expect(all.filter(el => String(el.key ?? '').startsWith('row-')).every(el => all.indexOf(el) < footer)).toBe(true)
  expect(controls.map(el => el.props.label)).toEqual(width < 40 ? ['all', 'done', 'all', 'done'] : ['clear all', 'clear completed', 'clear all', 'clear completed'])
  expect(controls.every(el => String(el.props.label).length + 3 <= width)).toBe(true)
  expect((await ui.find({ key: 'footer-question-word' }))?.text).toBe(width < 40 ? 'Q' : 'Questions')
  expect((await ui.find({ key: 'footer-step-word' }))?.text).toBe(width < 40 ? 'S' : 'Steps')
  for (const step of steps) {
    const title = all.findIndex(el => el.key === `title-s-${step.id}`)
    expect(title).toBeGreaterThan(all.findIndex(el => el.key === `row-s-${step.id}`))
    expect(title).toBeLessThan(footer)
  }
  expect(ledger.writes).toHaveLength(0)
})

test('scroll and resize keep one footer outside both list regions', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, questions, steps: Array.from({ length: 50 }, (_, i) => ({ ...steps[i % 3], id: `plan:${i + 1}` })) })
  atomStore(on, 'activity', IDLE)
  const position = atomStore(on, 'scroll', { questions: null, steps: 0 })
  const ui = await $.ui.mount(pane('dock', 60, 20))
  const height = Number((await ui.find({ key: 'steps' }))?.props.height)
  position.value = { questions: null, steps: 12 }
  await ui.redraw()
  expect(Number((await ui.find({ key: 'steps' }))?.props.height)).toBe(height)
  expect((await ui.findAll({ type: 'Button' })).filter(el => String(el.key ?? '').startsWith('clear-')).map(el => el.key)).toEqual(keys)
  await ui.unmount()
  const narrow = await $.ui.mount(pane('dock', 17, 20))
  expect((await narrow.findAll({ type: 'Button' })).filter(el => String(el.key ?? '').startsWith('clear-')).map(el => el.key)).toEqual(keys)
})

for (const [width, height] of [[17, 12], [30, 12], [60, 10], [60, 14]]) test(`borders spend no task rows in the short ${width}x${height} pane`, async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, steps })
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', width, height))
  const boxes = await ui.findAll({ type: 'Box' })
  // Conservative compact treatment: no border chrome at these short sizes.
  expect(boxes.filter(el => ['questions-frame', 'steps-frame'].includes(String(el.key)) && el.props.borderStyle === 'round')).toHaveLength(0)
  const taskRows = boxes.filter(el => String(el.key ?? '').startsWith('row-s-'))
  expect(taskRows.length).toBeGreaterThan(0)
  if (width === 60) expect(taskRows.map(el => el.key)).toEqual(['row-s-plan:2', 'row-s-plan:3', 'row-s-plan:1'])
})

test('tall fitting sections use quiet round borders', async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(1_800_000_000_000)
  atomStore(on, 'ledger', { ...EMPTY, questions, steps: steps.map(s => s.status === 'in_progress' ? { ...s, startedAt: 1_799_999_940_000 } : s) })
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', 80, 30))
  for (const key of ['questions-frame', 'steps-frame']) {
    expect((await ui.find({ key }))?.props).toMatchObject({ borderStyle: 'round', borderDimColor: true })
  }
  expect((await ui.findAll({ type: 'Box' })).filter(el => String(el.key ?? '').startsWith('row-s-'))).toHaveLength(3)
})
