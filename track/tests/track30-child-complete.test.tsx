// FIXTURE: TRACK-30 native gap (2026-11-06, SID 6167a715): a local background Agent finished, its step kept
// delegated:true and external_owner:false, and no followUp ever appeared. This pins the child-completion
// receipt itself: the child's turn.complete must flag the owning step at once, without a later notification.
// The notification-after-completion control stays in lifecycle-round2.test.tsx.
import { expect, mock, test } from 'claude-code/testing'
import type { Activity, Ledger, Step } from '../types'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine, On } from './kit'

const step = (id: string, extra: Partial<Step> = {}): Step => ({ id, source: 'plan', subject: id, status: 'pending', ...extra })
const setup = (on: On, steps: Step[]) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  const activity = atomStore<Activity>(on, 'activity', { isWorking: true, mainTurnId: 't1', agentCalls: [], askCalls: [], background: [], tasks: [] })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/fixture/config' })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  return { ledger, activity }
}
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never)

test('a local background agent whose child loop completes flags its step at once, with no notification', async ($, on) => {
  const { ledger, activity } = setup(on, [step('plan:1', { status: 'in_progress', delegated: true, external_owner: false, activeTurnId: 't1' })])
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  await call($, { tool: 'Agent', tool_use_id: 'a', description: 'd', prompt: 'p', run_in_background: true })
  // Setup precondition, separate from the behaviour under test: the real launch recorded plan:1 as ag1's owner.
  expect(activity.value.owners?.ag1 ?? []).toContain('plan:1')
  await $.turn.complete({ answer: '', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  await $.turn.complete({ answer: '', reason: 'answer', turnId: 'sub1', durationMs: 1, isAborted: false, agentId: 'ag1' } as never)
  expect(activity.value.background).not.toContain('ag1')
  expect(ledger.value.steps[0]).toMatchObject({ id: 'plan:1', status: 'in_progress', delegated: true, external_owner: false, followUp: true })
})
