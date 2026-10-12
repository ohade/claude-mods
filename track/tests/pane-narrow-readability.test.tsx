// TRACK-14 part 3c, 2026-10-12: owner/time columns left no subject at 24
// columns with a 10h clock. A wide Q/A layout also crowded 40-column titles.
// FIXTURE: actual display strings and row arithmetic, not native paint.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const NOW = 1_800_000_000_000
const MIN_SUBJECT_CHARS = 16
const subject = 'Inspect the original folded bracket drawing before recording every alignment mark and checking the complete connection'
const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] }

for (const width of [24, 25, 30]) test(`all six titles show at least 16 subject characters at ${width} columns with a 10h clock`, async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(NOW)
  const steps = Array.from({ length: 6 }, (_, i) => ({
    id: `plan:${i + 1}`, source: 'plan', subject: `${subject} ${i + 1}`,
    status: i === 0 ? 'in_progress' : 'pending',
    ...(i === 0 && { startedAt: NOW - 36_000_000 }),
  }))
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps })
  const original = JSON.stringify(ledger.value)
  atomStore(on, 'activity', { ...IDLE, isWorking: true })
  const ui = await $.ui.mount(pane('dock', width, 30))
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.map(text => text.text)).toContain('10h 00m')
  for (let i = 0; i < steps.length; i++) {
    const prefix = `S${i + 1}. `
    const title = String(texts.find(text => String(text.text).startsWith(prefix))?.text ?? '')
    expect(title.slice(prefix.length).replace(/…$/, '').length).toBeGreaterThanOrEqual(MIN_SUBJECT_CHARS)
    const row = await ui.find({ key: `row-s-${steps[i].id}` })
    expect(row?.props.flexDirection).toBe('column')
    const groups = row?.children as Array<{ props?: { flexDirection?: string; width?: number }; children?: Array<{ props?: { key?: string } }> }>
    expect(groups[0]?.props?.flexDirection).toBe('row')
    expect(groups.at(-1)?.props).toMatchObject({ flexDirection: 'row', width })
    expect(groups.at(-1)?.children?.at(-1)?.props?.key).toBe(`s-time-slot-${steps[i].id}`)
    expect((await ui.find({ key: `s-time-slot-${steps[i].id}` }))?.props.justifyContent).toBe('flex-end')
    expect((await ui.find({ key: `title-s-${steps[i].id}` }))?.type).toBe('Button')
  }
  expect(JSON.stringify(ledger.value)).toBe(original)
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})

for (const width of [40, 45]) test(`question titles keep 16 subject characters and Q/A controls below at ${width} columns`, async ($, on) => {
  mock.clock(on)
  const head = 'Why did the original folded bracket drawing show this connection before the alignment marks were recorded?'
  const ledger = atomStore(on, 'ledger', { ...EMPTY, questions: [{ id: 1, head, at: 1, turnId: 't', status: 'open', askedRequestId: 'question-1' }] })
  const original = JSON.stringify(ledger.value)
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', width, 30))
  const title = String((await ui.findAll({ type: 'Text' })).find(text => String(text.text).startsWith('Q1. '))?.text ?? '')
  expect(title.slice('Q1. '.length).replace(/…$/, '').length).toBeGreaterThanOrEqual(MIN_SUBJECT_CHARS)
  expect((await ui.find({ key: 'row-q-1' }))?.props.flexDirection).toBe('column')
  expect((await ui.find({ key: 'q-markers-1' }))?.props.width).toBe(13)
  expect((await ui.find({ key: 'q-1' }))?.props.hotkey).toBe('1')
  expect((await ui.find({ key: 'title-q-1' }))?.type).toBe('Button')
  expect((await ui.find({ key: 'del-1' }))?.props.label).toBe('✕')
  expect(JSON.stringify(ledger.value)).toBe(original)
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})
