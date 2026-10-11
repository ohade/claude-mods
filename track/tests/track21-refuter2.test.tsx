// FIXTURE, TRACK-21 (2026-10-11): Refuter-2 reproduced permanent owner
// lockouts. These checks pin recovery and capacity reads before the fix.
import { expect, test } from 'claude-code/testing'
import { describeCheckpoint } from '../hooks/checkpoint'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'

const OTHER = '11111111-2222-4333-8444-555555555555'
const GENERATION = '22222222-3333-4444-8555-666666666666'
const question = { id: 1, head: 'acknowledged history', at: 1, turnId: null, status: 'open' as const }
const checkpoint = async ($: any, session = SESSION) => JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: session } as never)).result))
const version = async (questions: Array<typeof question>, prior?: any) => {
  const ledger = { ...EMPTY, session_id: SESSION, nextQuestionId: questions.length + 1, questions }
  return { v: 1, session_id: SESSION, generation: GENERATION, savedAt: 1, ledger, checkpoint: await describeCheckpoint(ledger, SESSION, prior) }
}

test('TRACK-21 owner repairs a valid next-revision body after a crash before its head write', async ($, on) => {
  const before = await version([question])
  const body = await version([question, { ...question, id: 2, head: 'saved before crash' }], before.checkpoint)
  atomStore(on, 'ledger', EMPTY)
  const store = pluginStore(on, { [`s:${SESSION}`]: body, [`h:${SESSION}`]: { v: 1, session_id: SESSION, generation: GENERATION, checkpoint: before.checkpoint } })
  on('session.id', () => ({ value: SESSION }))
  on('classic.SessionStart', () => ({}))
  logs(on)
  try { await $.classic.SessionStart({ source: 'resume', session_id: SESSION } as never) }
  catch { /* The red implementation refuses the torn pair. */ }
  const receipt = await checkpoint($)
  expect(receipt.ok).toBe(true)
  expect(receipt.revision).toBe(body.checkpoint.revision)
  expect((store.held.get(`s:${SESSION}`) as any).ledger.questions.map((row: any) => row.head)).toEqual(['acknowledged history', 'saved before crash'])
  expect((store.held.get(`h:${SESSION}`) as any).checkpoint).toEqual((store.held.get(`s:${SESSION}`) as any).checkpoint)
})

test('TRACK-21 a failed resume retries after the lease frees without losing durable rows', async ($, on) => {
  const body = await version([question])
  atomStore(on, 'ledger', EMPTY)
  const options = { leaseFailure: 'another loaded Track instance owns this session' }
  const store = pluginStore(on, { [`s:${SESSION}`]: body, [`h:${SESSION}`]: { v: 1, session_id: SESSION, generation: GENERATION, checkpoint: body.checkpoint } }, undefined, options)
  on('session.id', () => ({ value: SESSION }))
  on('classic.SessionStart', () => ({}))
  logs(on)
  try { await $.classic.SessionStart({ source: 'resume', session_id: SESSION } as never) }
  catch { /* Expected lease refusal. */ }
  expect((await checkpoint($)).ok).toBe(false)
  expect(store.held.get(`s:${SESSION}`)).toEqual(body)
  delete (options as { leaseFailure?: string }).leaseFailure
  const receipt = await checkpoint($)
  expect(receipt.ok).toBe(true)
  expect(receipt.revision).toBe(body.checkpoint.revision)
  expect((store.held.get(`s:${SESSION}`) as any).ledger.questions.map((row: any) => row.head)).toEqual(['acknowledged history'])
})

for (const endReason of [undefined, 'other', 'resume']) test(`TRACK-21 switching sessions after ${endReason ?? 'no session.end'} archives old memory and loads the destination`, async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  const store = pluginStore(on)
  let session: string = SESSION
  on('session.id', () => ({ value: session }))
  on('classic.SessionStart', () => ({}))
  on('session.end', () => ({ sessionId: session }))
  logs(on)
  await $.tool.call({ tool: 'mcp__track__track_question', summary: question.head } as never)
  if (endReason !== undefined) await $.session.end({ reason: endReason } as never)
  const original = structuredClone(store.held.get(`s:${SESSION}`))
  session = OTHER
  try { await $.classic.SessionStart({ source: 'resume', session_id: OTHER } as never) }
  catch { /* The red implementation refuses the old memory owner. */ }
  const receipt = await checkpoint($, OTHER)
  expect(receipt.ok).toBe(true)
  expect((store.held.get(`s:${OTHER}`) as any).ledger.questions).toEqual([])
  expect(store.held.get(`s:${SESSION}`)).toEqual(original)
  const archived = [...store.held.entries()].filter(([key]) => key.startsWith(`r:${OTHER}:session-switch-`)).map(([, value]) => value as any)
  expect(archived).toHaveLength(1)
  expect(archived[0].value.source_session).toBe(SESSION)
  expect(archived[0].value.ledger).toEqual((original as any).ledger)
})

test('TRACK-21 repeated caller checkpoints use capacity sizes without rereading unrelated bodies', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  const reads: string[] = []
  const foreign = { v: 1, session_id: OTHER, savedAt: 1, ledger: EMPTY }
  pluginStore(on, { [`s:${OTHER}`]: foreign }, undefined, { beforeGet: key => { reads.push(key) } })
  on('session.id', () => ({ value: SESSION }))
  logs(on)
  expect((await checkpoint($)).ok).toBe(true)
  reads.length = 0
  expect((await checkpoint($)).ok).toBe(true)
  expect(reads.filter(key => key === `s:${OTHER}`)).toEqual([])
})
