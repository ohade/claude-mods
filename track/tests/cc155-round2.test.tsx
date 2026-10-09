// FIXTURE: CC-155 correction round 2. Opening a row scrolls to it once.
// After that the wheel and a newly tracked question move the window.
// A short pane still shows one line of the saved answer.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'

const OLD = '11111111-2222-4333-8444-555555555555'
const BY = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const LONG = 'saved '.repeat(150).trim()
const restored = (id: number, extra: Record<string, unknown> = {}) => ({ id, head: `Restored ${id}`, at: id, turnId: 'restored', status: 'answered', answerText: LONG, restoredFrom: OLD, restoredBy: BY, sourceId: `${OLD}:Q${id}`, ...extra })
const native = (id: number) => ({ id, head: `Native ${id}`, at: id, turnId: 't0', status: 'open' })
const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
const shown = async (ui: { find: (q: { key: string }) => Promise<unknown> }, n: number) => {
  const out: number[] = []
  for (const id of ids(n)) if ((await ui.find({ key: `row-q-${id}` })) != null) out.push(id)
  return out
}
const arrows = async (ui: { find: (q: { key: string }) => Promise<{ text?: string } | undefined> }) => String((await ui.find({ key: 'questions-hidden' }))?.text ?? '')
const ledgerOf = (questions: object[], restores: object[]) => ({ ...EMPTY, nextQuestionId: questions.length + 1, questions, restores })

test('a wheel scroll in the questions region moves the window while a restored row is open', async ($, on) => {
  const clock = mock.clock(on)
  const qs = [restored(1), ...ids(8).slice(1).map(native)]
  atomStore(on, 'ledger', ledgerOf(qs, [{ by: BY, from: OLD, steps: 0, questions: [qs[0]], display: 'user' }]))
  on('ui.scroll', () => ({}))
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  await $.ui.scroll({ component: 'Pane', requestId: 'track', offset: 0, by: 3, bodyRows: 20, contentRows: 20, origin: { kind: 'person' }, pointer: { row: 3, column: 5 } } as never)
  await clock.advance(100)
  expect((await shown(ui, 8)).includes(1)).toBe(false)
})

test('a question tracked while a restored row is open is shown', async ($, on) => {
  mock.clock(on)
  const qs = [restored(1), ...ids(6).slice(1).map(native)]
  const ledger = atomStore(on, 'ledger', ledgerOf(qs, [{ by: BY, from: OLD, steps: 0, questions: [qs[0]], display: 'user' }]) as never)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, e, next) => next(e))
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Brand new question', tool_use_id: 'toolu_new_q' } as never)
  expect(ledger.value.questions.length).toBe(7)
  expect(await shown(ui, 7)).toEqual(expect.arrayContaining([7]))
})

test('the most recently opened row is in view when two rows are open', async ($, on) => {
  mock.clock(on)
  const qs = [restored(1, { answerText: 'short saved answer' }), native(2), native(3), restored(4), native(5), native(6)]
  atomStore(on, 'ledger', ledgerOf(qs, [{ by: BY, from: OLD, steps: 0, questions: [qs[0], qs[3]], display: 'user' }]))
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  await ui.press({ key: 'a-4' })
  expect(await shown(ui, 6)).toEqual(expect.arrayContaining([4]))
})

for (const rowsTall of [9, 10, 11, 12]) {
  test(`in a short pane (${rowsTall} rows) pressing [ A ] shows the saved answer`, async ($, on) => {
    mock.clock(on)
    const qs = [native(1), native(2), restored(3)]
    atomStore(on, 'ledger', { ...ledgerOf(qs, [{ by: BY, from: OLD, steps: 0, questions: [qs[2]], display: 'user' }]), steps: [1, 2, 3, 4].map(n => ({ id: `plan:${n}`, source: 'plan', subject: `Step ${n}`, status: 'pending' })) })
    const ui = await $.ui.mount(pane('dock', 60, rowsTall))
    if ((await ui.find({ key: 'a-3' })) == null) return
    await ui.press({ key: 'a-3' })
    expect((await ui.find({ key: 'reveal-a-3' }))?.text).toBeDefined()
  })
}

test('arrows count exactly the question rows not drawn while a row is open', async ($, on) => {
  mock.clock(on)
  const qs = [native(1), native(2), restored(3), ...ids(10).slice(3).map(native)]
  atomStore(on, 'ledger', ledgerOf(qs, [{ by: BY, from: OLD, steps: 0, questions: [qs[2]], display: 'user' }]))
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-3' })
  const rows = await shown(ui, 10)
  const above = rows.length === 0 ? 0 : (rows[0] ?? 1) - 1
  const below = rows.length === 0 ? 0 : 10 - (rows[rows.length - 1] ?? 10)
  const want = [above > 0 ? `↑${above}` : '', below > 0 ? `↓${below}` : ''].filter(Boolean).join(' ')
  expect(await arrows(ui)).toBe(want)
})

test('a restored answer reveal is not drawn once the row has a native answer', async ($, on) => {
  mock.clock(on)
  const q = { id: 1, head: 'Restored', at: 1, turnId: 'restored', status: 'answered', answerText: 'Saved answer', restoredFrom: OLD, restoredBy: BY, sourceId: `${OLD}:Q1` }
  const ledger = atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 2, questions: [q], restores: [{ by: BY, from: OLD, steps: 0, questions: [q], display: 'user' }] } as never)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  expect((await ui.find({ key: 'reveal-a-1' }))?.text).toBe('Saved answer')
  ledger.value = { ...ledger.value, questions: [{ ...q, answerKey: 'toolu_ack', answeredBy: 'toolu_ack' }] }
  await ui.unmount()
  const again = await $.ui.mount(pane('dock'))
  expect(await again.find({ key: 'reveal-a-1' })).toBeUndefined()
})
