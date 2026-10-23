// FIXTURE: 2026-10-12 review found marker answers reopened on a normal prompt.
// The transcript API supplies text and tool IDs, but no response UUIDs.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, pluginStore } from './kit'
import type { On } from './kit'

const UUID = '15151515-2222-4333-8444-555555555555'
const BODY = '**Complete answer:** existing deals only.'
const marked = (body = BODY) => `<!-- A25:start -->\n${body}\n<!-- A25:end -->`
const prepare = (on: On) => {
  const ledger = atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 25 })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on)
  const pool = blobPool(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, e, next) => next(e))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  const transcript = { rows: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'ask-25', tool: 'mcp__track__track_question', input: { summary: 'Question 25' } }] }] as any[] }
  on('session.messages', () => ({ value: transcript.rows }))
  return { ledger, store, pool, transcript }
}
const capture = async ($: any) => {
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Question 25', tool_use_id: 'ask-25' })
  await $.session.append({ door: 'response', uuid: UUID, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: marked() }] }, origin: { kind: 'model', model: 'fixture' } })
}

test('a marker answer survives a normal prompt when its full block remains', async ($, on) => {
  const { ledger, store, pool, transcript } = prepare(on)
  await capture($)
  const answered = (ledger.value as any).questions[0]
  expect(answered.status).toBe('answered')
  transcript.rows.push({ role: 'assistant', text: marked(), toolUses: [] })
  await $.prompt.submit({ text: 'Continue.', origin: { kind: 'composer' } } as never)
  expect((ledger.value as any).questions[0]).toEqual(answered)
  const rawOwnSave = store.held.get(`s:${SESSION}`) as { v?: number } | undefined
  expect(rawOwnSave?.v).toBe(2)
  expect(Object.hasOwn(rawOwnSave!, 'ledger')).toBe(false)
  expect((await pool.logical(store, `s:${SESSION}`) as any).ledger.questions[0]).toEqual(answered)
})

test('rewinding the marker response reopens its surviving question durably', async ($, on) => {
  const { ledger, store, pool } = prepare(on)
  await capture($)
  await $.prompt.submit({ text: 'Continue.', origin: { kind: 'composer' } } as never)
  const q = (ledger.value as any).questions[0]
  expect(q.status).toBe('open')
  expect(q.answerText).toBeUndefined()
  expect(q.answerKey).toBeUndefined()
  expect((await pool.logical(store, `s:${SESSION}`) as any).ledger.questions[0]).toEqual(q)
})

test('a different answer with the same marker id cannot preserve removed words', async ($, on) => {
  const { ledger, transcript } = prepare(on)
  await capture($)
  transcript.rows.push({ role: 'assistant', text: marked('Different words.'), toolUses: [] })
  await $.prompt.submit({ text: 'Continue.', origin: { kind: 'composer' } } as never)
  expect((ledger.value as any).questions[0].status).toBe('open')
})

test('compaction keeps a marker answer whose old response is no longer readable', async ($, on) => {
  const { ledger } = prepare(on)
  await capture($)
  const answered = (ledger.value as any).questions[0]
  ledger.value = { ...ledger.value, compactedAt: answered.answeredAt + 1 } as any
  await $.prompt.submit({ text: 'Continue.', origin: { kind: 'composer' } } as never)
  expect((ledger.value as any).questions[0]).toEqual(answered)
})
