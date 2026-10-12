// FIXTURE: delayed host lookup, real timer dispatch, mock-clock state writes.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from '../tests/kit'

const NOW = 1_800_000_000_000

for (const shown of [true, false]) for (const kind of ['pulse', 'clock'] as const) test(`a stale ${kind} ${shown ? 'shown' : 'hidden'} lookup cannot publish after close and reopen or disturb the replacement intervals`, async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(NOW)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: [{
    id: 'plan:1', source: 'plan', subject: 'Active fixture work',
    status: 'in_progress', startedAt: NOW - 7000,
  }] })
  const original = JSON.stringify(ledger.value)
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pane', { isOpen: true, hidden: false, closedByPerson: false })
  const pulse = atomStore(on, 'pulse', 0)
  const tick = atomStore(on, 'tick', 0)
  mock.store(on)
  let visible = true
  let held = false
  let release!: () => void
  let reached!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve })
  const arrived = new Promise<void>(resolve => { reached = resolve })
  const targetMs = kind === 'pulse' ? 400 : 1000
  on('ui.panes', async () => {
    const shouldHold = !held && clock.now() === NOW + targetMs
    if (shouldHold && !shown) visible = false
    const snapshot = [{ id: 'track', title: 'Track', isShown: visible, isPlaced: visible, isFocused: false }]
    if (shouldHold) {
      held = true
      reached()
      await delayed
    }
    return { value: snapshot }
  })
  on('ui.close', () => { visible = false; return { value: undefined } })
  on('ui.open', () => { visible = true; return { value: { isPlaced: true as const } } })
  const ui = await $.ui.mount(pane('dock', 60, 30))
  const advancing = clock.advance(targetMs)
  await arrived
  await $.command.run({ command: 'track', args: '' })
  await ui.unmount()
  await $.command.run({ command: 'track', args: '' })
  const reopened = await $.ui.mount(pane('dock', 60, 30))
  const beforeRelease = [pulse.writes.length, tick.writes.length]
  release()
  await advancing
  // The only event due at this instant belongs to the abandoned generation.
  expect([pulse.writes.length, tick.writes.length]).toEqual(beforeRelease)
  const beforeIntervals = [pulse.writes.length, tick.writes.length]
  await clock.advance(2000)
  // One 400 ms pulse interval and one 1000 ms clock interval, neither duplicated nor lost.
  expect([pulse.writes.length - beforeIntervals[0], tick.writes.length - beforeIntervals[1]]).toEqual([5, 2])
  expect(JSON.stringify(ledger.value)).toBe(original)
  await reopened.unmount()
})
