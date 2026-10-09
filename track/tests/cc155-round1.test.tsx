// FIXTURE: CC-155 correction round 1. A native answer on a restored question
// still jumps. Revealed text stacks under the question and stays in the row
// budget. A row carries one digit, and [ A ] is primary only when answered.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, logs, pane } from './kit'

const OLD = '11111111-2222-4333-8444-555555555555'
const BY = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const RESTORED = [1, 2].map(id => ({ id, head: `Question ${id}`, at: 1, turnId: 'restored', status: 'answered', answerText: `Answer ${id} 😀`, restoredFrom: OLD, restoredBy: BY, sourceId: `${OLD}:Q${id}` }))

test('a restored question answered in this session still jumps to its native answer row', async ($, on) => {
  mock.clock(on)
  const q = { id: 1, head: 'Restored question', at: 1, turnId: 'restored', status: 'answered', answerText: 'Live answer', answeredBy: 'toolu_ack', answerKey: 'toolu_ack', answerRequestId: 'toolu_ack', restoredFrom: OLD, restoredBy: BY, sourceId: `${OLD}:Q1` }
  atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 2, questions: [q], restores: [{ by: BY, from: OLD, steps: 0, questions: [q], display: 'user' }] })
  const debug = logs(on)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  expect(debug.filter(line => line.startsWith('track: jump'))).toEqual(['track: jump {"to":{"requestId":"toolu_ack"},"block":"start"}'])
})

test('the revealed text sits under the question, not beside it', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 3, questions: RESTORED, restores: [{ by: BY, from: OLD, steps: 0, questions: RESTORED, display: 'user' }] })
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  expect((await ui.find({ key: 'q-text-1' }))?.props.flexDirection).toBe('column')
})

test('a deferred restored row with saved text puts its digit on one button only', async ($, on) => {
  mock.clock(on)
  const q = { id: 1, head: 'Deferred question', at: 1, turnId: 'restored', status: 'deferred', note: 'later', answerText: 'Partial saved answer', restoredFrom: OLD, restoredBy: BY, sourceId: `${OLD}:Q1` }
  atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 2, questions: [q], restores: [{ by: BY, from: OLD, steps: 0, questions: [q], display: 'user' }] })
  const ui = await $.ui.mount(pane('dock'))
  const hot = [(await ui.find({ key: 'q-1' }))?.props.hotkey, (await ui.find({ key: 'a-1' }))?.props.hotkey].filter(h => h !== undefined)
  expect(hot).toEqual(['1'])
  expect((await ui.find({ key: 'a-1' }))?.props.variant).toBeUndefined()
})

test('a long revealed answer stays inside the questions region or the region shows its down arrow', async ($, on) => {
  mock.clock(on)
  const answer = 'saved '.repeat(80).trim()
  const questions = [
    { id: 1, head: 'First', at: 1, turnId: 'restored', status: 'answered', answerText: answer, restoredFrom: OLD, restoredBy: BY, sourceId: `${OLD}:Q1` },
    { id: 2, head: 'Second', at: 2, turnId: 'restored', status: 'open', restoredFrom: OLD, restoredBy: BY, sourceId: `${OLD}:Q2` },
  ]
  atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 3, questions, restores: [{ by: BY, from: OLD, steps: 0, questions, display: 'user' }] })
  const ui = await $.ui.mount(pane('dock', 36, 12))
  await ui.press({ key: 'a-1' })
  const reveal = String((await ui.find({ key: 'reveal-a-1' }))?.text ?? '')
  const hidden = String((await ui.find({ key: 'questions-hidden' }))?.text ?? '')
  const rows: number[] = []
  for (const id of [1, 2]) if ((await ui.find({ key: `row-q-${id}` })) != null) rows.push(id)
  const above = rows.length === 0 ? 0 : (rows[0] ?? 1) - 1
  const below = rows.length === 0 ? 0 : 2 - (rows[rows.length - 1] ?? 2)
  const want = [above > 0 ? `↑${above}` : '', below > 0 ? `↓${below}` : ''].filter(Boolean).join(' ')
  expect(reveal.endsWith('…')).toBe(true)
  expect(reveal.length).toBeLessThan(answer.length)
  expect(rows).toContain(1)
  expect(hidden).toBe(want)
})
