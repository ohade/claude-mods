// FIXTURE: 2026-10-08 Q4/Q6/Q7 saved visible progress as their answer.
// The model must identify completed answer content; event order cannot identify its meaning.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pane, pluginStore } from './kit'

const UUID = '11111111-2222-4333-8444-555555555555'
const KEY = '11111111-2222-4333-8444'
const prepare = (on: any) => {
  const clock = mock.clock(on)
  const lines = logs(on)
  const l = atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, e, next) => next(e))
  return { l, store, clock, lines }
}
const response = ($: any, text: string) => $.session.append({ door: 'response', uuid: UUID, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, origin: { kind: 'model', model: 'fixture' } })
const ask = ($: any, summary = 'How does this work?') => $.tool.call({ tool: 'mcp__track__track_question', summary, tool_use_id: `question-${summary}` })
const mark = ($: any, input: object = {}) => $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'answered', tool_use_id: 'answer-call', ...input })

test('unidentified progress cannot close a question or become its saved answer', async ($, on) => {
  const { l } = prepare(on)
  await ask($)
  await response($, 'I have read the code and am preparing the answer.')
  const before = JSON.stringify(l.value)
  const refused = await mark($)
  expect(refused.deny).toContain('answer_text')
  expect(JSON.stringify(l.value)).toBe(before)
  await response($, 'A later status update')
  expect(JSON.stringify(l.value)).toBe(before)
})

test('explicit completed text is durable and uses its call when progress is the latest response', async ($, on) => {
  const { l, store } = prepare(on)
  await ask($)
  await response($, 'I am preparing the answer.')
  const completed = 'The writer lease excludes another live instance. תשובה 😀'
  const result = await mark($, { answer_text: completed })
  expect(result.deny).toBeUndefined()
  const q = (l.value as any).questions[0]
  expect(q.status).toBe('answered')
  expect(q.answerText).toBe(completed)
  expect(q.answerKey).toBe('answer-call')
  expect(q.answerRequestId).toBe('answer-call')
  expect((store.held.get(`s:${SESSION}`) as any).ledger.questions[0]).toEqual(q)
})

test('an exact completed text match keeps the verified native answer target', async ($, on) => {
  const { l } = prepare(on)
  await ask($)
  await response($, 'The completed answer')
  await mark($, { answer_text: 'The completed answer' })
  expect((l.value as any).questions[0].answerKey).toBe(KEY)
  expect((l.value as any).questions[0].answerRequestId).toBe(UUID)
})

test('pre-question text matching the explicit answer cannot grant it an earlier source', async ($, on) => {
  const { l } = prepare(on)
  await response($, 'Same words')
  await ask($)
  await mark($, { answer_text: 'Same words' })
  expect((l.value as any).questions[0].answerKey).toBe('answer-call')
  expect((l.value as any).questions[0].answerRequestId).not.toBe(UUID)
})

test('a named native answer with different words is refused without mutation', async ($, on) => {
  const { l } = prepare(on)
  await ask($)
  await response($, 'Progress text')
  const before = JSON.stringify(l.value)
  const refused = await mark($, { answer_request_id: UUID, answer_text: 'Different completed answer' })
  expect(refused.deny).toContain('answer text')
  expect(JSON.stringify(l.value)).toBe(before)
})

test('blank explicit text cannot fall back to progress', async ($, on) => {
  const { l } = prepare(on)
  await ask($)
  await response($, 'Progress text')
  const before = JSON.stringify(l.value)
  const refused = await mark($, { answer_text: '   ' })
  expect(refused.deny).toContain('answer_text')
  expect(JSON.stringify(l.value)).toBe(before)
})

test('two questions retain separate completed answers despite the same latest progress', async ($, on) => {
  const { l, store } = prepare(on)
  await ask($, 'Who owns the writer?')
  await ask($, 'Which rows are pruned?')
  await response($, 'I am sending two separate answers.')
  await mark($, { answer_text: 'A live lease owns the writer.' })
  await mark($, { id: 2, tool_use_id: 'second-answer', answer_text: 'Cleared and completed rows are pruned first.' })
  await response($, 'Both answers were sent.')
  const q = (l.value as any).questions
  expect(q.map((one: any) => one.answerText)).toEqual(['A live lease owns the writer.', 'Cleared and completed rows are pruned first.'])
  expect(q.map((one: any) => one.answerKey)).toEqual(['answer-call', 'second-answer'])
  expect((store.held.get(`s:${SESSION}`) as any).ledger.questions).toEqual(q)
})

test('a call-sourced A jump highlights its completed answer separately from the acknowledgement', async ($, on) => {
  const { clock, lines } = prepare(on)
  await ask($)
  await response($, 'I am preparing the answer.')
  await mark($, { answer_text: 'The completed answer 😀' })
  const answer = await $.ui.mount({ plugin: 'track', surface: 'terminal', component: 'ToolUse', requestId: 'answer-call', props: { tool: 'mcp__track__mark_answered', tool_use_id: 'answer-call', input: { id: 1, status: 'answered', answer_text: 'The completed answer 😀' } } } as never)
  await clock.advance(0)
  expect((await answer.findAll({ type: 'Text' })).map(one => String(one.text ?? '')).join('\n')).toContain('The completed answer 😀')
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  expect(lines).toContain('track: jump {"to":{"key":"answer:answer-call"},"block":"start"}')
  const target = await answer.find({ key: 'answer:answer-call' })
  expect(target?.props.backgroundColor).toBeDefined()
  expect(target?.text).toBe('The completed answer 😀')
  expect(target?.text).not.toContain('✓ Q1. answered')
})

test('a verified response id remains an explicit alternative to sending its text again', async ($, on) => {
  const { l } = prepare(on)
  await ask($)
  await response($, 'A completed native answer')
  const result = await mark($, { answer_request_id: UUID })
  expect(result.deny).toBeUndefined()
  expect((l.value as any).questions[0].answerText).toBe('A completed native answer')
  expect((l.value as any).questions[0].answerKey).toBe(KEY)
})
