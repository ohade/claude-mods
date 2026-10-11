// FIXTURE, TRACK-21 (2026-10-11): reproduced Refuter findings must fail
// before implementation changes, then pass without changing these checks.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'

const FOREIGN = '11111111-2222-4333-8444-555555555555'
const checkpoint = async ($: any) => JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result))
const question = { id: 1, head: 'acknowledged history', at: 1, status: 'open', turnId: null }

test('TRACK-21 failed resume cannot authorize replacing an existing durable ledger', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  const options = { leaseFailure: 'another loaded Track instance owns this session' }
  const durable = { v: 1, savedAt: 1, ledger: { ...EMPTY, nextQuestionId: 2, questions: [question] } }
  const store = pluginStore(on, { [`s:${SESSION}`]: durable }, undefined, options)
  on('session.id', () => ({ value: SESSION }))
  on('classic.SessionStart', () => ({}))
  logs(on)
  try { await $.classic.SessionStart({ source: 'resume', session_id: SESSION } as never) } catch { /* Expected lease refusal. */ }
  delete options.leaseFailure
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'unverified new row' } as never)
  expect(store.held.get(`s:${SESSION}`)).toEqual(durable)
})

test('TRACK-21 foreign cleanup reserve exhaustion does not block the caller checkpoint', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  const foreign = { v: 1, savedAt: 1, ledger: EMPTY, padding: 'p'.repeat(1486000) }
  const store = pluginStore(on, { [`s:${FOREIGN}`]: foreign }, undefined, { guardStates: { [FOREIGN]: 'closed' } })
  on('session.id', () => ({ value: SESSION }))
  logs(on)
  expect((await checkpoint($)).ok).toBe(true)
  expect((await checkpoint($)).ok).toBe(true)
  expect(store.held.get(`s:${FOREIGN}`)).toEqual(foreign)
  expect(store.held.has(`s:${SESSION}`)).toBe(true)
})

test('TRACK-21 malformed foreign cleanup journal does not block the caller checkpoint', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  const malformed = { v: 9, session_id: FOREIGN, entries: [] }
  const store = pluginStore(on, { [`cleanup:${FOREIGN}`]: malformed })
  on('session.id', () => ({ value: SESSION }))
  logs(on)
  expect((await checkpoint($)).ok).toBe(true)
  expect(store.held.get(`cleanup:${FOREIGN}`)).toEqual(malformed)
  expect(store.held.has(`s:${SESSION}`)).toBe(true)
})

test('TRACK-21 resume recovers its crash-left cleanup journal before reading the missing body', async ($, on) => {
  const resumed = atomStore(on, 'ledger', EMPTY)
  const store = pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('classic.SessionStart', () => ({}))
  logs(on)
  await $.tool.call({ tool: 'mcp__track__track_question', summary: question.head } as never)
  const body = structuredClone(store.held.get(`s:${SESSION}`))
  const head = structuredClone(store.held.get(`h:${SESSION}`))
  store.held.delete(`s:${SESSION}`)
  store.held.set(`cleanup:${SESSION}`, { v: 1, session_id: SESSION, entries: [
    { key: `s:${SESSION}`, before: body }, { key: `h:${SESSION}`, before: head },
  ] })
  // Empty memory represents the restarted session. Keep one state writer.
  resumed.value = EMPTY
  resumed.version++
  await $.classic.SessionStart({ source: 'resume', session_id: SESSION } as never)
  expect(resumed.value.questions.map((row: any) => row.head)).toEqual([question.head])
  expect(store.held.has(`cleanup:${SESSION}`)).toBe(false)
  expect(store.held.get(`s:${SESSION}`)).toEqual(body)
})
