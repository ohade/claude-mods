// FIXTURE pins for the native 2026-10-08 observation: mark_answered can precede
// the final visible response. Thinking/narration is never saved as an answer.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

const prepare = (on: any) => {
  const l = atomStore(on, 'ledger', EMPTY)
  const t = atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, e, next) => next(e))
  return { l, t, store }
}
const response = ($: any, text: string, uuid = '11111111-2222-4333-8444-555555555555') => $.session.append({ door: 'response', uuid, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, origin: { kind: 'model', model: 'fixture' } })
const ask = ($: any) => $.tool.call({ tool: 'mcp__track__track_question', summary: 'What is saved?', tool_use_id: 'question-call' })
const mark = ($: any) => $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'answered', tool_use_id: 'mark-call' })

test('a later actual response binds an already marked answer and is durable before turn end', async ($, on) => {
  const { l, store } = prepare(on)
  await ask($)
  await mark($)
  expect((l.value as any).questions[0].answerText).toBeUndefined()
  await response($, 'תשובה נשמרת 😀')
  const answered = (l.value as any).questions[0]
  expect(answered.answerText).toBe('תשובה נשמרת 😀')
  expect(answered.answerRequestId).toBe('11111111-2222-4333-8444-555555555555')
  expect(answered.answeredBy).toBe('mark-call')
  expect((store.held.get(`s:${SESSION}`) as any).ledger.questions[0].answerText).toBe('תשובה נשמרת 😀')
})

test('pre-question text remains ineligible when the answer is marked before later text', async ($, on) => {
  const { l } = prepare(on)
  await response($, 'Earlier unrelated text')
  await ask($)
  await mark($)
  expect((l.value as any).questions[0].answerText).toBeUndefined()
  await response($, 'The later answer')
  expect((l.value as any).questions[0].answerText).toBe('The later answer')
})

test('a response in another turn cannot bind the old pending answer', async ($, on) => {
  const { l, t } = prepare(on)
  await ask($)
  await mark($)
  t.value = { ...t.value, currentId: 't2' }
  await response($, 'A different turn')
  expect((l.value as any).questions[0].answerText).toBeUndefined()
})

test('an already captured answer is not replaced by a later response', async ($, on) => {
  const { l } = prepare(on)
  await ask($)
  await response($, 'The actual first answer')
  await mark($)
  await response($, 'A later status note')
  expect((l.value as any).questions[0].answerText).toBe('The actual first answer')
})

test('two pending questions cannot guess that the same later response answers both', async ($, on) => {
  const { l } = prepare(on)
  await ask($)
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Another question', tool_use_id: 'second-question' } as never)
  await mark($)
  await $.tool.call({ tool: 'mcp__track__mark_answered', id: 2, status: 'answered', tool_use_id: 'second-mark' } as never)
  await response($, 'An ambiguous later response')
  expect((l.value as any).questions.map((q: any) => q.answerText)).toEqual([undefined, undefined])
  const resolved = await $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'answered', answer_request_id: '11111111-2222-4333-8444-555555555555', tool_use_id: 'verified-mark' } as never)
  expect(resolved.deny).toBeUndefined()
  expect((l.value as any).questions[0].answerText).toBe('An ambiguous later response')
  expect((l.value as any).questions[0].answerRequestId).toBe('11111111-2222-4333-8444-555555555555')
  expect((l.value as any).questions[1].answerText).toBeUndefined()
})

test('an unverified explicit answer source cannot fall back to the latest text', async ($, on) => {
  const { l } = prepare(on)
  await ask($)
  await response($, 'Eligible but not the named source')
  const before = JSON.stringify(l.value)
  const refused = await $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'answered', answer_request_id: '66666666-7777-4888-8999-aaaaaaaaaaaa', tool_use_id: 'unverified-mark' } as never)
  expect(refused.deny).toContain('answer source')
  expect(JSON.stringify(l.value)).toBe(before)
})

test('a repeated answered status preserves the known answer against later status text', async ($, on) => {
  const { l } = prepare(on)
  await ask($)
  await response($, 'The known answer')
  await mark($)
  await response($, 'Later unrelated status')
  await mark($)
  expect((l.value as any).questions[0].answerText).toBe('The known answer')
})
