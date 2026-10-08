// FIXTURE: render descriptions. Requested 2026-10-08: put a dot after Q<n>
// and S<n> so the label is separate from the sentence.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

test('question and step labels have a dot in wide and narrow panes', async ($, on) => {
  atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 2,
    questions: [{ id: 1, head: 'Question text', at: 1, turnId: 'turn', status: 'open' }],
    steps: [{ id: 'plan:1', source: 'plan', subject: 'Step text', status: 'pending' }],
  })
  mock.clock(on)
  for (const width of [30, 60]) {
    const ui = await $.ui.mount(pane('dock', width, 30))
    const texts = (await ui.findAll({ type: 'Text' })).map(row => row.text)
    expect(texts.some(text => text.startsWith('Q1. Question'))).toBe(true)
    expect(texts.some(text => text.startsWith('S1. Step'))).toBe(true)
    await ui.unmount()
  }
})
