// FIXTURE: render descriptions. Observed 2026-10-08: A looked ready before
// answer text existed, including an older restored answer with no saved text.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'
import type { On } from './kit'

const setup = (on: On, question: Record<string, unknown>) => {
  atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 2, questions: [{
    id: 1, head: 'A question', at: 1, turnId: 'turn', status: 'answered',
    ...question,
  }] })
  mock.clock(on)
}

test('an answer acknowledgement without answer text stays faded in wide and narrow panes', async ($, on) => {
  setup(on, { answerRequestId: 'toolu_ack' })
  for (const width of [17, 60]) {
    const ui = await $.ui.mount(pane('dock', width, 30))
    const button = await ui.find({ key: 'a-1' })
    expect(button?.props.dimColor).toBe(true)
    expect(button?.props.variant).not.toBe('primary')
    expect((await ui.find({ key: 'q-markers-1' }))?.props.width).toBe(13)
    await ui.unmount()
  }
})

test('a captured answer has the ready style', async ($, on) => {
  setup(on, { answerRequestId: 'answer', answerKey: 'answer-row', answerText: 'The actual answer.' })
  const ui = await $.ui.mount(pane('dock'))
  expect((await ui.find({ key: 'a-1' }))?.props.variant).toBe('primary')
  expect((await ui.find({ key: 'a-1' }))?.props.dimColor).not.toBe(true)
})

test('a restored answer without saved text stays faded', async ($, on) => {
  setup(on, { restoredBy: 'restore-note' })
  const ui = await $.ui.mount(pane('dock'))
  expect((await ui.find({ key: 'a-1' }))?.props.dimColor).toBe(true)
  expect((await ui.find({ key: 'a-1' }))?.props.variant).not.toBe('primary')
})

test('a restored answer with saved text has the ready style', async ($, on) => {
  setup(on, { restoredBy: 'restore-note', answerText: 'תשובה 😀' })
  const ui = await $.ui.mount(pane('dock'))
  expect((await ui.find({ key: 'a-1' }))?.props.variant).toBe('primary')
})

test('an unavailable answer marker is explicitly grey and faded', async ($, on) => {
  setup(on, { status: 'open' })
  const ui = await $.ui.mount(pane('dock'))
  const marker = await ui.find({ type: 'Text', text: '[ A ]' })
  expect(marker?.props.dimColor).toBe(true)
  expect(marker?.props.color).toBe('subtle')
})
