// FIXTURE: TRACK-30 review (2026-10-19). A child turn must not replace the
// main turn's age, identity or one-shot reconciliation claims.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Activity, Ledger, Turn } from '../types'

const prepare = async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  const turn = atomStore<Turn>(on, 'turn', { currentId: null, gatedTurnId: null })
  const activity = atomStore<Activity>(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [] })
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1 })
  const pending = atomStore(on, 'pending', { inputs: [], nextId: 1 })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/fixture/config' : '/fixture/track' }))
  on('env.set', () => ({ value: undefined }))
  await $.turn.start({ text: 'Main work', turnId: 'main-1' } as never)
  return { clock, turn, activity, ledger, pending }
}

test('TRACK-30 subagent turn start preserves main identity, age and held reconciliation', async ($, on) => {
  const f = await prepare($, on)
  f.turn.value = { ...f.turn.value, freshness: { ...f.turn.value.freshness!, held: ['finished_delegation'], nudged: ['step-review'] } }
  const before = structuredClone({ turn: f.turn.value, activity: f.activity.value, ledger: f.ledger.value, pending: f.pending.value })
  await f.clock.advance(240_000)
  await $.turn.start({ text: 'Child work', turnId: 'child-1', agentId: 'worker-1' } as never)
  expect(f.turn.value.currentId).toBe('main-1')
  expect(f.turn.value.startedAt).toBe(before.turn.startedAt)
  expect(f.turn.value).toEqual(before.turn)
  expect(f.activity.value).toEqual(before.activity)
  expect(f.ledger.value).toEqual(before.ledger)
  expect(f.pending.value).toEqual(before.pending)
})

test('TRACK-30 a genuine next main turn still resets age and claims', async ($, on) => {
  const f = await prepare($, on)
  const first = f.turn.value.startedAt
  f.turn.value = { ...f.turn.value, freshness: { ...f.turn.value.freshness!, held: ['finished_delegation'], nudged: ['step-review'] } }
  await f.clock.advance(360_000)
  await $.turn.start({ text: 'Next main work', turnId: 'main-2' } as never)
  expect(f.turn.value.currentId).toBe('main-2')
  expect(f.turn.value.startedAt).toBe((first ?? 0) + 360_000)
  expect(f.turn.value.freshness?.held).toEqual([])
  expect(f.turn.value.freshness?.nudged).toEqual([])
  expect(f.activity.value.mainTurnId).toBe('main-2')
})
