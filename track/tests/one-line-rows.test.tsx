// FIXTURE: render descriptions. Requested by Ohad 2026-11-09: rows were too long to read
// ("it needs to be more bullet length"). With Codex: each step and question shows one line, cut
// with an ellipsis, and an explicit control shows the whole text and folds it back.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'
import { wrappedLines } from '../hooks/terminal-text'

const LONG = 'Ohad decision for Codex narrated step 11: may the full suite run four existing unchanged tests that give their own fixture children a temporary home'
const SHORT = 'Short step'
const QLONG = 'Should the narrated explainer keep the full suite run for the four unchanged tests that build their own fixture children?'

const ledger = { ...EMPTY, nextQuestionId: 2,
  questions: [{ id: 1, head: QLONG, at: 1, turnId: 'turn', status: 'open' }],
  steps: [
    { id: 'plan:1', source: 'plan', subject: LONG, status: 'pending' },
    { id: 'plan:2', source: 'plan', subject: SHORT, status: 'pending' },
  ],
}

type Drawn = { findAll: (query: { type: 'Text' }) => Promise<{ text?: string }[]> }
const shown = async (ui: Drawn, start: string) => (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').find(t => t.startsWith(start))

for (const width of [30, 80]) {
  test(`a long step and a long question show one line until expanded, then fold back (${width} columns)`, async ($, on) => {
    atomStore(on, 'ledger', ledger)
    mock.clock(on)
    const ui = await $.ui.mount(pane('dock', width, 40))
    const step = await ui.find({ key: 's-text-plan:1' })
    const question = await ui.find({ key: 'q-text-1' })
    const stepText = await shown(ui, 'Ohad decision')
    const questionText = await shown(ui, 'Should the narrated')
    expect(stepText?.endsWith('…')).toBe(true)
    expect(questionText?.endsWith('…')).toBe(true)
    expect(wrappedLines(stepText ?? '', Number(step?.props.width))).toBe(1)
    expect(wrappedLines(questionText ?? '', Number(question?.props.width))).toBe(1)
    expect(await ui.find({ key: 'x-s-plan:2' })).toBeUndefined()
    expect(await shown(ui, SHORT)).toBe(SHORT)

    await ui.press({ key: 'x-s-plan:1' })
    await ui.press({ key: 'x-q-1' })
    expect(await shown(ui, 'Ohad decision')).toBe(LONG)
    expect(await shown(ui, 'Should the narrated')).toBe(QLONG)

    await ui.press({ key: 'x-s-plan:1' })
    await ui.press({ key: 'x-q-1' })
    expect((await shown(ui, 'Ohad decision'))?.endsWith('…')).toBe(true)
    expect((await shown(ui, 'Should the narrated'))?.endsWith('…')).toBe(true)
    await ui.unmount()
  })
}

test('the step region budgets one line per folded row, so eight long steps all fit a short pane', async ($, on) => {
  atomStore(on, 'ledger', { ...EMPTY, steps: Array.from({ length: 8 }, (_, i) => ({ id: `plan:${i + 1}`, source: 'plan', subject: `${i + 1} ${LONG}`, status: 'pending' })) })
  mock.clock(on)
  const ui = await $.ui.mount(pane('dock', 80, 22))
  const rows = await Promise.all(Array.from({ length: 8 }, (_, i) => ui.find({ key: `row-s-plan:${i + 1}` })))
  expect(rows.filter(row => row !== undefined)).toHaveLength(8)
  await ui.unmount()
})
