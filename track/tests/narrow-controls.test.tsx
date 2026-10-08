// FIXTURE: the short inline pane must leave room for question text AND its jump controls.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

test('a 17-column short pane reserves the Q/A control row while steps remain', async ($, on) => {
  atomStore(on, 'ledger', {
    ...EMPTY,
    questions: [{ id: 1, head: 'A substantive question that needs several lines', at: 1, turnId: 't', status: 'open', askedRequestId: 'source-1' }],
    steps: Array.from({ length: 3 }, (_, i) => ({ id: `plan:${i}`, source: 'plan', subject: 'Work', status: 'pending' })),
  })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  mock.clock(on)
  const ui = await $.ui.mount(pane('inline', 17, 16))
  expect((await ui.find({ key: 'questions' }))?.props.height).toBeGreaterThanOrEqual(2)
  expect((await ui.find({ key: 'steps' }))?.props.height).toBeGreaterThanOrEqual(1)
  expect((await ui.find({ key: 'q-1' }))?.props.hotkey).toBe('1')
})
