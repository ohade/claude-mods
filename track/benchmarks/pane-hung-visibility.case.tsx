// FIXTURE: one hung raw host request must remain bounded across pane lifecycles.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from '../tests/kit'

test('a hanging visibility host retains at most one raw request across four reopen cycles', async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(1_800_000_000_000)
  atomStore(on, 'ledger', { ...EMPTY, steps: [{
    id: 'plan:1', source: 'plan', subject: 'Active fixture work',
    status: 'in_progress', startedAt: 1_799_999_993_000,
  }] })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pane', { isOpen: true, hidden: false, closedByPerson: false })
  const pulse = atomStore(on, 'pulse', 0)
  const tick = atomStore(on, 'tick', 0)
  mock.store(on)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let outstanding = 0
  let peak = 0
  on('ui.panes', async () => {
    outstanding++
    peak = Math.max(peak, outstanding)
    await held
    outstanding--
    return { value: [{ id: 'track', title: 'Track', isShown: true, isPlaced: true, isFocused: false }] }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  let ui = await $.ui.mount(pane('dock', 60, 30))
  try {
    await clock.advance(1200)
    for (let cycle = 0; cycle < 4; cycle++) {
      await $.command.run({ command: 'track', args: '' })
      await ui.unmount()
      await $.command.run({ command: 'track', args: '' })
      ui = await $.ui.mount(pane('dock', 60, 30))
      await clock.advance(1200)
    }
    expect(pulse.writes.length).toBeGreaterThan(0)
    expect(tick.writes.length).toBeGreaterThan(0)
    expect(outstanding).toBe(1)
    expect(peak).toBe(1)
  } finally {
    release()
    await clock.advance(100)
    await ui.unmount()
  }
})
