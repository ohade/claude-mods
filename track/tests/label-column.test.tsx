// FIXTURE: render descriptions. Requested by Ohad 2026-11-09: the number sits in its own
// left column like a table, "S1 | text" and "Q1 | text", wrapped lines stay under the text,
// and the column keeps room for double digits so rows stay aligned.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const steps = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `plan:${i + 1}`, source: 'plan', subject: `Step text ${i + 1}`, status: 'pending' }))
const questions = [
  { id: 1, head: 'Question text one', at: 1, turnId: 'turn', status: 'open' },
  { id: 2, head: 'Question text two', at: 2, turnId: 'turn', status: 'open' },
]

for (const count of [2, 12]) {
  test(`step and question numbers sit in an aligned left column with room for two digits (${count} steps)`, async ($, on) => {
    atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 3, questions, steps: steps(count) })
    mock.clock(on)
    for (const width of [30, 60]) {
      const ui = await $.ui.mount(pane('dock', width, 40))
      const stepLabels = await Promise.all(steps(count).map(s => ui.find({ key: `s-label-${s.id}` })))
      const questionLabels = await Promise.all(questions.map(q => ui.find({ key: `q-label-${q.id}` })))
      expect(stepLabels.every(found => found !== undefined)).toBe(true)
      expect(questionLabels.every(found => found !== undefined)).toBe(true)
      expect(stepLabels[0]?.text).toMatch(/^S1 +│$/)
      expect(questionLabels[0]?.text).toMatch(/^Q1 +│$/)
      const widths = new Set([...stepLabels, ...questionLabels].map(found => found?.text?.length))
      expect([...widths]).toEqual(['S10 │'.length])
      const texts = (await ui.findAll({ type: 'Text' })).map(row => row.text ?? '')
      expect(texts).toContain('Step text 1')
      expect(texts).toContain('Question text one')
      expect(texts.some(text => /^[SQ]\d+\. /.test(text))).toBe(false)
      await ui.unmount()
    }
  })
}
