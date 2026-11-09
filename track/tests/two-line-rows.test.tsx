// FIXTURE: render descriptions. Requested by Ohad 2026-11-09 after the one-line rows landed:
// "I don't like needed to expend the line with the + sign, let it go down one line if needed but
// not more then that". A folded step or question shows up to two lines; the fold control appears
// only when the text needs a third line, and the second line then ends with an ellipsis.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'
import { wrappedLines } from '../hooks/terminal-text'

const LONG = 'Ohad decision for Codex narrated step 11: may the full suite run four existing unchanged tests that give their own fixture children a temporary home, and keep their names'
const MEDIUM = 'Track pane change: failing test first, implement, Codex review, land live, Ohad checks'
const QLONG = 'Should the narrated explainer keep the full suite run for the four unchanged tests that build their own fixture children, and what happens to their names?'
const QMEDIUM = 'Is S14, the short-title guidance in the Track tools, done and live?'

const ledger = { ...EMPTY, nextQuestionId: 3,
  questions: [
    { id: 1, head: QLONG, at: 1, turnId: 'turn', status: 'open' },
    { id: 2, head: QMEDIUM, at: 2, turnId: 'turn', status: 'open' },
  ],
  steps: [
    { id: 'plan:1', source: 'plan', subject: LONG, status: 'pending' },
    { id: 'plan:2', source: 'plan', subject: MEDIUM, status: 'pending' },
  ],
}

type Drawn = { findAll: (query: { type: 'Text' }) => Promise<{ text?: string }[]> }
const shown = async (ui: Drawn, start: string) => (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').find(t => t.startsWith(start))

for (const width of [30, 80]) {
  test(`a long step and question fold to two lines with the control; expanded shows all (${width} columns)`, async ($, on) => {
    atomStore(on, 'ledger', ledger)
    mock.clock(on)
    const ui = await $.ui.mount(pane('dock', width, 60))
    const step = await ui.find({ key: 's-text-plan:1' })
    const question = await ui.find({ key: 'q-text-1' })
    const stepText = await shown(ui, 'Ohad decision')
    const questionText = await shown(ui, 'Should the narrated')
    expect(stepText?.endsWith('…')).toBe(true)
    expect(questionText?.endsWith('…')).toBe(true)
    expect(wrappedLines(stepText ?? '', Number(step?.props.width))).toBe(2)
    expect(wrappedLines(questionText ?? '', Number(question?.props.width))).toBe(2)

    await ui.press({ key: 'x-s-plan:1' })
    await ui.press({ key: 'x-q-1' })
    expect(await shown(ui, 'Ohad decision')).toBe(LONG)
    expect(await shown(ui, 'Should the narrated')).toBe(QLONG)

    await ui.press({ key: 'x-s-plan:1' })
    await ui.press({ key: 'x-q-1' })
    expect(wrappedLines((await shown(ui, 'Ohad decision')) ?? '', Number(step?.props.width))).toBe(2)
    await ui.unmount()
  })
}

test('a step and a question that need exactly two lines show whole, with no fold control', async ($, on) => {
  atomStore(on, 'ledger', ledger)
  mock.clock(on)
  const ui = await $.ui.mount(pane('dock', 80, 60))
  const step = await ui.find({ key: 's-text-plan:2' })
  const question = await ui.find({ key: 'q-text-2' })
  // Guard the fixture: each text really needs a second line at the drawn width.
  expect(wrappedLines(MEDIUM, Number(step?.props.width))).toBe(2)
  expect(wrappedLines(QMEDIUM, Number(question?.props.width))).toBe(2)
  expect(await shown(ui, 'Track pane change')).toBe(MEDIUM)
  expect(await shown(ui, 'Is S14')).toBe(QMEDIUM)
  expect(await ui.find({ key: 'x-s-plan:2' })).toBeUndefined()
  expect(await ui.find({ key: 'x-q-2' })).toBeUndefined()
  await ui.unmount()
})
