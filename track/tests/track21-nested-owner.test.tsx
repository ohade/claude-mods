// FIXTURE, TRACK-21 (2026-10-11): parsing must not erase a conflicting
// nested owner before resume, stale-save reconciliation, or rewind validation.
import { expect, test } from 'claude-code/testing'
import { describeCheckpoint } from '../hooks/checkpoint'
import { EMPTY, SESSION, atomStore, logs, pluginStore, trackPrompt } from './kit'

const FOREIGN = '11111111-2222-4333-8444-555555555555'
const question = { id: 1, head: 'saved question', at: 1, turnId: null, status: 'open' as const }
const checkpoint = async ($: any) => JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result))

const conflictingLedgers = [
  ['ledger', { ...EMPTY, session_id: FOREIGN }],
  ['prompt', { ...EMPTY, prompts: [{ rowKey: 'prompt', head: 'saved prompt', at: 1, turnId: null, session_id: FOREIGN }] }],
  ['question', { ...EMPTY, nextQuestionId: 2, questions: [{ ...question, session_id: FOREIGN }] }],
  ['step', { ...EMPTY, steps: [{ id: 'plan:1', source: 'plan', subject: 'saved step', status: 'pending', session_id: FOREIGN }] }],
  ['withdrawal', { ...EMPTY, nextQuestionId: 2, withdrawn: [{ id: 1, head: 'withdrawn question', session_id: FOREIGN }] }],
  ['restore', { ...EMPTY, nextQuestionId: 2, questions: [question], restores: [{ by: 'restore-call', from: SESSION, steps: 0, questions: [question], session_id: FOREIGN }] }],
  ['archived question', { ...EMPTY, nextQuestionId: 2, questions: [question], restores: [{ by: 'restore-call', from: SESSION, steps: 0, questions: [{ ...question, session_id: FOREIGN }] }] }],
] as const

for (const [kind, conflicting] of conflictingLedgers) test(`TRACK-21 resume refuses a conflicting ${kind} owner before parsing`, async ($, on) => {
  const memory = atomStore(on, 'ledger', EMPTY)
  const body = { v: 1, session_id: SESSION, savedAt: 1, ledger: conflicting }
  const store = pluginStore(on, { [`s:${SESSION}`]: body })
  on('session.id', () => ({ value: SESSION }))
  on('classic.SessionStart', () => ({}))
  logs(on)
  try { await $.classic.SessionStart({ source: 'resume', session_id: SESSION } as never) }
  catch { /* Refusing the conflicting owner is expected. */ }
  const receipt = await checkpoint($)
  expect(receipt.ok).toBe(false)
  expect(receipt.reason).toContain('identity')
  expect(memory.value).toEqual(EMPTY)
  expect(store.held.get(`s:${SESSION}`)).toEqual(body)
})

test('TRACK-21 stale save keeps a newer body with a conflicting nested owner byte-identical', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  const store = pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  logs(on)
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'acknowledged local row' } as never)
  const saved = store.held.get(`s:${SESSION}`) as any
  const newerLedger = { ...saved.ledger, nextQuestionId: 3, questions: [...saved.ledger.questions, { ...question, id: 2, session_id: FOREIGN }] }
  const newerCheckpoint = await describeCheckpoint(newerLedger, SESSION, saved.checkpoint)
  const body = { ...saved, ledger: newerLedger, checkpoint: newerCheckpoint }
  const head = { ...(store.held.get(`h:${SESSION}`) as any), checkpoint: newerCheckpoint }
  store.held.set(`s:${SESSION}`, body)
  store.held.set(`h:${SESSION}`, head)
  const receipt = await checkpoint($)
  expect(receipt.ok).toBe(false)
  expect(receipt.reason).toContain('identity')
  expect(store.held.get(`s:${SESSION}`)).toEqual(body)
  expect(store.held.get(`h:${SESSION}`)).toEqual(head)
})

test('TRACK-21 rewind cannot adopt a durable question whose conflicting owner was parsed away', async ($, on) => {
  const row = { ...question, trackedBy: 'rewound-call' }
  const local = { ...EMPTY, nextQuestionId: 2, questions: [row] }
  atomStore(on, 'ledger', local)
  const body = { v: 1, session_id: SESSION, savedAt: 1, ledger: { ...local, questions: [{ ...row, session_id: FOREIGN }] } }
  const store = pluginStore(on, { [`s:${SESSION}`]: body })
  on('session.id', () => ({ value: SESSION }))
  on('session.messages', () => ({ value: [] }))
  const proceeded = { count: 0 }
  on('prompt.submit', (_, e) => { proceeded.count++; return { text: e.text, context: e.context } })
  logs(on)
  const result = await trackPrompt($, 'status')
  expect(proceeded.count).toBe(0)
  expect(result.drop).toContain('rewind')
  expect(store.held.get(`s:${SESSION}`)).toEqual(body)
})
