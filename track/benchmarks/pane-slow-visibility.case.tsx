// FIXTURE: slow host visibility must not create hidden writes or repeated warnings.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from '../tests/kit'
import type { On } from '../tests/kit'

const NOW = 1_800_000_000_000
const setup = async (on: On, delayMs: number) => {
  const clock = mock.clock(on)
  await clock.set(NOW)
  atomStore(on, 'ledger', { ...EMPTY, steps: [{
    id: 'plan:1', source: 'plan', subject: 'Active fixture work',
    status: 'in_progress', startedAt: NOW - 7000,
  }] })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  const pulse = atomStore(on, 'pulse', 0)
  const tick = atomStore(on, 'tick', 0)
  const warnings: string[] = []
  const responses: Array<{ at: number; finish: () => void }> = []
  on('ui.panes', async () => {
    // The test actor cannot schedule host timers. Release responses from the
    // test driver after virtual time has actually passed, without production hooks.
    await new Promise<void>(finish => { responses.push({ at: clock.now() + delayMs, finish }) })
    return { value: [{ id: 'track', title: 'Track', isShown: false, isPlaced: true, isFocused: false }] }
  })
  on('ui.log', (_, event) => {
    if (event.text.startsWith('track: pane visibility unavailable')) warnings.push(event.text)
    return { value: undefined }
  })
  const advance = async () => {
    for (let frame = 0; frame < 300; frame++) {
      await clock.advance(10)
      for (let index = responses.length - 1; index >= 0; index--) {
        if (responses[index]!.at <= clock.now()) responses.splice(index, 1)[0]!.finish()
      }
    }
  }
  return { advance, pulse, tick, warnings }
}

test('a healthy 10 ms visibility host keeps a hidden pane at zero animation writes', async ($, on) => {
  const { advance, pulse, tick, warnings } = await setup(on, 10)
  const ui = await $.ui.mount(pane('dock', 60, 30))
  await advance()
  expect([pulse.writes.length, tick.writes.length]).toEqual([0, 0])
  expect(warnings.length).toBeLessThanOrEqual(1)
  await ui.unmount()
})

test('a healthy 10 ms visibility host does not rearm timeout warning spam', async ($, on) => {
  const { advance, warnings } = await setup(on, 10)
  const ui = await $.ui.mount(pane('dock', 60, 30))
  await advance()
  expect(warnings.length).toBeLessThanOrEqual(1)
  await ui.unmount()
})

test('late visibility successes beyond the bounded wait warn once and preserve fallback', async ($, on) => {
  const { advance, pulse, tick, warnings } = await setup(on, 75)
  const ui = await $.ui.mount(pane('dock', 60, 30))
  await advance()
  // Beyond the bounded wait, legacy animation remains available with one warning.
  expect(pulse.writes.length).toBeGreaterThan(0)
  expect(tick.writes.length).toBeGreaterThan(0)
  expect(warnings.length).toBe(1)
  await ui.unmount()
})
