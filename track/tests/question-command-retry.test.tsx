// FIXTURE: U2 must keep decisions and Date.now sampling inside native CAS retries.
// mock.clock controls $.clock, not Date.now. Host timers bound fixture orchestration.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Question } from '../types'

const RESPONSE = '11111111-2222-4333-8444-555555555555'
const OTHER = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const question = (id: number, extra: Partial<Question> = {}): Question => ({ id, head: `Question ${id}`, at: id, turnId: 't1', trackedOrder: 1, status: 'open', session_id: SESSION, ...extra })
const state = (questions: Question[] = []): Ledger => ({ ...EMPTY, session_id: SESSION, nextQuestionId: questions.length + 1, questions })
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never)
const response = ($: Engine, text: string) => $.session.append({ door: 'response', uuid: RESPONSE, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, origin: { kind: 'model', model: 'fixture' } } as never)

const prepare = (on: On, initial: Ledger, eligible: (proposal: Ledger) => boolean, competing: (current: Ledger) => Ledger) => {
  let held: ReturnType<typeof atomStore<Ledger>>
  const probe = { injected: false, releasedAt: 0, rejectedAt: 0 }
  on('state.set', { plugin: 'track', key: ['ledger'] }, async (_, event, next) => {
    if (!probe.injected && eligible(event.value as Ledger)) {
      probe.injected = true
      probe.rejectedAt = Date.now()
      const timers = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }
      await new Promise<void>(resolve => { timers.setTimeout(resolve, 25) })
      held.value = competing(held.value)
      held.version++
      probe.releasedAt = Date.now()
    }
    return next(event)
  })
  held = atomStore(on, 'ledger', initial)
  const turn = atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 4 })
  mock.clock(on)
  mock.env(on, { CLAUDE_CONFIG_DIR: '/fixture/config' })
  const store = pluginStore(on)
  const pool = blobPool(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, event, next) => next(event))
  on('ui.log', () => ({ value: undefined }))
  return { held, turn, probe, store, pool }
}
const durableWrites = (timeline: string[]) => timeline.filter(event => event === `set:s:${SESSION}` || event === `set:h:${SESSION}`)

test('U2 question mint retries current ID/source/time while reserving event order once', async ($, on) => {
  const other = question(2, { head: 'Other writer' })
  const source = { rowKey: 'source-row', requestId: 'source-request', head: 'Source on retry', turnId: 't1', at: 5, session_id: SESSION }
  const { held, turn, probe, store, pool } = prepare(on, state(), proposal => proposal.questions.some(row => row.head === 'Retry question'), current => ({ ...current, nextQuestionId: 3, questions: [other], prompts: [source] }))
  const result = await call($, { tool: 'mcp__track__track_question', summary: 'Retry question', source_text: 'Source on retry', tool_use_id: 'retry-track' })
  expect(result.deny).toBeUndefined()
  expect(String(result.result)).toContain('Tracked as Q3:')
  expect(probe.injected).toBe(true)
  expect(probe.releasedAt).toBeGreaterThan(probe.rejectedAt)
  const minted = held.value.questions.find(row => row.id === 3)!
  expect(minted).toMatchObject({ id: 3, head: 'Retry question', rowKey: 'source-row', askedRequestId: 'source-request', trackedBy: 'retry-track', turnId: 't1', trackedOrder: 5 })
  expect(minted.at).toBeGreaterThanOrEqual(probe.releasedAt)
  expect(held.value.nextQuestionId).toBe(4)
  expect(turn.value.eventOrder).toBe(5)
  expect(held.value.questions.find(row => row.id === 2)).toEqual(other)
  expect((await pool.logical(store, `s:${SESSION}`) as { ledger: Ledger }).ledger.questions).toEqual(held.value.questions)
})

test('U2 question capacity is rechecked after a losing creation attempt', async ($, on) => {
  const currentRows = Array.from({ length: 200 }, (_, index) => question(index + 1))
  const { held, turn, probe } = prepare(on, state(), proposal => proposal.questions.some(row => row.head === 'Retry question'), current => ({ ...current, questions: currentRows, nextQuestionId: 201 }))
  const result = await call($, { tool: 'mcp__track__track_question', summary: 'Retry question', tool_use_id: 'capacity-track' })
  expect(result.deny).toBe('track: question capacity reached; unfinished work was kept.')
  expect(probe.injected).toBe(true)
  expect(held.value.questions).toEqual(currentRows)
  expect(held.value.nextQuestionId).toBe(201)
  expect(turn.value.eventOrder).toBe(5)
})

test('U2 explicit mark retries its clock after an unrelated ledger write', async ($, on) => {
  const { held, probe, store, pool } = prepare(on, state([question(1)]), proposal => proposal.questions[0]?.answerText === 'Completed answer', current => ({ ...current, nextQuestionId: 9 }))
  await call($, { tool: 'mcp__track__mark_answered', id: 1, status: 'answered', answer_text: 'Completed answer', tool_use_id: 'mark-clock' })
  expect(probe.injected).toBe(true)
  expect(probe.releasedAt).toBeGreaterThan(probe.rejectedAt)
  expect(held.value.questions[0]!.answeredAt!).toBeGreaterThanOrEqual(probe.releasedAt)
  expect(held.value.questions[0]).toMatchObject({ answerText: 'Completed answer', answeredBy: 'mark-clock' })
  expect(held.value.nextQuestionId).toBe(9)
  expect((await pool.logical(store, `s:${SESSION}`) as { ledger: Ledger }).ledger.questions[0]).toEqual(held.value.questions[0])
})

test('U2 a losing explicit mark preserves the current acknowledged answer byte for byte', async ($, on) => {
  const winner = question(1, { status: 'answered', answerText: 'Acknowledged winner', answeredAt: 600, answeredBy: 'winner-call', answerRequestId: 'winner-call', answerKey: 'winner-call' })
  const { held, probe, store, pool } = prepare(on, state([question(1)]), proposal => proposal.questions[0]?.answerText === 'Delayed answer', current => ({ ...current, questions: [winner] }))
  await call($, { tool: 'mcp__track__mark_answered', id: 1, status: 'answered', answer_text: 'Delayed answer', tool_use_id: 'delayed-call' })
  expect(probe.injected).toBe(true)
  expect(JSON.stringify(held.value.questions[0])).toBe(JSON.stringify(winner))
  expect((await pool.logical(store, `s:${SESSION}`) as { ledger: Ledger }).ledger.questions[0]).toEqual(winner)
})

test('U2 marker capture retries its clock and keeps the selected native block identity', async ($, on) => {
  const { held, probe, store, pool } = prepare(on, state([question(1)]), proposal => proposal.questions[0]?.answerText === 'Marker answer', current => ({ ...current, nextQuestionId: 9 }))
  await response($, '<!-- A1:start -->\nMarker answer\n<!-- A1:end -->')
  expect(probe.injected).toBe(true)
  expect(probe.releasedAt).toBeGreaterThan(probe.rejectedAt)
  expect(held.value.questions[0]!.answeredAt!).toBeGreaterThanOrEqual(probe.releasedAt)
  expect(held.value.questions[0]).toMatchObject({ status: 'answered', answerText: 'Marker answer', answerRequestId: RESPONSE, answerKey: '11111111-2222-4333-8444:A1', answerMarker: { turnId: 't1', order: 5 } })
  expect(held.value.nextQuestionId).toBe(9)
  expect((await pool.logical(store, `s:${SESSION}`) as { ledger: Ledger }).ledger.questions[0]).toEqual(held.value.questions[0])
})

test('U2 a rejected marker proposal resets changed and does not save the competing row', async ($, on) => {
  const winner = question(1, { status: 'answered', answerText: 'Later marker wins', answerTextHash: 'winner-hash', answerRequestId: OTHER, answerKey: '66666666-7777-4888-8999:A1', answerMarker: { turnId: 't1', order: 99 }, answeredAt: 600 })
  const { held, probe, store } = prepare(on, state([question(1)]), proposal => proposal.questions[0]?.answerText === 'Marker answer', current => ({ ...current, questions: [winner] }))
  const start = store.locks.timeline.length
  await response($, '<!-- A1:start -->\nMarker answer\n<!-- A1:end -->')
  expect(probe.injected).toBe(true)
  expect(held.value.questions[0]).toEqual(winner)
  expect(durableWrites(store.locks.timeline.slice(start))).toEqual([])
})

test('U2 a rejected answer rebind resets changed when the current row no longer matches', async ($, on) => {
  const initial = question(1, { status: 'answered', answerText: 'Binding answer', answerTurnId: 't1', answerOrder: 0, answerKey: 'mark-call', answeredBy: 'mark-call' })
  const winner = question(1, { status: 'answered', answerText: 'Other writer answer', answerTextHash: 'other-hash', answerRequestId: OTHER, answerKey: 'other-row', answeredBy: 'other-call' })
  const { held, probe, store } = prepare(on, state([initial]), proposal => proposal.questions[0]?.answerRequestId === RESPONSE, current => ({ ...current, questions: [winner] }))
  const start = store.locks.timeline.length
  await response($, 'Binding answer')
  expect(probe.injected).toBe(true)
  expect(held.value.questions[0]).toEqual(winner)
  expect(durableWrites(store.locks.timeline.slice(start))).toEqual([])
})
