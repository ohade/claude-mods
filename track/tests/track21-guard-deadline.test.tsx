// FIXTURE, TRACK-21 refuter 4 (2026-10-11): guard receipt waits must end
// before other owners exhaust their 3 second store lock wait.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'
const FOREIGN = '11111111-2222-4333-8444-555555555555'
test('TRACK-21 a stalled foreign guard does not consume the store lock wait', async ($, on) => {
  const clock = mock.clock(on)
  atomStore(on, 'ledger', EMPTY)
  let release!: () => void
  let entered!: () => void
  const guardWait = new Promise<void>(go => { release = go })
  const spawned = new Promise<void>(go => { entered = go })
  const foreign = { v: 1, ledger: EMPTY }
  const store = pluginStore(on, { [`s:${FOREIGN}`]: foreign }, undefined, { guardWait,
    beforeLockSpawn: request => { if (request.argv[2] === 'guard') entered() } })
  on('session.id', () => ({ value: SESSION }))
  logs(on)
  let finished = false
  const saving = $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never).then(result => { finished = true; return result })
  await spawned
  await clock.advance(2999)
  // Flush asynchronous cleanup/save hooks while the guard remains stalled.
  await new Promise(go => setTimeout(go, 30))
  const finishedBeforeWriterTimeout = finished
  release()
  const result = await saving
  expect(finishedBeforeWriterTimeout).toBe(true)
  expect(JSON.parse(String(result.result)).ok).toBe(true)
  expect(store.held.get(`s:${FOREIGN}`)).toEqual(foreign)
})
