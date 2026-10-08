// FIXTURE: process stdout is a stream, not an atomic JSON message. A dead lease
// must be reacquired rather than leaving the ledger permanently unsaved.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

const prepare = (on: any, options: Parameters<typeof pluginStore>[3] = {}) => {
  mock.clock(on)
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  pluginStore(on, {}, undefined, options)
  on('session.id', () => ({ value: SESSION }))
}

test('fragmented stdout still acquires a verified writer lock', async ($, on) => {
  prepare(on, { splitLockReceipt: true })
  const result = await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)
  expect(JSON.parse(String(result.result)).ok).toBe(true)
})

test('a terminated lease is reacquired for the next acknowledged save', async ($, on) => {
  let release!: () => void
  const held = new Promise<void>(go => { release = go })
  const leaseEnding = { count: 0, wait: held }
  prepare(on, { leaseEnding })
  const first = await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)
  expect(JSON.parse(String(first.result)).ok).toBe(true)
  release()
  await new Promise(go => setTimeout(go, 20))
  const second = await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)
  expect(leaseEnding.count).toBe(2)
  expect(JSON.parse(String(second.result)).ok).toBe(true)
})
