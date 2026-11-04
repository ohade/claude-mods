// FIXTURE: frozen before P2.1 extraction. Real mod handlers, in-memory kit storage/locks.
import { expect, test } from 'claude-code/testing'
import { describeCheckpoint } from '../hooks/checkpoint'
import { atomStore, blobPool, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Baseline } from '../types'
import { LEGACY_SESSION as ID, legacyLedger, legacyLateStep, legacyCommitOrder, missingBodyError, legacyFallback } from './helpers/legacy_save_cases'

const setup = (on: On, options: { records?: Record<string, unknown>; baseline?: Baseline; late?: boolean; fallback?: boolean } = {}) => {
  const memory = atomStore(on, 'ledger', legacyLedger())
  const state = atomStore(on, 'durability', { isUnsaved: false, reason: '', memorySession: ID, baseline: options.baseline })
  atomStore(on, 'turn', { currentId: 'save-turn', gatedTurnId: null })
  on('session.id', () => ({ value: ID }))
  if (options.late) on('store.set', { key: `s:${ID}` }, async (_, e, next) => {
    const result = await next(e)
    memory.value = { ...memory.value, steps: [legacyLateStep] }
    memory.version++
    return result
  })
  if (options.fallback) on('process.run', { argv: /blob-fs\.py$/ }, () => ({ deny: legacyFallback }))
  const store = pluginStore(on, options.records)
  const pool = blobPool(on)
  const lines = logs(on)
  return { memory, state, store, pool, lines }
}
const checkpoint = async ($: Engine) => JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: ID } as never)).result))

test('P2.1 original legacy success commits body, head, index before completion', async ($, on) => {
  const f = setup(on)
  expect((await checkpoint($)).ok).toBe(true)
  const trace = f.store.locks.timeline
  expect(trace.filter(event => legacyCommitOrder.includes(event))).toEqual(legacyCommitOrder)
  const request = trace.findIndex(event => event.startsWith('request:'))
  expect(request > trace.lastIndexOf('set:saved')).toBe(true)
  expect(f.store.locks.requests.length).toBe(1)
  expect((await f.pool.logical(f.store, `s:${ID}`) as { ledger: unknown }).ledger).toEqual(legacyLedger())
  expect(f.state.value.isUnsaved).toBe(false)
})

test('P2.1 original missing body preserves its newer head and archives local rows', async ($, on) => {
  const checkpoint = await describeCheckpoint(legacyLedger(), ID)
  const head = { v: 1, session_id: ID, generation: 'new-generation', checkpoint: { ...checkpoint, revision: 2 } }
  const f = setup(on, { records: { [`h:${ID}`]: head }, baseline: { session_id: ID, ledger: legacyLedger(), checkpoint, generation: 'old-generation' } })
  const result = JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: ID } as never)).result))
  expect(result.ok).toBe(false)
  expect(result.reason).toBe(missingBodyError)
  expect(f.store.held.get(`h:${ID}`)).toEqual(head)
  expect(f.store.held.has(`s:${ID}`)).toBe(false)
  expect([...f.store.held.keys()].filter(key => key.startsWith(`r:${ID}:conflict-`)).length).toBe(1)
  expect(f.store.locks.requests.length).toBe(0)
})

test('P2.1 original inline fallback saves its body but tainted grant never completes', async ($, on) => {
  const f = setup(on, { fallback: true })
  expect((await checkpoint($)).ok).toBe(true)
  expect(f.store.held.get(`s:${ID}`)).toMatchObject({ v: 1, ledger: legacyLedger() })
  expect(f.store.locks.requests.length).toBe(0)
  expect(f.state.value.isUnsaved).toBe(false)
})

test('P2.1 original post-snapshot mutation keeps new memory and a pending durability flag', async ($, on) => {
  const f = setup(on, { late: true })
  expect((await checkpoint($)).ok).toBe(true)
  expect((await f.pool.logical(f.store, `s:${ID}`) as { ledger: unknown }).ledger).toEqual(legacyLedger())
  expect(f.memory.value.steps).toEqual([legacyLateStep])
  expect(f.state.value).toMatchObject({ isUnsaved: true, reason: 'ledger save pending' })
  expect(f.store.locks.requests.length).toBe(1)
})
