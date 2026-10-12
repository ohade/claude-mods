// TRACK-14 part 4a: state groups retain identity and remain navigable.
// FIXTURE: native mod descriptions and dispatch, not terminal paint.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] }
const statuses = ['completed', 'paused', 'pending', 'waiting', 'in_progress', 'in_progress', 'pending']
const mixed = statuses.map((status, i) => ({ id: `plan:${i + 1}`, source: 'plan', subject: `Work ${i + 1}`, status, ...(i === 5 && { delegated: true }) }))

test('mixed states group stably without renumbering or changing owner and background meaning', async ($, on) => {
  mock.clock(on)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: mixed })
  atomStore(on, 'activity', { ...IDLE, isWorking: true, background: ['bg-agent'] })
  const ui = await $.ui.mount(pane('dock', 80, 40))
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.filter(row => String(row.key ?? '').startsWith('step-group-')).map(row => row.text)).toEqual(['ACTIVE', 'WAITING ON YOU', 'NEXT', 'PAUSED', 'DONE'])
  expect(boxes.filter(row => String(row.key ?? '').startsWith('row-s-')).map(row => row.key)).toEqual([5, 6, 4, 3, 7, 2, 1].map(n => `row-s-plan:${n}`))
  for (let i = 0; i < mixed.length; i++) expect((await ui.find({ key: `s-text-${mixed[i].id}` }))?.text).toBe(`S${i + 1}. Work ${i + 1}`)
  expect((await ui.find({ key: 'state-summary' }))?.text).toBe('2 active · 1 waiting · 1 paused · 2 queued')
  expect((await ui.find({ key: 's-owner-plan:5' }))?.text).toBe('main')
  expect((await ui.find({ key: 's-owner-plan:6' }))?.text).toBe('agent')
  expect((await ui.find({ key: 's-status-plan:6' }))?.text).toContain('⧗')
  for (const id of ['plan:5', 'plan:6']) {
    expect((await ui.find({ key: `s-active-${id}` }))?.text).toBe('▏')
    expect((await ui.find({ key: `s-status-${id}` }))?.props.width).toBe(2)
  }
  expect(await ui.find({ key: 's-active-plan:3' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Text' })).some(text => text.text === 'S1. Work 1' && text.props.color === 'success')).toBe(true)
  expect(ledger.value.steps).toEqual(mixed)
  expect(ledger.writes).toHaveLength(0)
})

for (const width of [17, 30, 60]) test(`all counts fit one summary row at ${width} columns with 300 steps`, async ($, on) => {
  mock.clock(on)
  const states = [...Array(100).fill('in_progress'), ...Array(100).fill('waiting'), ...Array(99).fill('paused'), 'pending']
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: states.map((status, i) => ({ id: `plan:${i + 1}`, source: 'plan', subject: `Work ${i + 1}`, status })) })
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', width, 30))
  const summary = await ui.find({ key: 'state-summary' })
  expect(summary?.props.height).toBe(1)
  expect(summary?.text).toBe(width === 60 ? '100 active · 100 waiting · 99 paused · 1 queued' : 'A100 W100 P99 Q1')
  expect(String(summary?.text ?? '').length).toBeLessThanOrEqual(width)
  expect(ledger.writes).toHaveLength(0)
})

test('empty groups take no rows and status changes regroup without renumbering', async ($, on) => {
  mock.clock(on)
  const steps = [{ id: 'plan:1', source: 'plan', subject: 'First', status: 'pending' }, { id: 'plan:2', source: 'plan', subject: 'Second', status: 'pending' }]
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps })
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', 60, 30))
  const headings = async () => (await ui.findAll({ type: 'Box' })).filter(row => String(row.key ?? '').startsWith('step-group-')).map(row => row.text)
  expect(await headings()).toEqual(['NEXT'])
  expect((await ui.find({ key: 'steps' }))?.props.height).toBe(3)
  ledger.value = { ...ledger.value, steps: [{ ...steps[0], status: 'paused' }, { ...steps[1], status: 'in_progress' }] }
  await ui.redraw()
  expect(await headings()).toEqual(['ACTIVE', 'PAUSED'])
  expect((await ui.find({ key: 'state-summary' }))?.text).toBe('1 active · 0 waiting · 1 paused · 0 queued')
  expect((await ui.find({ key: 's-text-plan:2' }))?.text).toBe('S2. Second')
  expect((await ui.find({ key: 's-text-plan:1' }))?.text).toBe('S1. First')
  expect(ledger.writes).toHaveLength(0)
})

for (const height of [12, 40]) test(`keyboard-origin scrolling reaches every task without a heading-only viewport at 60x${height}`, async ($, on) => {
  const clock = mock.clock(on)
  const states = ['completed', 'paused', 'pending', 'waiting', 'in_progress']
  const steps = Array.from({ length: 20 }, (_, i) => ({ id: `plan:${i + 1}`, source: 'plan', subject: `Work ${i + 1}`, status: states[i % 5] }))
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps })
  atomStore(on, 'activity', IDLE)
  atomStore(on, 'scroll', { questions: null, steps: 0 })
  on('ui.scroll', () => ({}))
  const ui = await $.ui.mount(pane('dock', 60, height))
  const seen = new Set<string>()
  const seenGroups = new Set<string>()
  for (let i = 0; i < steps.length; i++) {
    const boxes = await ui.findAll({ type: 'Box' })
    const rows = boxes.filter(row => String(row.key ?? '').startsWith('row-s-'))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) seen.add(String(row.key))
    for (const group of boxes.filter(row => String(row.key ?? '').startsWith('step-group-'))) {
      seenGroups.add(String(group.text))
      const status = String(group.key).slice('step-group-'.length)
      expect(rows.some(row => steps.find(step => `row-s-${step.id}` === row.key)?.status === status)).toBe(true)
    }
    await $.ui.scroll({ component: 'Pane', requestId: 'track', offset: 0, by: 1, bodyRows: height, contentRows: height, origin: { kind: 'person' } } as never)
    await clock.advance(100)
    await ui.redraw()
  }
  expect([...seen].sort()).toEqual(steps.map(step => `row-s-${step.id}`).sort())
  // Short viewports spend their rows on tasks. The tall case fits all five
  // headings, so it retains the positive grouping and navigation check.
  expect([...seenGroups].sort()).toEqual(height === 12 ? [] : ['ACTIVE', 'WAITING ON YOU', 'NEXT', 'PAUSED', 'DONE'].sort())
  expect(ledger.writes).toHaveLength(0)
})
