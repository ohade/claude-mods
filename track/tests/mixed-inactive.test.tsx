// FIXTURE: inactive ownership metadata must not become a claim of running agents
// when the mixed banner exposes work beside a user wait (CC #149).
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] }

for (const status of ['waiting', 'paused', 'pending'] as const) {
  test(`a ${status} delegated step alone is not running work beside a user wait`, async ($, on) => {
    const clock = mock.clock(on)
    atomStore(on, 'ledger', { ...EMPTY, steps: [
      { id: 'plan:1', source: 'plan', subject: 'Need user decision', status: 'waiting' },
      { id: 'plan:2', source: 'plan', subject: 'Inactive ownership', status, delegated: true },
    ] })
    atomStore(on, 'activity', IDLE)
    const phase = atomStore(on, 'pulse', 0)
    const ui = await $.ui.mount(pane('dock', 80))
    const text = (await ui.findAll({ type: 'Text' })).at(-1)?.text?.trim() ?? ''
    expect(text).toContain('Waiting on you')
    expect(text).not.toContain('agents')
    if (status !== 'waiting') expect(text).not.toContain('S2')
    await clock.advance(1300)
    expect(phase.writes).toHaveLength(0)
  })
}
