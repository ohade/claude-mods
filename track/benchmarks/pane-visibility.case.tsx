// FIXTURE: visibility notifications and bounded lookup, not painted pixels.
import { expect, mock, test } from 'claude-code/testing'
import type { Register } from 'claude-code'
import { EMPTY, atomStore, pane } from '../tests/kit'
import type { On } from '../tests/kit'

const NOW = 1_800_000_000_000
const setup = async (on: On) => {
  const clock = mock.clock(on)
  await clock.set(NOW)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: [{
    id: 'plan:1', source: 'plan', subject: 'Active fixture work',
    status: 'in_progress', startedAt: NOW - 7000,
  }] })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  const pulse = atomStore(on, 'pulse', 0)
  const tick = atomStore(on, 'tick', 0)
  return { clock, ledger, pulse, tick }
}

test('showing the pane resumes both timers without an explicit redraw', async ($, on) => {
  const { clock, ledger, pulse, tick } = await setup(on)
  const original = JSON.stringify(ledger.value)
  let shown = true
  on('ui.panes', () => ({ value: [{ id: 'track', title: 'Track', isShown: shown, isPlaced: true, isFocused: false }] }))
  const ui = await $.ui.mount(pane('dock', 60, 30))
  await clock.advance(1200)
  expect(pulse.writes.length).toBeGreaterThan(0)
  expect(tick.writes.length).toBeGreaterThan(0)
  shown = false
  await clock.advance(2000)
  const hidden = [pulse.writes.length, tick.writes.length]
  await clock.advance(2000)
  expect([pulse.writes.length, tick.writes.length]).toEqual(hidden)
  shown = true
  await clock.advance(3000)
  expect(pulse.writes.length).toBeGreaterThan(hidden[0])
  expect(tick.writes.length).toBeGreaterThan(hidden[1])
  expect(JSON.stringify(ledger.value)).toBe(original)
  await ui.unmount()
})

const observer = {
  name: 'track-visibility-render-observer', tier: 'prepend' as const,
  register: ((on) => {
    on('ui.render', { component: 'Pane', requestId: 'track' }, async ($, event, next) => {
      $.ui.log('TRACK14_DRAW_STARTED', { to: 'debug' })
      const tree = await next(event)
      $.ui.log('TRACK14_DRAW_FINISHED', { to: 'debug' })
      return tree
    })
  }) as Register,
}

test('a hanging visibility lookup cannot block rendering or the legacy timer fallback', { plugins: [observer] }, async ($, on) => {
  const { clock, pulse, tick } = await setup(on)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  on('ui.panes', async () => {
    await held
    return { value: [{ id: 'track', title: 'Track', isShown: true, isPlaced: true, isFocused: false }] }
  })
  let began!: () => void
  const started = new Promise<void>(resolve => { began = resolve })
  let finished = false
  on('ui.log', (_, event) => {
    if (event.text === 'TRACK14_DRAW_STARTED') began()
    if (event.text === 'TRACK14_DRAW_FINISHED') finished = true
    return { value: undefined }
  })
  const mounting = $.ui.mount(pane('dock', 60, 30))
  await started
  try {
    await clock.advance(20)
    expect(finished).toBe(true)
    await clock.advance(1200)
    expect(pulse.writes.length).toBeGreaterThan(0)
    expect(tick.writes.length).toBeGreaterThan(0)
  } finally {
    release()
    const ui = await mounting
    expect((await ui.findAll({ type: 'Text' })).some(row => String(row.text).includes('SESSION TRACKER'))).toBe(true)
    await ui.unmount()
  }
})
