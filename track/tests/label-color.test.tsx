// FIXTURE: render descriptions. Requested by Ohad 2026-11-09: the S<n> and Q<n> numbers use one
// bold color of their own, not red, and keep it whatever the row's status color is.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, cell, pane } from './kit'

const steps = [
  { id: 'plan:1', source: 'plan', subject: 'Done step', status: 'completed', resultText: 'Done.' },
  { id: 'plan:2', source: 'plan', subject: 'Working step', status: 'in_progress' },
  { id: 'plan:3', source: 'plan', subject: 'Waiting step', status: 'waiting' },
  { id: 'plan:4', source: 'plan', subject: 'Pending step', status: 'pending' },
]
const questions = [
  { id: 1, head: 'Answered question', at: 1, turnId: 'turn', status: 'answered', answerText: 'Yes.' },
  { id: 2, head: 'Open question', at: 2, turnId: 'turn', status: 'open' },
]

test('every number label is bold in the same non-red color whatever its row status', async ($, on) => {
  atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 3, questions, steps })
  mock.clock(on)
  for (const width of [30, 80]) {
    const ui = await $.ui.mount(pane('dock', width, 40))
    const texts = await ui.findAll({ type: 'Text' })
    const labels = ['S1', 'S2', 'S3', 'S4', 'Q1', 'Q2'].map(label => texts.find(t => t.text === cell(label)))
    expect(labels.every(found => found !== undefined)).toBe(true)
    const looks = new Set(labels.map(found => JSON.stringify({ color: found?.props.color, bold: found?.props.bold })))
    expect([...looks]).toEqual([JSON.stringify({ color: 'merged', bold: true })])
    await ui.unmount()
  }
})
