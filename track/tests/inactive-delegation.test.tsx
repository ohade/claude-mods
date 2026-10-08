// FIXTURE: parked or pending ownership is not active work, even without a user wait.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

for (const status of ['paused', 'pending'] as const) {
  test(`an inactive ${status} delegated step stays paused without a running-work signal`, async ($, on) => {
    const clock = mock.clock(on)
    atomStore(on, 'ledger', { ...EMPTY, steps: [{ id: 'plan:1', source: 'plan', subject: 'Parked ownership', status, delegated: true }] })
    atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
    const phase = atomStore(on, 'pulse', 0)
    const ui = await $.ui.mount(pane('dock', 80))
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.at(-1)?.text?.trim()).toBe('Paused')
    expect(texts.some(t => t.text === '⧗')).toBe(false)
    expect(texts.some(t => t.text === (status === 'paused' ? '⏸' : '○'))).toBe(true)
    await clock.advance(1300)
    expect(phase.writes).toHaveLength(0)
  })
}
