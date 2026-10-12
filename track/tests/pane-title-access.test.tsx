// TRACK-14 part 3: short rows must keep full text and real keyboard-capable controls.
// FIXTURE: native mod dispatch and presentation state, not terminal paint.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'
import type { On } from './kit'

const NOW = 1_800_000_000_000
const longTitle = (n: number) => `Inspect connection ${n} against the original folded bracket drawing before recording the complete alignment result and checking every marked edge`
const steps = Array.from({ length: 6 }, (_, index) => ({
  id: `plan:${index + 1}`, source: 'plan' as const, subject: longTitle(index + 1),
  status: index === 0 ? 'in_progress' as const : index === 1 ? 'paused' as const : 'pending' as const,
  ...(index < 3 && { startedAt: NOW - (index + 1) * 65_000 }),
  ...(index === 1 && { delegated: true as const }),
}))

const seed = async (on: On, withQuestions = false) => {
  const clock = mock.clock(on)
  await clock.set(NOW)
  const ledger = atomStore(on, 'ledger', {
    ...EMPTY, steps,
    questions: withQuestions ? [{ id: 1, head: longTitle(9), at: NOW, turnId: 't1', status: 'open' as const }] : [],
  })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  return ledger
}

for (const width of [60, 30]) test(`six long step titles occupy one line each at ${width} columns without changing the ledger`, async ($, on) => {
  const ledger = await seed(on)
  const before = JSON.stringify(ledger.value)
  const ui = await $.ui.mount(pane('dock', width, 30))
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.filter(row => String(row.key ?? '').startsWith('row-s-'))).toHaveLength(6)
  const titles = (await ui.findAll({ type: 'Text' })).filter(row => /^S\d+\. /.test(String(row.text ?? '')))
  expect(titles).toHaveLength(6)
  for (const title of titles) expect(title.props).toMatchObject({ wrap: 'truncate-end' })
  for (const step of steps) {
    const titleBox = boxes.find(row => row.key === `s-text-${step.id}`)
    expect(titleBox?.props).toMatchObject({ height: 1 })
  }
  expect(JSON.stringify(ledger.value)).toBe(before)
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})

test('every full step title can be opened and closed through a native Button without ledger writes', async ($, on) => {
  const ledger = await seed(on)
  const before = JSON.stringify(ledger.value)
  const ui = await $.ui.mount(pane('dock', 60, 30))
  const controls = (await ui.findAll({ type: 'Button' })).filter(row => String(row.key ?? '').startsWith('title-s-'))
  expect(controls).toHaveLength(6)
  for (const step of steps) {
    await ui.press({ key: `title-s-${step.id}` })
    const opened = await ui.findAll({ type: 'Text' })
    expect(opened.some(row => row.text === step.subject && (row.props as { wrap?: string }).wrap === 'wrap')).toBe(true)
    await ui.press({ key: `title-s-${step.id}` })
    expect((await ui.findAll({ type: 'Text' })).some(row => row.text === step.subject)).toBe(false)
  }
  expect(JSON.stringify(ledger.value)).toBe(before)
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})

test('a question title has its own full-text control without replacing Q and A navigation', async ($, on) => {
  const ledger = await seed(on, true)
  const before = JSON.stringify(ledger.value)
  const ui = await $.ui.mount(pane('dock', 60, 30))
  const controls = await ui.findAll({ type: 'Button' })
  expect(controls.some(row => row.key === 'title-q-1')).toBe(true)
  await ui.press({ key: 'title-q-1' })
  expect((await ui.findAll({ type: 'Text' })).some(row => row.text === longTitle(9))).toBe(true)
  expect(JSON.stringify(ledger.value)).toBe(before)
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})

for (const width of [60, 30]) test(`state, owner and clock slots align for all rows at ${width} columns`, async ($, on) => {
  await seed(on)
  const ui = await $.ui.mount(pane('dock', width, 30))
  const boxes = await ui.findAll({ type: 'Box' })
  const owners: number[] = []
  const clocks: number[] = []
  for (const step of steps) {
    expect(boxes.find(row => row.key === `s-status-${step.id}`)?.props).toMatchObject({ width: 2, flexShrink: 0 })
    const owner = boxes.find(row => row.key === `s-owner-${step.id}`)
    const clock = boxes.find(row => row.key === `s-time-slot-${step.id}`)
    expect(owner).toBeDefined()
    expect(clock).toBeDefined()
    owners.push((owner?.props as { width: number }).width)
    clocks.push((clock?.props as { width: number }).width)
    expect(owner?.props).toMatchObject({ flexShrink: 0 })
    expect(clock?.props).toMatchObject({ flexShrink: 0 })
  }
  expect(new Set(owners).size).toBe(1)
  expect(new Set(clocks).size).toBe(1)
  expect(owners[0]).toBeGreaterThanOrEqual(5)
  expect(clocks[0]).toBeGreaterThanOrEqual(5)
  const labels = (await ui.findAll({ type: 'Text' })).map(row => row.text)
  expect(labels).toContain('main')
  expect(labels).toContain('agent')
  await ui.unmount()
})

test('empty Questions shares one header line when six steps need the body', async ($, on) => {
  await seed(on)
  const ui = await $.ui.mount(pane('dock', 60, 30))
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.find(row => row.key === 'questions')?.props).toMatchObject({ height: 0 })
  expect(String(boxes.find(row => row.key === 'questions-header')?.text ?? '')).toContain('None yet.')
  expect(boxes.filter(row => String(row.key ?? '').startsWith('row-s-'))).toHaveLength(6)
  await ui.unmount()
})

test('empty Steps shares one header line when questions need the body', async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(NOW)
  atomStore(on, 'ledger', { ...EMPTY, questions: [{ id: 1, head: 'Review the marked edge', at: NOW, turnId: 't1', status: 'open' }] })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  const ui = await $.ui.mount(pane('dock', 60, 30))
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.find(row => row.key === 'steps')?.props).toMatchObject({ height: 0 })
  expect(String(boxes.find(row => row.key === 'steps-header')?.text ?? '')).toContain('None yet.')
  await ui.unmount()
})
