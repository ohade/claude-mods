import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, pluginStore } from './kit'

const FOREIGN = '00000000-0000-4000-8000-000000000001'
const WEEK = 7 * 24 * 60 * 60 * 1000

const save = async ($: Parameters<import('claude-code/testing').TestBody>[0]) => {
  await $.turn.complete({ answer: 'done', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
}

test('TRACK-21 first closed sighting stamps closure without expiring recently saved unfinished rows', async ($, on) => {
  const pool = blobPool(on)
  const foreign = { v: 1, savedAt: Date.now(), ledger: { ...EMPTY, questions: [{ id: 1, head: 'unfinished', status: 'open', at: 1, turnId: null }] } }
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  const store = pluginStore(on, { [`s:${FOREIGN}`]: foreign }, undefined, { guardStates: { [FOREIGN]: 'closed' } })
  on('session.id', () => ({ value: SESSION }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await save($)
  const retained = store.held.get(`s:${FOREIGN}`) as { v: number; savedAt: number; ledger?: unknown; ledger_blob: { checksum: string; bytes: number } }
  const head = store.held.get(`h:${FOREIGN}`) as { closedAt?: number; session_id?: string }
  expect(head.closedAt).toBeGreaterThan(0)
  expect(head.session_id).toBe(FOREIGN)
  // Contract A1: the recent CLOSED v1 body becomes a v2 pointer in the same visit; no ledger content is lost.
  expect(retained.v).toBe(2)
  expect(Object.hasOwn(retained, 'ledger')).toBe(false)
  expect(Object.keys(retained).sort()).toEqual(['ledger_blob', 'savedAt', 'v'])
  expect(retained.savedAt).toBe(foreign.savedAt)
  expect(Object.keys(retained.ledger_blob).sort()).toEqual(['bytes', 'checksum'])
  const text = JSON.stringify(foreign.ledger)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  expect(retained.ledger_blob.checksum).toBe(Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''))
  expect(retained.ledger_blob.bytes).toBe(new TextEncoder().encode(text).length)
  const blob = pool.files.get(`/fixture/config/state/track/blobs/${retained.ledger_blob.checksum}.json`)
  expect(blob).toBeDefined()
  expect(JSON.parse(blob as string)).toEqual(foreign.ledger)
})

test('TRACK-21 expired closed unfinished records are removed', async ($, on) => {
  blobPool(on)
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  const foreign = { v: 1, session_id: FOREIGN, savedAt: 1, closedAt: Date.now() - WEEK - 1000, ledger: { ...EMPTY, questions: [{ id: 1, head: 'unfinished', status: 'open', at: 1, turnId: null }] } }
  const store = pluginStore(on, { [`s:${FOREIGN}`]: foreign }, undefined, { guardStates: { [FOREIGN]: 'closed' } })
  on('session.id', () => ({ value: SESSION }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await save($)
  expect(store.held.has(`s:${FOREIGN}`)).toBe(false)
})

// Design amended by lead, refuter M5: foreign LIVE/unknown values stay exact;
// the owner clears its clock while holding its own lease and the store lock.
test('TRACK-21 a live lease keeps every foreign record byte-identical', async ($, on) => {
  blobPool(on)
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  const foreign = { v: 1, session_id: FOREIGN, savedAt: 1, closedAt: Date.now() - WEEK - 1000, ledger: EMPTY }
  const store = pluginStore(on, { [`s:${FOREIGN}`]: foreign })
  on('session.id', () => ({ value: SESSION }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await save($)
  expect(store.held.get(`s:${FOREIGN}`)).toEqual(foreign)
})

test('TRACK-21 owner resume clears its own clock without needing a later save', async ($, on) => {
  blobPool(on)
  atomStore(on, 'ledger', EMPTY)
  const own = { v: 1, session_id: SESSION, savedAt: 1, closedAt: Date.now() - WEEK - 1000, ledger: EMPTY }
  const store = pluginStore(on, { [`s:${SESSION}`]: own })
  on('session.id', () => ({ value: SESSION }))
  on('classic.SessionStart', () => ({}))
  await $.classic.SessionStart({ source: 'resume', session_id: SESSION } as never)
  const { closedAt, ...withoutClock } = own
  expect(store.held.get(`s:${SESSION}`)).toEqual(withoutClock)
})

test('TRACK-21 reload cannot authorize replacing newer saved rows with nonempty memory', async ($, on) => {
  const pool = blobPool(on)
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
  const rawOwnSave = store.held.get(`s:${SESSION}`) as { v?: number } | undefined
  expect(rawOwnSave?.v).toBe(2)
  expect(Object.hasOwn(rawOwnSave!, 'ledger')).toBe(false)
  const stored = await pool.logical(store, `s:${SESSION}`) as { ledger: typeof local }
  expect(stored.ledger.questions.some(q => q.head === 'newer row')).toBe(true)
  expect(stored.ledger.questions.some(q => q.head === 'local row')).toBe(true)
})
