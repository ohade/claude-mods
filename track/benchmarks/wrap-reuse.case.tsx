// INSTRUMENTED FIXTURE: prepared scratch source counts existing wrappedLines calls.
// No global prototype patches or timing threshold; not native paint evidence.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from '../tests/kit'

test('offscreen wrapping is reused and resize or edited content is remeasured', async ($, on) => {
  mock.clock(on)
  const title = 'CACHE_OFFSCREEN_SENTINEL a long title that must be measured only when its text or width changes'
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: Array.from({ length: 50 }, (_, i) => ({
    id: `plan:${i + 1}`, source: 'plan', subject: i === 49 ? title : `Short step ${i + 1}`, status: 'pending',
  })) })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  let measurements = 0
  on('ui.log', (_, event) => {
    if (event.text.startsWith('TRACK14_WRAP_COUNT ')) measurements = Number(event.text.slice(19))
    return { value: undefined }
  })
  const ui = await $.ui.mount(pane('dock', 60, 30))
  expect(measurements).toBeGreaterThan(0)
  expect((await ui.find({ key: 'row-s-plan:50' }))?.key).toBeUndefined()
  let before = measurements
  await ui.redraw()
  expect(measurements).toBe(before)
  await ui.redraw(pane('dock', 17, 30).props)
  expect(measurements).toBeGreaterThan(before)
  expect((await ui.find({ key: 's-text-plan:1' }))?.props.width).toBe(14)
  before = measurements
  await ui.redraw()
  expect(measurements).toBe(before)
  ledger.value.steps[49].subject = title + ' edited'
  await ui.redraw()
  expect(measurements).toBeGreaterThan(before)
  before = measurements
  await ui.redraw()
  expect(measurements).toBe(before)
  await ui.unmount()
})
