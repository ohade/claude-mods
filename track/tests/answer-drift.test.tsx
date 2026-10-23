// FIXTURE: TRACK-27, 2026-10-17. Explicit native A markers can correct a saved
// native answer; arbitrary prose and tool-only answers retain their source.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger } from '../types'
import { describeCheckpoint } from '../hooks/checkpoint'
import type { Checkpoint } from '../hooks/checkpoint'

const FIRST_ID = '11111111-2222-4333-8444-555555555555'
const SECOND_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const marked = (text: string, id = 1) => `<!-- A${id}:start -->\n${text}\n<!-- A${id}:end -->`
const response = ($: Engine, text: string, uuid = SECOND_ID, extra: object = {}) => $.session.append({
  door: 'response', uuid, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
  origin: { kind: 'model', model: 'fixture' }, ...extra,
} as never)
const prepare = async ($: Engine, on: On) => {
  const pool = blobPool(on)
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1 })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, e, next) => next(e))
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Which answer is current?', tool_use_id: 'question-call' } as never)
  return { ledger, store, pool }
}

test('later same-id A block replaces stale saved answer; unrelated response does not', async ($, on) => {
  const { ledger, store, pool } = await prepare($, on)
  await response($, marked('The original answer.'), FIRST_ID)
  await $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'answered', tool_use_id: 'acknowledge-native' } as never)
  await response($, marked('The corrected **full** answer.'))
  const answer = ledger.value.questions[0]!
  expect(answer.status).toBe('answered')
  expect(answer.answerText).toBe('The corrected **full** answer.')
  expect(answer.answerRequestId).toBe(SECOND_ID)
  expect(answer.answerKey).toBe('66666666-7777-4888-8999:A1')
  const rawOwnSave = store.held.get(`s:${SESSION}`) as { v?: number } | undefined
  expect(rawOwnSave?.v).toBe(2)
  expect(Object.hasOwn(rawOwnSave!, 'ledger')).toBe(false)
  expect((await pool.logical(store, `s:${SESSION}`) as { ledger: Ledger }).ledger.questions[0]).toEqual(answer)
  await response($, 'A later unrelated status note.', 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff')
  expect(ledger.value.questions[0]).toEqual(answer)
})

test('answer corrections use the full block hash beyond the saved 1000-character prefix', async ($, on) => {
  const { ledger, store, pool } = await prepare($, on)
  const prefix = 'x'.repeat(1200)
  await response($, marked(`${prefix} old ending`), FIRST_ID)
  const old = { ...ledger.value.questions[0] }
  await response($, marked(`${prefix} corrected ending`))
  const answer = ledger.value.questions[0]!
  expect(answer.answerText).toBe(old.answerText)
  expect(answer.answerTextHash).not.toBe(old.answerTextHash)
  expect(answer.answerRequestId).toBe(SECOND_ID)
  expect((await pool.logical(store, `s:${SESSION}`) as { ledger: Ledger }).ledger.questions[0]).toEqual(answer)
})

for (const scenario of ['unrelated-id', 'peer', 'subagent', 'fence', 'quote', 'unchanged'] as const) {
  test(`${scenario} response cannot re-anchor an already saved native answer`, async ($, on) => {
    const { ledger } = await prepare($, on)
    await response($, marked('The original answer.'), FIRST_ID)
    const before = { ...ledger.value.questions[0] }
    const text = scenario === 'fence' ? `\`\`\`markdown\n${marked('Replacement.')}\n\`\`\``
      : scenario === 'quote' ? marked('Replacement.').split('\n').map(line => `> ${line}`).join('\n')
      : marked(scenario === 'unchanged' ? 'The original answer.' : 'Replacement.', scenario === 'unrelated-id' ? 99 : 1)
    await response($, text, SECOND_ID, scenario === 'peer' ? { origin: { kind: 'peer', handle: 'worker' } } : scenario === 'subagent' ? { agentId: 'worker' } : {})
    expect(ledger.value.questions[0]).toEqual(before)
  })
}

test('a tool-only saved answer is never replaced by a later native marker', async ($, on) => {
  const { ledger, store, pool } = await prepare($, on)
  await $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'answered', answer_text: 'Saved tool-only answer', tool_use_id: 'tool-only-answer' } as never)
  const before = { ...ledger.value.questions[0] }
  await response($, marked('A different native answer.'))
  expect(ledger.value.questions[0]).toEqual(before)
  expect((await pool.logical(store, `s:${SESSION}`) as { ledger: Ledger }).ledger.questions[0]).toEqual(before)
})

test('a corrected native answer does not overwrite a concurrently saved unrelated row', async ($, on) => {
  const { ledger, store, pool } = await prepare($, on)
  await response($, marked('Original.'), FIRST_ID)
  const saved = store.held.get(`s:${SESSION}`) as { ledger: Ledger; checkpoint: Checkpoint; generation: string }
  const logical = await pool.logical(store, `s:${SESSION}`) as { ledger: Ledger }
  const concurrent: Ledger = { ...logical.ledger, steps: [
    { session_id: SESSION, id: 'plan:9', source: 'plan', subject: 'Concurrent durable work', status: 'paused' },
  ] }
  const checkpoint = await describeCheckpoint(concurrent, SESSION, saved.checkpoint)
  store.held.set(`s:${SESSION}`, { ...logical, v: 1, ledger: concurrent, checkpoint })
  store.held.set(`h:${SESSION}`, { v: 1, session_id: SESSION, generation: saved.generation, checkpoint })
  await response($, marked('Corrected.'))
  const durable = (await pool.logical(store, `s:${SESSION}`) as { ledger: Ledger }).ledger
  expect(durable.questions[0]?.answerText).toBe('Corrected.')
  expect(durable.steps).toContainEqual(expect.objectContaining({ id: 'plan:9', subject: 'Concurrent durable work', status: 'paused' }))
  expect(ledger.value.questions[0]?.answerText).toBe('Corrected.')
})
