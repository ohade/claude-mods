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
      if (width === 25) {
        expect(clock?.props.alignSelf).toBe('flex-end')
      } else {
        const text = await ui.find({ key: 's-text-plan:1' })
        const row = await ui.find({ key: 'row-s-plan:1' })
        expect(Number(text?.props.width) + expected.length + 2 + Number(row?.props.marginLeft) + 2).toBe(width)
      }
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
