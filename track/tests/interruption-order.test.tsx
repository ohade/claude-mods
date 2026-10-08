// FIXTURE: delayed work keeps the main-turn identity observed when its call entered.
import { expect, test } from 'claude-code/testing'
import type { Ledger, Step } from '../types'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

test('a delayed mark_step belongs to its entering turn, not a newer turn at clock completion', async ($, on) => {
  const l = atomStore<Ledger & { steps: Array<Step & { activeTurnId?: string }> }>(on, 'ledger', {
    ...EMPTY, v: 1, steps: [{ id: 'plan:1', source: 'plan', subject: 'work', status: 'pending' }],
  })
  const t = atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  const a = atomStore(on, 'activity', { isWorking: true, mainTurnId: 't1', agentCalls: [], askCalls: [], background: [] })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  let entered!: () => void
  let release!: () => void
  const atClock = new Promise<void>(resolve => { entered = resolve })
  const clockWait = new Promise<void>(resolve => { release = resolve })
  on('clock.now', async () => { entered(); await clockWait; return { value: 1000 } })
  const marking = $.tool.call({ tool: 'mcp__track__mark_step', id: 'plan:1', status: 'in_progress' } as never)
  await atClock
  t.value = { ...t.value, currentId: 't2' }
  t.version++
  a.value = { ...a.value, mainTurnId: 't2' }
  a.version++
  release()
  await marking
  expect(l.value.steps[0]?.activeTurnId).toBe('t1')
  await $.turn.complete({ answer: '', reason: 'aborted', turnId: 't1', durationMs: 1, isAborted: true } as never)
  expect(l.value.steps[0]?.status).toBe('paused')
  expect(l.value.steps[0]?.note).toBe('interrupted')
  expect(a.value.isWorking).toBe(true)
})
