// FIXTURE, TRACK-21 (2026-10-11): a permitted large stamp must complete in
// the engine; scalar checks keep a failing large diff out of the reporter.
import { expect, test } from 'claude-code/testing'
import { checksumOf } from '../hooks/checkpoint'
import { EMPTY, SESSION, atomStore, blobPool, logs, pluginStore } from './kit'
const FOREIGN = '11111111-2222-4333-8444-555555555555'
test('TRACK-21 a permitted large closure stamp preserves the exact body payload', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  const padding = 'p'.repeat(1486000)
  const beforeHash = await checksumOf(padding)
  const before = { v: 1, savedAt: 1, ledger: EMPTY, padding }
  const bodyHash = await checksumOf(before)
  const store = pluginStore(on, { [`s:${FOREIGN}`]: before }, undefined, { guardStates: { [FOREIGN]: 'closed' } })
  const pool = blobPool(on)
  on('session.id', () => ({ value: SESSION }))
  logs(on)
  const receipt = JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result))
  expect(receipt.ok).toBe(true)
  const rawOwnSave = store.held.get(`s:${SESSION}`) as { v?: number } | undefined
  expect(rawOwnSave?.v).toBe(2)
  expect(Object.hasOwn(rawOwnSave!, 'ledger')).toBe(false)
  expect((await pool.logical(store, `s:${SESSION}`) as any).ledger).toEqual({ ...EMPTY, session_id: SESSION })
  const after = store.held.get(`s:${FOREIGN}`) as any
  const head = store.held.get(`h:${FOREIGN}`) as any
  expect(head.session_id).toBe(FOREIGN)
  expect(typeof head.closedAt).toBe('number')
  expect(await checksumOf(after)).toBe(bodyHash)
  expect(await checksumOf(after.padding)).toBe(beforeHash)
  expect(store.held.has(`cleanup:${FOREIGN}`)).toBe(false)
  expect(store.held.has(`s:${SESSION}`)).toBe(true)
})
