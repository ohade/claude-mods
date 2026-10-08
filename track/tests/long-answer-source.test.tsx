// FIXTURE: bounded saved words must not reject a correct full native answer,
// or grant a source to different full words that share the saved prefix.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

const UUID = '11111111-2222-4333-8444-555555555555'
const KEY = '11111111-2222-4333-8444'
const PREFIX = 'ת😀'.repeat(600)
const ANSWER = PREFIX + ' completed answer'
const OTHER = PREFIX + ' different answer'
const SAVED = Array.from(ANSWER).slice(0, 999).join('') + '…'
const prepare = async ($: any, on: any) => {
  const l = atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, e, next) => next(e))
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'A long answer?', tool_use_id: 'question-call' })
  return l
}
const response = ($: any, text: string) => $.session.append({ door: 'response', uuid: UUID, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, origin: { kind: 'model', model: 'fixture' } })
const mark = ($: any, input: object = {}) => $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'answered', answer_text: ANSWER, tool_use_id: 'answer-call', ...input })

test('correct long completed text and a verified native id agree despite the save cap', async ($, on) => {
  const l = await prepare($, on)
  await response($, ANSWER)
  expect((await mark($, { answer_request_id: UUID })).deny).toBeUndefined()
  expect((l.value as any).questions[0].answerText).toBe(SAVED)
  expect((l.value as any).questions[0].answerKey).toBe(KEY)
})

test('an exact long completed answer finds its native source without repeating its id', async ($, on) => {
  const l = await prepare($, on)
  await response($, ANSWER)
  await mark($)
  expect((l.value as any).questions[0].answerKey).toBe(KEY)
  expect((l.value as any).questions[0].answerText).toBe(SAVED)
})

test('a matching capped prefix cannot validate different completed words with a native id', async ($, on) => {
  const l = await prepare($, on)
  await response($, OTHER)
  const before = JSON.stringify(l.value)
  expect((await mark($, { answer_request_id: UUID })).deny).toContain('answer text')
  expect(JSON.stringify(l.value)).toBe(before)
})

test('a later response with the same capped prefix cannot steal an explicit answer target', async ($, on) => {
  const l = await prepare($, on)
  await mark($)
  await response($, OTHER)
  expect((l.value as any).questions[0].answerKey).toBe('answer-call')
  expect((l.value as any).questions[0].answerRequestId).toBe('answer-call')
})

test('a later full match can reanchor a long explicit answer while keeping its bounded words', async ($, on) => {
  const l = await prepare($, on)
  await mark($)
  await response($, ANSWER)
  expect((l.value as any).questions[0].answerKey).toBe(KEY)
  expect((l.value as any).questions[0].answerText).toBe(SAVED)
})
