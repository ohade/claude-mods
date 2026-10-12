// TRACK-14 4a-fix, 2026-10-12: short regions vanished, detail clipping ignored
// headings, and arrow refits moved the footer while scrolling.
// FIXTURE: native descriptions/dispatch, not terminal pixels or physical keys.
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

// Header items are whole Boxes. Measure their real Text/Button descriptions
// to place a wheel event inside Steps, instead of assuming an old fixed row.
type Element = { type?: string; children?: Array<Element | string>; props?: Record<string, any> }
const itemWidth = (el: Element | string): number => {
  if (typeof el === 'string') return el.length
  if (el.type === 'Button') return String(el.props?.label ?? '').length + (el.props?.hotkey === undefined ? 0 : 3)
  const widths = (el.children ?? []).map(itemWidth)
  return el.type === 'Text' ? widths.reduce((sum, width) => sum + width, 0) : Math.max(0, ...widths)
}
const headerRows = (header: Element, width: number): number => {
  let rows = 1
  let used = 0
  for (const child of header.children ?? []) {
    const columns = itemWidth(child)
    if (used > 0 && used + 2 + columns > width) { rows++; used = columns }
    else used += (used === 0 ? 0 : 2) + columns
  }
  return rows
}

for (const width of [17, 30]) for (const questionCount of [0, 5]) for (const input of ['keyboard', 'wheel']) {
  test(`${width}x12 with ${questionCount} questions keeps every step reachable by ${input}`, async ($, on) => {
    const clock = mock.clock(on)
    const steps = stepsOf(12)
    const ledger = atomStore(on, 'ledger', { ...EMPTY, steps, questions: questionsOf(questionCount) })
    atomStore(on, 'activity', IDLE)
    atomStore(on, 'scroll', { questions: null, steps: 0 })
    on('ui.scroll', () => ({}))
    const ui = await $.ui.mount(pane('dock', width, 12))
    const seen = new Set<string>()
    for (let i = 0; i < steps.length; i++) {
      expect((await ui.find({ key: 'steps' }))?.props.height).toBeGreaterThanOrEqual(1)
      const shown = (await ui.findAll({ type: 'Box' })).filter(row => String(row.key ?? '').startsWith('row-s-'))
      expect(shown.length).toBeGreaterThan(0)
      for (const row of shown) {
        seen.add(String(row.key))
        const id = String(row.key).slice('row-s-'.length)
        expect((await ui.find({ key: `s-text-${id}` }))?.props.height).toBe(1)
      }
      const summary = await ui.find({ key: 'state-summary' })
      const header = await ui.find({ key: 'questions-header' })
      const qRegion = await ui.find({ key: 'questions' })
      const stepTop = 1 + Number(summary?.props.height ?? 0) + headerRows(header as Element, width) + Number(qRegion?.props.height ?? 0)
      await $.ui.scroll({ component: 'Pane', requestId: 'track', offset: 0, by: 1, bodyRows: 12, contentRows: 12, origin: { kind: 'person' },
        ...(input === 'wheel' && { pointer: { row: stepTop + 1, column: 1 } }),
      } as never)
      await clock.advance(100)
      await ui.redraw()
    }
    expect([...seen].sort()).toEqual(steps.map(step => `row-s-${step.id}`).sort())
    expect(ledger.writes).toHaveLength(0)
  })
}

// ASCII words only: this measures actual emitted detail lines, not hidden raw
// source text. A missing visible ellipsis must not pass on tree containment.
const wordLines = (text: string, width: number): number => {
  let lines = 1
  let used = 0
  for (const word of text.split(' ')) {
    if (used > 0 && used + 1 + word.length > width) { lines++; used = word.length }
    else used += (used === 0 ? 0 : 1) + word.length
  }
  return lines
}
test('a short opened step detail budgets its heading and leaves the ellipsis inside the region', async ($, on) => {
  mock.clock(on)
  const subject = 'Inspect the source connection and record the visible alignment before continuing. '.repeat(6).trim()
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: [{ id: 'plan:1', source: 'plan', subject, status: 'in_progress' }] })
  atomStore(on, 'activity', { ...IDLE, isWorking: true })
  const ui = await $.ui.mount(pane('dock', 60, 12))
  await ui.press({ key: 'title-s-plan:1' })
  const heading = await ui.find({ key: 'step-group-in_progress' })
  expect(heading).toBeDefined()
  const row = await ui.find({ key: 'row-s-plan:1' })
  const children = row?.children as Array<Element>
  const detail = children.find(child => child.props?.marginLeft === 3)
  const text = (detail?.children?.[0] as Element)?.children?.join('') ?? ''
  expect(text.endsWith('…')).toBe(true)
  const regionRows = Number((await ui.find({ key: 'steps' }))?.props.height ?? 0)
  expect(Number(heading?.props.height) + 1 + wordLines(text, Number(detail?.props?.width))).toBeLessThanOrEqual(regionRows)
  expect(ledger.value.steps[0].subject).toBe(subject)
  expect(ledger.writes).toHaveLength(0)
})

for (const height of [12, 16]) test(`section heights and footer position stay fixed through both scroll sweeps at 60x${height}`, async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, questions: questionsOf(5), steps: stepsOf(12) })
  atomStore(on, 'activity', IDLE)
  const scroll = atomStore(on, 'scroll', { questions: 0, steps: 0 })
  const ui = await $.ui.mount(pane('dock', 60, height))
  const heights = async () => ({
    questions: (await ui.find({ key: 'questions' }))?.props.height,
    steps: (await ui.find({ key: 'steps' }))?.props.height,
    footer: (await ui.find({ key: 'bottom-bar' }))?.props.marginTop,
  })
  const before = await heights()
  expect(Number(before.steps)).toBeGreaterThanOrEqual(1)
  for (let i = 0; i < 12; i++) {
    scroll.value = { questions: Math.min(i, 4), steps: i }
    await ui.redraw()
    expect(await heights()).toEqual(before)
  }
})

test('active and inactive glyphs use the same column inside their two-cell status slots', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, steps: stepsOf(5) })
  atomStore(on, 'activity', { ...IDLE, isWorking: true })
  const ui = await $.ui.mount(pane('dock', 60, 30))
  for (let i = 1; i <= 5; i++) {
    const slot = await ui.find({ key: `s-status-plan:${i}` })
    expect(slot?.props.width).toBe(2)
    const children = slot?.children as Array<Element>
    expect(children[0].type).toBe('Box')
    expect(children[0].props?.width).toBe(1)
    expect(children[1].type).toBe('Text')
  }
})

test('an eight-column summary keeps complete count tokens and drops only the rightmost ones', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, steps: stepsOf(4) })
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', 8, 30))
  expect((await ui.find({ key: 'state-summary' }))?.text).toBe('A1 W1 P1')
  expect(String((await ui.find({ key: 'state-summary' }))?.text ?? '').length).toBeLessThanOrEqual(8)
})
