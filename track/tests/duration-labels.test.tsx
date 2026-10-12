// FIXTURE: CC #171, 2026-10-08. Whole minutes below an hour; <1m below a minute.
// Hour labels stay unchanged. The same displayed labels must fit both pane widths.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const START = 1_800_000_000_000
const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] }
const duration = (ms: number) => ({ id: 'plan:1', source: 'plan', subject: 'Measured work', status: 'completed', startedAt: START, endedAt: START + ms })
const labels = [
  [-1000, '<1m'], [0, '<1m'], [59_999, '<1m'], [60_000, '1m'],
  [269_000, '4m'], [540_000, '9m'], [706_000, '11m'], [1_400_000, '23m'],
  [3_599_999, '59m'], [3_600_000, '1h 00m'], [3_700_000, '1h 01m'], [4_260_000, '1h 11m'],
] as const

for (const [ms, expected] of labels) {
  test(`a completed ${ms}ms duration displays ${expected}`, async ($, on) => {
    mock.clock(on)
    atomStore(on, 'ledger', { ...EMPTY, steps: [duration(ms)] })
    atomStore(on, 'activity', IDLE)
    const ui = await $.ui.mount(pane('dock', 80, 30))
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain(expected)
  })
}

for (const width of [25, 60]) {
  for (const [ms, expected] of [[269_000, '4m'], [4_260_000, '1h 11m']] as const) {
    test(`the ${expected} duration stays at the right edge in a ${width}-column pane`, async ($, on) => {
      mock.clock(on)
      atomStore(on, 'ledger', { ...EMPTY, steps: [duration(ms)] })
      atomStore(on, 'activity', IDLE)
      const ui = await $.ui.mount(pane('dock', width, 30))
      expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain(expected)
      const clock = await ui.find({ key: 's-clock-plan:1' })
      expect(clock?.props.flexShrink).toBe(0)
      const text = await ui.find({ key: 's-text-plan:1' })
      const row = await ui.find({ key: 'row-s-plan:1' })
      const owner = await ui.find({ key: 's-owner-plan:1' })
      const slot = await ui.find({ key: 's-time-slot-plan:1' })
      const children = row?.children as Array<{ props?: { key?: string; width?: number } }>
      expect(Number(text?.props.width) + Number(owner?.props.width) + Number(slot?.props.width)
        + 2 + 1 + 4 * Number(row?.props.columnGap) + Number(row?.props.marginLeft)).toBe(width)
      expect(children.at(-1)?.props?.key).toBe('s-time-slot-plan:1')
      expect(slot?.props).toMatchObject({ justifyContent: 'flex-end', flexShrink: 0 })
      expect(Number(slot?.props.width)).toBeGreaterThanOrEqual(expected.length)
    })
  }
}

test('a running duration crosses the first minute without rounding up early', async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(START + 59_000)
  atomStore(on, 'ledger', { ...EMPTY, steps: [{ ...duration(0), status: 'in_progress', endedAt: undefined }] })
  atomStore(on, 'activity', IDLE)
  let ui = await $.ui.mount(pane('dock', 60, 30))
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('<1m')
  await clock.advance(1000)
  await ui.unmount()
  ui = await $.ui.mount(pane('dock', 60, 30))
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('1m')
})
