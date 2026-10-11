// FIXTURE, TRACK-21 (2026-10-11): a permitted large stamp must complete in
// the engine; scalar checks keep a failing large diff out of the reporter.
import { expect, test } from 'claude-code/testing'
import { checksumOf } from '../hooks/checkpoint'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'
const FOREIGN = '11111111-2222-4333-8444-555555555555'
test('TRACK-21 a permitted large closure stamp preserves the exact body payload', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  const padding = 'p'.repeat(1486000)
  const beforeHash = await checksumOf(padding)
  const store = pluginStore(on, { [`s:${FOREIGN}`]: { v: 1, savedAt: 1, ledger: EMPTY, padding } }, undefined, { guardStates: { [FOREIGN]: 'closed' } })
  on('session.id', () => ({ value: SESSION }))
  logs(on)
  const receipt = JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result))
  expect(receipt.ok).toBe(true)
  const after = store.held.get(`s:${FOREIGN}`) as any
  expect(after.session_id).toBe(FOREIGN)
  expect(typeof after.closedAt).toBe('number')
  expect(await checksumOf(after.padding)).toBe(beforeHash)
  expect(store.held.has(`cleanup:${FOREIGN}`)).toBe(false)
  expect(store.held.has(`s:${SESSION}`)).toBe(true)
})
