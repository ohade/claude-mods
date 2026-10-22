// FIXTURE: duplicate/stale writers must not overwrite an acknowledged ledger.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, logs, pluginStore } from './kit'

const prepare = (on: any, leaseFailure?: string) => {
  const pool = blobPool(on)
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on, {}, 4 * 1024 * 1024, { leaseFailure })
  on('session.id', () => ({ value: SESSION }))
  return { ...store, pool }
}

test('a refused writer lease cannot write a durable ledger', async ($, on) => {
  const store = prepare(on, 'another loaded Track instance owns this session')
  const result = await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Duplicate writer' } as never)
  expect(JSON.stringify(result)).toContain('unsaved')
  expect(store.held.has(`s:${SESSION}`)).toBe(false)
})

test('a stale revision refuses to overwrite the newer durable ledger', async ($, on) => {
  const store = prepare(on)
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'first' } as never)
  const saved = store.held.get(`s:${SESSION}`) as any
  const logical = await store.pool.logical(store, `s:${SESSION}`) as any
  const newer = { ...saved, checkpoint: { ...saved.checkpoint, revision: saved.checkpoint.revision + 1 }, ledger: { ...logical.ledger, questions: [{ ...logical.ledger.questions[0], head: 'newer owner value' }] } }
  store.held.set(`s:${SESSION}`, newer)
  const result = await $.tool.call({ tool: 'mcp__track__track_question', summary: 'stale mutation' } as never)
  expect(JSON.stringify(result)).toContain('unsaved')
  expect(store.held.get(`s:${SESSION}`)).toEqual(newer)
})

test('a failed read-back keeps prior durable values and permits the same writer to retry', async ($, on) => {
  const store = prepare(on)
  logs(on)
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Acknowledged first question' } as never)
  const previous = JSON.stringify(store.held.get(`s:${SESSION}`))
  store.faults.mismatchAfterSet = `s:${SESSION}`
  const failed = await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Unsaved second question' } as never)
  expect(JSON.stringify(failed)).toContain('unsaved')
  expect(JSON.stringify(store.held.get(`s:${SESSION}`))).toBe(previous)
  const retried = JSON.parse((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result as string)
  expect(retried.ok).toBe(true)
  expect((await store.pool.logical(store, `s:${SESSION}`) as any).ledger.questions.map((q: any) => q.head)).toEqual(['Acknowledged first question', 'Unsaved second question'])
})

test('a failed acknowledgement cannot prune completed history', async ($, on) => {
  const store = prepare(on)
  logs(on)
  for (let i = 0; i < 20; i++) store.held.set(`s:history-${i}`, { v: 1, savedAt: i, ledger: { ...EMPTY, questions: [{ id: 1, head: `Finished ${i}`, at: i, turnId: null, status: 'answered' }] } })
  store.faults.mismatchAfterSet = `s:${SESSION}`
  const failed = await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Not acknowledged' } as never)
  expect(JSON.stringify(failed)).toContain('unsaved')
  expect(Array.from({ length: 20 }, (_, i) => store.held.has(`s:history-${i}`))).toEqual(Array(20).fill(true))
  expect(store.held.has(`s:${SESSION}`)).toBe(false)
  const retried = JSON.parse((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result as string)
  expect(retried.ok).toBe(true)
  expect((await store.pool.logical(store, `s:${SESSION}`) as any).ledger.questions[0].head).toBe('Not acknowledged')
})

test('an unequal durable bucket cannot skip recovery of deleted history', async ($, on) => {
  const store = prepare(on)
  logs(on)
  for (let i = 0; i < 20; i++) store.held.set(`s:history-${i}`, { v: 1, savedAt: i, ledger: { ...EMPTY } })
  store.faults.alteredAfterSet = `s:${SESSION}`
  const failed = await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Unequal acknowledgement' } as never)
  expect(JSON.stringify(failed)).toContain('unsaved')
  expect((store.held.get(`s:${SESSION}`) as any).changedByStore).toBe(true)
  expect(Array.from({ length: 20 }, (_, i) => store.held.has(`s:history-${i}`))).toEqual(Array(20).fill(true))
})

test('pending rollback reconciles a foreign index without overwriting foreign ledger values', async ($, on) => {
  const store = prepare(on)
  logs(on)
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'First acknowledged' } as never)
  store.faults.mismatchAfterSet = `s:${SESSION}`
  store.faults.failRollback = true
  const failed = await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Retry after rollback failure' } as never)
  expect(JSON.stringify(failed)).toContain('recovery pending')
  const foreign = { v: 1, savedAt: 5, ledger: { ...EMPTY, questions: [{ id: 1, head: 'Foreign unfinished value', at: 5, turnId: null, status: 'open' }] } }
  store.held.set('s:foreign', foreign)
  store.held.set('saved', { foreign: { at: 5, bytes: 500, unfinished: true } })
  const retried = JSON.parse((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result as string)
  expect(retried.ok).toBe(true)
  expect((await store.pool.logical(store, `s:${SESSION}`) as any).ledger.questions).toHaveLength(2)
  expect(store.held.get('s:foreign')).toEqual(foreign)
  expect((store.held.get('saved') as any).foreign).toMatchObject({ at: 5, unfinished: true })
})

test('an unverified foreign history write remains pending without blocking the caller', async ($, on) => {
  const pool = blobPool(on)
  const foreign = '00000000-0000-4000-8000-000000000001'
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on, {}, undefined, { guardStates: { [foreign]: 'closed' } })
  on('session.id', () => ({ value: SESSION }))
  logs(on)
  // The removed count-pruner no longer writes history-0. Exercise the same
  // unverified foreign write through retained-lease closure stamping instead.
  const body = { v: 1, savedAt: 0, ledger: { ...EMPTY } }
  store.held.set(`s:${foreign}`, body)
  store.faults.alteredAfterSet = `h:${foreign}`
  // TRACK-21 Refuter H2 (2026-10-11): a foreign cleanup error must preserve
  // its recovery journal while the independently verified caller save proceeds.
  const saved = await $.tool.call({ tool: 'mcp__track__track_question', summary: 'History verification failed' } as never)
  expect(JSON.stringify(saved)).not.toContain('unsaved')
  const unverified = store.held.get(`h:${foreign}`)
  expect((unverified as any).changedByStore).toBe(true)
  const journal = store.held.get(`cleanup:${foreign}`)
  expect(journal).toBeDefined()
  const retried = JSON.parse((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result as string)
  expect(retried.ok).toBe(true)
  expect(store.held.get(`h:${foreign}`)).toEqual(unverified)
  expect(store.held.get(`s:${foreign}`)).toEqual(body)
  expect(store.held.get(`cleanup:${foreign}`)).toEqual(journal)
  expect((await pool.logical(store, `s:${SESSION}`) as any).ledger.questions.map((q: any) => q.head)).toEqual(['History verification failed'])
})
