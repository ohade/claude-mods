// FIXTURE controls for the mixed-activity change. These are not the frozen RED checks.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const IDLE = { isWorking: false, agentCalls: [] as string[], askCalls: [] as string[], background: [] as string[], tasks: [] as string[] }

test('an open question dialog alone does not claim active main work or pulse', async ($, on) => {
  const clock = mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, steps: [{ id: 'plan:1', source: 'plan', subject: 'Ask user', status: 'in_progress' }] })
  atomStore(on, 'activity', { ...IDLE, isWorking: true, askCalls: ['toolu_ask'] })
  const phase = atomStore(on, 'pulse', 0)
  const ui = await $.ui.mount(pane('dock', 80))
  expect((await ui.findAll({ type: 'Text' })).at(-1)?.text?.trim()).toBe('Waiting on you')
  await clock.advance(1300)
  expect(phase.writes).toHaveLength(0)
})

test('native background work pulses during a main turn with a user-waiting row', async ($, on) => {
  const clock = mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, steps: [{ id: 'plan:1', source: 'plan', subject: 'Need decision', status: 'waiting' }] })
  atomStore(on, 'activity', { ...IDLE, isWorking: true, background: ['native-a', 'native-b'] })
  const phase = atomStore(on, 'pulse', 0)
  const ui = await $.ui.mount(pane('dock', 80))
  const text = (await ui.findAll({ type: 'Text' })).at(-1)?.text ?? ''
  expect(text).toContain('Waiting on you')
  expect(text).toContain('agents (2) working')
  await clock.advance(1300)
  expect(phase.writes.length).toBeGreaterThanOrEqual(2)
})
