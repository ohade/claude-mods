// TRACK-14 4c1-fix, 2026-10-13: source and Close were clipped at 17 columns.
// FIXTURE: emitted native widths and dispatch, not terminal pixels.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'
import { collectTitlePages, detailFragment, detailPosition } from './pane-detail-assertions'

const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] }
const NOW = 1_800_000_000_000
const source = Array.from({ length: 80 }, (_, i) => `edge${String(i).padStart(3, '0')}`).join(' ').slice(0, 420)
type Element = { type?: string; props?: { width?: number; flexDirection?: string; columnGap?: number; label?: string; hotkey?: string }; children?: Array<Element | string> }
const columns = (node: Element | string): number => {
  if (typeof node === 'string') return Array.from(node).length
  if (node.props?.width !== undefined) return node.props.width
  if (node.type === 'Button') return String(node.props?.label ?? '').length + (node.props?.hotkey === undefined ? 0 : 3)
  const children = (node.children ?? []).filter(child => child !== '')
  const sizes = children.map(columns)
  return node.type === 'Text' || node.props?.flexDirection === 'row'
    ? sizes.reduce((sum, value) => sum + value, 0) + Math.max(0, sizes.length - 1) * (node.props?.columnGap ?? 0)
    : Math.max(0, ...sizes)
}

for (const width of [17, 24, 30]) test(`every source fragment fits its actual first-line box at ${width} columns`, async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(NOW)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: [{ id: 'plan:1', source: 'plan', subject: source, status: 'in_progress', startedAt: NOW - 65_000 }] })
  atomStore(on, 'activity', { ...IDLE, isWorking: true })
  const ui = await $.ui.mount(pane('dock', width, 12))
  await ui.press({ key: 'title-s-plan:1' })
  const total = (await detailPosition(ui, 's', 'plan:1')).total
  const fragments: string[] = []
  for (let page = 1; page <= total; page++) {
    const text = await ui.find({ key: 's-text-plan:1' })
    expect(String(text?.text ?? '').length).toBeLessThanOrEqual(Number(text?.props.width))
    const line = await ui.find({ key: 's-first-line-plan:1' })
    expect(columns(line as Element)).toBeLessThanOrEqual(width)
    fragments.push(await detailFragment(ui, 's', 'plan:1', 'S1'))
    await ui.press({ key: 'detail-next-s-plan:1' })
  }
  expect(fragments.join('')).toBe(source)
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})

test('Prev, Next and Close fit wholly inside a 17-column pane on every page', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, steps: [{ id: 'plan:1', source: 'plan', subject: source, status: 'pending' }] })
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', 17, 12))
  await ui.press({ key: 'title-s-plan:1' })
  const total = (await detailPosition(ui, 's', 'plan:1')).total
  for (let page = 1; page <= total; page++) {
    const controls = await ui.find({ key: 'detail-controls-s-plan:1' })
    expect(columns(controls as Element)).toBeLessThanOrEqual(17)
    for (const action of ['prev', 'next', 'close']) expect((await ui.find({ key: `detail-${action}-s-plan:1` }))?.type).toBe('Button')
    await ui.press({ key: 'detail-next-s-plan:1' })
  }
  await ui.press({ key: 'detail-close-s-plan:1' })
  expect(await ui.find({ key: 'detail-page-s-plan:1' })).toBeUndefined()
  await ui.unmount()
})

test('restored Q opens complete pages in place and the title toggle controls those same pages', async ($, on) => {
  mock.clock(on)
  const q = { id: 1, head: source, at: 1, turnId: 'restored', status: 'answered', answerText: 'Saved answer', restoredFrom: '11111111-2222-4333-8444-555555555555', restoredBy: '66666666-7777-4888-8999-aaaaaaaaaaaa' }
  const ledger = atomStore(on, 'ledger', { ...EMPTY, questions: [q] })
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', 60, 12))
  const preview = String((await ui.find({ key: 'q-text-1' }))?.text ?? '')
  await ui.press({ key: 'q-1' })
  expect((await ui.findAll({ type: 'Text' })).some(text => text.text === preview)).toBe(false)
  await collectTitlePages(ui, 'q', 1, 'Q1', source)
  await ui.press({ key: 'title-q-1' })
  expect(await ui.find({ key: 'detail-page-q-1' })).toBeUndefined()
  await ui.press({ key: 'title-q-1' })
  expect((await detailPosition(ui, 'q', 1)).page).toBe(1)
  expect(ledger.value.questions[0].head).toBe(source)
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})

test('question continuation uses the full section text width', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, questions: [{ id: 1, head: source, at: 1, turnId: 't', status: 'open', askedRequestId: 'question-1' }] })
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', 60, 12))
  await ui.press({ key: 'title-q-1' })
  const row = await ui.find({ key: 'row-q-1' })
  expect((await ui.find({ key: 'detail-q-1' }))?.props.width).toBe(60 - Number(row?.props.marginLeft ?? 0))
  await collectTitlePages(ui, 'q', 1, 'Q1', source)
  await ui.unmount()
})

test('an opened short question pays only for its first line and pager', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, questions: [{ id: 1, head: 'Short question', at: 1, turnId: 't', status: 'open' }] })
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', 60, 30))
  await ui.press({ key: 'title-q-1' })
  expect((await ui.find({ key: 'questions' }))?.props.height).toBe(2)
  await collectTitlePages(ui, 'q', 1, 'Q1', 'Short question')
  await ui.unmount()
})

test('headings never hide a twelve-step list that fits whole at 80x20', async ($, on) => {
  mock.clock(on)
  const statuses = ['waiting', 'in_progress', 'pending', 'paused', 'completed']
  atomStore(on, 'ledger', { ...EMPTY, steps: Array.from({ length: 12 }, (_, i) => ({ id: `plan:${i + 1}`, source: 'plan', subject: `Task ${i + 1}`, status: statuses[i % statuses.length] })) })
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', 80, 20))
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.filter(row => String(row.key ?? '').startsWith('row-s-'))).toHaveLength(12)
  expect(boxes.some(row => String(row.key ?? '').startsWith('step-group-'))).toBe(false)
  await ui.unmount()
})

test('closed busy redraws perform no paging-state reads or presentation writes', async ($, on) => {
  mock.clock(on)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: Array.from({ length: 50 }, (_, i) => ({ id: `plan:${i + 1}`, source: 'plan', subject: `Task ${i + 1}`, status: 'in_progress' })) })
  const reveal = atomStore(on, 'reveal', {})
  let reads = 0
  on('state.get', { plugin: 'track', key: 'detailAnchors' }, () => { reads++; return { value: { value: {}, version: 1 } } })
  atomStore(on, 'activity', { ...IDLE, isWorking: true })
  const ui = await $.ui.mount(pane('dock', 60, 30))
  for (let i = 0; i < 5; i++) await ui.redraw()
  expect(reads).toBe(0)
  expect(reveal.writes).toHaveLength(0)
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})
