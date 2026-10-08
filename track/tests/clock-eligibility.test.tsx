// FIXTURE for 2026-10-08: pending work retained startedAt and kept a moving clock.
// A timestamp alone cannot say the step is currently in progress.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const NOW = 1_800_000_000_000
const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [] }

for (const status of ['pending', 'paused', 'waiting']) {
  test(`a previously started ${status} step shows no running clock or timer updates`, async ($, on) => {
    const clock = mock.clock(on)
    await clock.set(NOW)
    const before = { ...EMPTY, steps: [{ id: 'plan:1', source: 'plan', subject: 'Parked work', status, startedAt: NOW - 7000 }] }
    const ledger = atomStore(on, 'ledger', before)
    atomStore(on, 'activity', IDLE)
    const tick = atomStore(on, 'tick', 0)
    const ui = await $.ui.mount(pane('dock', 60, 30))
    expect((await ui.find({ key: 's-clock-plan:1' }))?.key).toBeUndefined()
    const writes = tick.writes.length
    await clock.advance(3000)
    expect(tick.writes.length).toBe(writes)
    expect(ledger.value).toEqual(before)
  })
}

test('a completed legacy step without an end time does not show a moving duration', async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(NOW)
  atomStore(on, 'ledger', { ...EMPTY, steps: [{ id: 'plan:1', source: 'plan', subject: 'Unknown completion time', status: 'completed', startedAt: NOW - 7000 }] })
  atomStore(on, 'activity', IDLE)
  const tick = atomStore(on, 'tick', 0)
  const ui = await $.ui.mount(pane('inline', 25, 20))
  expect((await ui.find({ key: 's-clock-plan:1' }))?.key).toBeUndefined()
  const writes = tick.writes.length
  await clock.advance(3000)
  expect(tick.writes.length).toBe(writes)
})
