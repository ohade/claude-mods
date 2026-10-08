// Counterchecks for the 2026-10-08 inactive-clock fix: active clocks must remain.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const NOW = 1_800_000_000_000
const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [] }

for (const delegated of [false, true]) {
  test(`an in-progress ${delegated ? 'delegated' : 'main'} step retains its running clock`, async ($, on) => {
    const clock = mock.clock(on)
    await clock.set(NOW)
    atomStore(on, 'ledger', { ...EMPTY, steps: [{ id: 'plan:1', source: 'plan', subject: 'Active work', status: 'in_progress', startedAt: NOW - 7000, delegated }] })
    atomStore(on, 'activity', IDLE)
    const tick = atomStore(on, 'tick', 0)
    const ui = await $.ui.mount(pane('dock', 60, 30))
    expect((await ui.find({ key: 's-clock-plan:1' }))?.key).toBe('s-clock-plan:1')
    expect((await ui.findAll({ type: 'Text' })).map(row => row.text)).toContain('0:07')
    const writes = tick.writes.length
    await clock.advance(3000)
    expect(tick.writes.length - writes).toBeGreaterThanOrEqual(3)
  })
}
