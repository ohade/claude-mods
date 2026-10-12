import { expect, mock, test } from 'claude-code/testing'
import type { Activity, Ledger } from '../types'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

// Fable mutation M10 (2026-10-11): allowing waiting steps escaped the suite.
test('a delegated step waiting on the person drops its owner and gets no finished-task flag', async ($, on) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps: [{
    id: 'plan:1', source: 'plan', subject: 'Review the result', status: 'in_progress',
    delegated: true, activeTurnId: 't1',
  }] })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  const activity = atomStore<Activity>(on, 'activity', {
    isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [],
  })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.tool.call({ tool: 'Agent', tool_use_id: 'launch', description: 'review', prompt: 'review', run_in_background: true } as never)
  expect(activity.value.owners?.ag1).toEqual(['plan:1'])
  await $.tool.call({ tool: 'mcp__track__mark_step', id: 'plan:1', status: 'waiting', note: 'Person reviews the result' } as never)
  expect(activity.value.owners?.ag1).toBeUndefined()
  await $.prompt.submit({ text: '<task-notification><task-id>ag1</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' } } as never)

  expect(ledger.value.steps[0]).toMatchObject({ status: 'waiting', note: 'Person reviews the result' })
  expect(ledger.value.steps[0]?.delegated).toBeUndefined()
  expect(ledger.value.steps[0]?.followUp).toBeUndefined()
  expect(activity.value.owners?.ag1).toBeUndefined()
})

// FIXTURE: an existing atom carries a stale delegation bit. Normal mark_step clears it;
// this pins the waiting exclusion itself, not that separate status-write safeguard.
test('a waiting row with a stale delegation bit is never flagged by its finished task', async ($, on) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps: [{
    id: 'plan:1', source: 'plan', subject: 'Review the result', status: 'waiting',
    delegated: true, note: 'Person reviews the result',
  }] })
  const activity = atomStore<Activity>(on, 'activity', {
    isWorking: false, agentCalls: [], askCalls: [], background: ['ag1'], tasks: [],
    owners: { ag1: ['plan:1'] }, ownerOrder: ['ag1'],
  })
  const lines: string[] = []
  on('prompt.submit', (_, e) => {
    lines.push(...(e.context ?? []))
    return { text: e.text }
  })
  await $.prompt.submit({ text: '<task-notification><task-id>ag1</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' } } as never)

  expect(ledger.value.steps[0]).toMatchObject({ status: 'waiting', note: 'Person reviews the result' })
  expect(ledger.value.steps[0]?.followUp).toBeUndefined()
  expect(activity.value.owners?.ag1).toBeUndefined()
  expect(lines.some(line => line.includes('background work finished'))).toBe(false)
})
