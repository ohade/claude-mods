// FIXTURE: render trees and mock-clock writes, never native paint latency.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'
import type { On } from './kit'

const NOW = 1_800_000_000_000
const setup = async (on: On, visibilityFailure?: string) => {
  const clock = mock.clock(on)
  await clock.set(NOW)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: [{
    id: 'plan:1', source: 'plan', subject: 'Active fixture work',
    status: 'in_progress', startedAt: NOW - 7000,
  }] })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pane', { isOpen: true, hidden: false, closedByPerson: false })
  const pulse = atomStore(on, 'pulse', 0)
  const tick = atomStore(on, 'tick', 0)
  const visibility = { shown: true, placed: true, open: true }
  on('ui.panes', () => {
    if (visibilityFailure !== undefined) throw new Error(visibilityFailure)
    return { value: visibility.open ? [{
      id: 'track', title: 'Track', isShown: visibility.shown,
      isPlaced: visibility.placed, isFocused: false,
    }] : [] }
  })
  mock.store(on)
  return { clock, ledger, pulse, tick, visibility }
}

test('closed pane stops pulse and clock writes without changing tracked work', async ($, on) => {
  const { clock, ledger, pulse, tick, visibility } = await setup(on)
  const original = JSON.stringify(ledger.value)
  on('ui.close', () => ({ value: undefined }))
  const ui = await $.ui.mount(pane('dock', 60, 30))
  await clock.advance(1200)
  expect(pulse.writes.length).toBeGreaterThan(0)
  expect(tick.writes.length).toBeGreaterThan(0)
  await $.command.run({ command: 'track', args: '' })
  visibility.open = false
  await ui.unmount()
  const before = [pulse.writes.length, tick.writes.length]
  await clock.advance(6000)
  expect([pulse.writes.length, tick.writes.length]).toEqual(before)
  expect(JSON.stringify(ledger.value)).toBe(original)
})

test('a pane behind another tab or not placed performs no animation writes', async ($, on) => {
  const { clock, pulse, tick, visibility } = await setup(on)
  const ui = await $.ui.mount(pane('dock', 60, 30))
  await clock.advance(1200)
  expect(pulse.writes.length).toBeGreaterThan(0)
  expect(tick.writes.length).toBeGreaterThan(0)
  visibility.shown = false
  const before = [pulse.writes.length, tick.writes.length]
  await clock.advance(6000)
  expect([pulse.writes.length, tick.writes.length]).toEqual(before)
  visibility.shown = true
  visibility.placed = false
  await ui.redraw()
  await clock.advance(6000)
  expect([pulse.writes.length, tick.writes.length]).toEqual(before)
  await ui.unmount()
})

test('showing a hidden pane resumes both timers and the elapsed work clock', async ($, on) => {
  const { clock, ledger, pulse, tick, visibility } = await setup(on)
  const original = JSON.stringify(ledger.value)
  const ui = await $.ui.mount(pane('dock', 60, 30))
  await clock.advance(1200)
  visibility.shown = false
  const before = [pulse.writes.length, tick.writes.length]
  await clock.advance(60_000)
  expect([pulse.writes.length, tick.writes.length]).toEqual(before)
  visibility.shown = true
  await ui.redraw()
  expect((await ui.findAll({ type: 'Text' })).map(row => row.text)).toContain('1m')
  await clock.advance(1200)
  expect(pulse.writes.length).toBeGreaterThan(before[0])
  expect(tick.writes.length).toBeGreaterThan(before[1])
  expect(JSON.stringify(ledger.value)).toBe(original)
  await ui.unmount()
})

test('a host without pane visibility keeps rendering and running the existing timers', async ($, on) => {
  const { clock, ledger, pulse, tick } = await setup(on, 'fixture host cannot report pane visibility')
  const original = JSON.stringify(ledger.value)
  const ui = await $.ui.mount(pane('dock', 60, 30))
  expect((await ui.findAll({ type: 'Text' })).map(row => row.text)).toContain('<1m')
  await clock.advance(1200)
  expect(pulse.writes.length).toBeGreaterThan(0)
  expect(tick.writes.length).toBeGreaterThan(0)
  expect(JSON.stringify(ledger.value)).toBe(original)
  await ui.unmount()
})
