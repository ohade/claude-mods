import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

const FOREIGN = '00000000-0000-4000-8000-000000000001'
const WEEK = 7 * 24 * 60 * 60 * 1000

const save = async ($: Parameters<import('claude-code/testing').TestBody>[0]) => {
  await $.turn.complete({ answer: 'done', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
}

test('TRACK-21 first closed sighting stamps closure without expiring old unfinished rows', async ($, on) => {
  const foreign = { v: 1, savedAt: 1, ledger: { ...EMPTY, questions: [{ id: 1, head: 'unfinished', status: 'open', at: 1, turnId: null }] } }
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  const store = pluginStore(on, { [`s:${FOREIGN}`]: foreign }, undefined, { guardStates: { [FOREIGN]: 'closed' } })
  on('session.id', () => ({ value: SESSION }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await save($)
  const retained = store.held.get(`s:${FOREIGN}`) as { closedAt?: number; session_id?: string; ledger: unknown }
  expect(retained.closedAt).toBeGreaterThan(0)
  expect(retained.session_id).toBe(FOREIGN)
  expect(retained.ledger).toEqual(foreign.ledger)
})

test('TRACK-21 expired closed unfinished records are removed', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  const foreign = { v: 1, session_id: FOREIGN, savedAt: 1, closedAt: Date.now() - WEEK - 1000, ledger: { ...EMPTY, questions: [{ id: 1, head: 'unfinished', status: 'open', at: 1, turnId: null }] } }
  const store = pluginStore(on, { [`s:${FOREIGN}`]: foreign }, undefined, { guardStates: { [FOREIGN]: 'closed' } })
  on('session.id', () => ({ value: SESSION }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await save($)
  expect(store.held.has(`s:${FOREIGN}`)).toBe(false)
})

test('TRACK-21 a live lease clears an expired closure clock and keeps all rows', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  const foreign = { v: 1, session_id: FOREIGN, savedAt: 1, closedAt: Date.now() - WEEK - 1000, ledger: EMPTY }
  const store = pluginStore(on, { [`s:${FOREIGN}`]: foreign })
  on('session.id', () => ({ value: SESSION }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await save($)
  const retained = store.held.get(`s:${FOREIGN}`) as { closedAt?: number; ledger: unknown }
  expect(retained.closedAt).toBeUndefined()
  expect(retained.ledger).toEqual(EMPTY)
})

test('TRACK-21 reload cannot authorize replacing newer saved rows with nonempty memory', async ($, on) => {
  const local = { ...EMPTY, nextQuestionId: 2, questions: [{ id: 1, head: 'local row', status: 'open', at: 1, turnId: null }] }
  const newer = { v: 1, savedAt: 2, checkpoint: { revision: 5 }, ledger: { ...EMPTY, nextQuestionId: 3, questions: [{ id: 2, head: 'newer row', status: 'open', at: 2, turnId: null }] } }
  atomStore(on, 'ledger', local)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  const store = pluginStore(on, { [`s:${SESSION}`]: newer })
  on('session.id', () => ({ value: SESSION }))
  on('classic.SessionStart', () => ({}))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.classic.SessionStart({ source: 'resume', session_id: SESSION } as never)
  await save($)
  const stored = store.held.get(`s:${SESSION}`) as { ledger: typeof local }
  expect(stored.ledger.questions.some(q => q.head === 'newer row')).toBe(true)
  expect(stored.ledger.questions.some(q => q.head === 'local row')).toBe(true)
})
