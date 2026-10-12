// TRACK-14 4c1: expansion must replace its preview and expose every source word.
// FIXTURE: native mod dispatch and descriptions, not terminal paint or physical keys.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'
import type { On } from './kit'
import { collectTitlePages, detailFragment, detailPosition } from './pane-detail-assertions'

const NOW = 1_800_000_000_000
const activity = { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] }
const title420 = () => {
  const end = ` final-${Math.random().toString(36).slice(2, 10)}`
  return Array.from({ length: 80 }, (_, i) => `edge${String(i).padStart(3, '0')}`).join(' ').slice(0, 420 - end.length) + end
}
const seedStep = async (on: On, subject: string) => {
  const clock = mock.clock(on)
  await clock.set(NOW)
  atomStore(on, 'activity', activity)
  return atomStore(on, 'ledger', { ...EMPTY, steps: [{ id: 'plan:1', source: 'plan', subject, status: 'in_progress', startedAt: NOW - 65_000 }] })
}

for (const width of [60, 30]) test(`an opened 420-character step reconstructs every word in place at ${width}x12`, async ($, on) => {
  const subject = title420()
  expect(subject.length).toBe(420)
  const ledger = await seedStep(on, subject)
  const before = JSON.stringify(ledger.value)
  const ui = await $.ui.mount(pane('dock', width, 12))
  const preview = String((await ui.find({ key: 's-text-plan:1' }))?.text ?? '')
  await ui.press({ key: 'title-s-plan:1' })
  expect((await ui.findAll({ type: 'Text' })).some(text => text.text === preview)).toBe(false)
  const first = await ui.find({ key: 's-first-line-plan:1' })
  expect(first?.props).toMatchObject({ height: 1, flexDirection: 'row' })
  expect(String(first?.text ?? '')).toContain('S1. ')
  expect(String(first?.text ?? '')).toContain('main')
  expect(String(first?.text ?? '')).toContain('1m')
  expect(Number((await ui.find({ key: 'detail-s-plan:1' }))?.props.width)).toBeGreaterThan(Number((await ui.find({ key: 's-text-plan:1' }))?.props.width))
  const fragments = await collectTitlePages(ui, 's', 'plan:1', 'S1', subject)
  expect(fragments.length).toBeGreaterThan(1)
  expect(fragments.at(-1)?.endsWith(subject.slice(-10))).toBe(true)
  expect(JSON.stringify(ledger.value)).toBe(before)
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})

test('Prev, Next and Close keep page boundaries stable and reopening starts at the first word', async ($, on) => {
  const subject = title420()
  const ledger = await seedStep(on, subject)
  const ui = await $.ui.mount(pane('dock', 30, 12))
  const preview = String((await ui.find({ key: 's-text-plan:1' }))?.text ?? '')
  await ui.press({ key: 'title-s-plan:1' })
  const first = await detailFragment(ui, 's', 'plan:1', 'S1')
  expect((await detailPosition(ui, 's', 'plan:1')).page).toBe(1)
  const geometry = async () => ({ q: (await ui.find({ key: 'questions' }))?.props.height, s: (await ui.find({ key: 'steps' }))?.props.height, footer: (await ui.find({ key: 'bottom-bar' }))?.props.height, banner: (await ui.find({ key: 'banner' }))?.props.height })
  const before = await geometry()
  await ui.press({ key: 'detail-prev-s-plan:1' })
  expect((await detailPosition(ui, 's', 'plan:1')).page).toBe(1)
  expect(await detailFragment(ui, 's', 'plan:1', 'S1')).toBe(first)
  await ui.press({ key: 'detail-next-s-plan:1' })
  expect((await detailPosition(ui, 's', 'plan:1')).page).toBe(2)
  const second = await detailFragment(ui, 's', 'plan:1', 'S1')
  await ui.press({ key: 'detail-prev-s-plan:1' })
  expect(await detailFragment(ui, 's', 'plan:1', 'S1')).toBe(first)
  await ui.press({ key: 'detail-next-s-plan:1' })
  expect(await detailFragment(ui, 's', 'plan:1', 'S1')).toBe(second)
  expect(await geometry()).toEqual(before)
  await ui.press({ key: 'detail-close-s-plan:1' })
  expect(String((await ui.find({ key: 's-text-plan:1' }))?.text ?? '')).toBe(preview)
  expect(await ui.find({ key: 'detail-page-s-plan:1' })).toBeUndefined()
  await ui.press({ key: 'title-s-plan:1' })
  expect((await detailPosition(ui, 's', 'plan:1')).page).toBe(1)
  expect(await detailFragment(ui, 's', 'plan:1', 'S1')).toBe(first)
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})

test('resizing keeps the source character anchor rather than the old page number', async ($, on) => {
  const subject = title420()
  const ledger = await seedStep(on, subject)
  let ui = await $.ui.mount(pane('dock', 60, 12))
  await ui.press({ key: 'title-s-plan:1' })
  const first = await detailFragment(ui, 's', 'plan:1', 'S1')
  expect((await detailPosition(ui, 's', 'plan:1')).total).toBeGreaterThan(1)
  await ui.press({ key: 'detail-next-s-plan:1' })
  const anchor = first.length
  const oldPosition = await detailPosition(ui, 's', 'plan:1')
  await ui.unmount()
  ui = await $.ui.mount(pane('dock', 30, 12))
  const visible = await detailFragment(ui, 's', 'plan:1', 'S1')
  const start = subject.indexOf(visible)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(start).toBeLessThanOrEqual(anchor)
  expect(start + visible.length).toBeGreaterThan(anchor)
  expect((await detailPosition(ui, 's', 'plan:1')).total).toBeGreaterThan(oldPosition.total)
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})

test('Unicode pages preserve whole graphemes and the exact original source', async ($, on) => {
  const subject = '👩🏽‍🔧 é שלום 漢字 family👨‍👩‍👧‍👦 alignment '.repeat(15).trim()
  const ledger = await seedStep(on, subject)
  const ui = await $.ui.mount(pane('dock', 30, 12))
  await ui.press({ key: 'title-s-plan:1' })
  const fragments = await collectTitlePages(ui, 's', 'plan:1', 'S1', subject)
  const boundaries = new Set([0, subject.length, ...Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(subject), part => part.index)])
  let offset = 0
  for (const fragment of fragments) {
    offset += fragment.length
    expect(boundaries.has(offset)).toBe(true)
  }
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})

test('question paging preserves separate Q and A navigation and never writes the ledger', async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(NOW)
  const head = title420()
  const ledger = atomStore(on, 'ledger', { ...EMPTY, questions: [{ id: 7, head, at: NOW, turnId: 't1', status: 'answered', askedRequestId: 'question-7', answerKey: 'answer-7', answerText: 'Confirmed' }] })
  atomStore(on, 'activity', activity)
  const ui = await $.ui.mount(pane('dock', 30, 12))
  const jumps = (await ui.findAll({ type: 'Button' })).filter(button => button.key === 'q-7' || button.key === 'a-7')
  expect(jumps).toHaveLength(2)
  await ui.press({ key: 'title-q-7' })
  for (const jump of jumps) {
    const current = (await ui.find({ key: jump.key }))?.props
    expect([current?.label, current?.hotkey]).toEqual([jump.props.label, jump.props.hotkey])
  }
  await collectTitlePages(ui, 'q', 7, 'Q1', head)
  expect(ledger.value.questions[0].head).toBe(head)
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})

test('a tiny pane temporarily uses its body for detail while retaining the footer and banner', async ($, on) => {
  const subject = title420()
  const ledger = await seedStep(on, subject)
  const ui = await $.ui.mount(pane('dock', 30, 8))
  await ui.press({ key: 'title-s-plan:1' })
  expect(await ui.find({ key: 'detail-pane' })).toBeDefined()
  expect(await ui.find({ key: 'bottom-bar' })).toBeDefined()
  expect(await ui.find({ key: 'banner' })).toBeDefined()
  await collectTitlePages(ui, 's', 'plan:1', 'S1', subject)
  await ui.press({ key: 'detail-close-s-plan:1' })
  expect(await ui.find({ key: 'detail-pane' })).toBeUndefined()
  expect(await ui.find({ key: 'questions-header' })).toBeDefined()
  expect(await ui.find({ key: 'steps-header' })).toBeDefined()
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})
