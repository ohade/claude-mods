// CC-170 correction round 2. Items 1-6 fail on e285049. The amendment wins where it differs from the refuter.
import { expect, mock, test } from 'claude-code/testing'
import type { Activity, Ledger, Step } from '../types'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine, On } from './kit'

const CANCELLED = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."
const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)."
const REFUSED = 'Permission to use Agent has been denied.'
const step = (id: string, extra: Partial<Step> = {}): Step => ({ id, source: 'plan', subject: id, status: 'pending', ...extra })
const setup = (on: On, steps: Step[]) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps })
  const turn = atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  const activity = atomStore<Activity>(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  return { ledger, turn, activity }
}
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never)
const view = (ledger: { value: Ledger }) => ledger.value.steps.map(s => ({ id: s.id, status: s.status, note: s.note, followUp: s.followUp }))
const notify = ($: Engine, id: string) => $.prompt.submit({ text: `<task-notification><task-id>${id}</task-id><status>completed</status></task-notification>`, origin: { kind: 'task-notification' } } as never)

test('an Agent cancel with a delegated step and a main step both in this turn changes neither', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', delegated: true, activeTurnId: 't1' }), step('plan:2', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Agent' }, () => ({ result: CANCELLED, isError: true }))
  await call($, { tool: 'Agent', tool_use_id: 'a', description: 'd', prompt: 'p' })
  expect(view(ledger).map(s => [s.status, s.note])).toEqual([['in_progress', undefined], ['in_progress', undefined]])
})

test('a step paused while the cancelled call was in flight keeps its note', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Agent' }, () => {
    ledger.value = { ...ledger.value, steps: [{ ...ledger.value.steps[0]!, status: 'paused', note: 'waiting on Ohad' }] }
    return { result: CANCELLED, isError: true }
  })
  await call($, { tool: 'Agent', tool_use_id: 'a', description: 'd', prompt: 'p' })
  expect(view(ledger)[0]).toMatchObject({ status: 'paused', note: 'waiting on Ohad' })
})

test('an error whose model-read text is the cancel and whose stored result is undefined marks the step', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Agent' }, () => ({ result: undefined, text: CANCELLED, isError: true }) as never)
  await call($, { tool: 'Agent', tool_use_id: 'a', description: 'd', prompt: 'p' })
  expect(view(ledger)[0]).toMatchObject({ status: 'paused', note: 'cancelled by you' })
})

test('an error whose stored result differs but whose model-read text is the rejection marks refused', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'User rejected tool use', text: REJECTED, isError: true }) as never)
  await call($, { tool: 'Bash', tool_use_id: 'b', command: 'make' })
  expect(view(ledger)[0]).toMatchObject({ status: 'paused', note: 'refused' })
})

test('a deny that starts with Permission to use X has been denied marks refused', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Agent' }, () => ({ deny: REFUSED }))
  await call($, { tool: 'Agent', tool_use_id: 'a', description: 'd', prompt: 'p' })
  expect(view(ledger)[0]).toMatchObject({ status: 'paused', note: 'refused' })
})

test('leading whitespace before the cancel sentence still marks', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Bash' }, () => ({ result: `\n${CANCELLED}`, isError: true }))
  await call($, { tool: 'Bash', tool_use_id: 'b', command: 'ls' })
  expect(view(ledger)[0]).toMatchObject({ status: 'paused', note: 'cancelled by you' })
})

test('a BOM before the cancel sentence still marks', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Bash' }, () => ({ result: `﻿${CANCELLED}`, isError: true }))
  await call($, { tool: 'Bash', tool_use_id: 'b', command: 'ls' })
  expect(view(ledger)[0]).toMatchObject({ status: 'paused', note: 'cancelled by you' })
})

test('a background agent whose loop ended before its notification still flags its step', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', delegated: true, activeTurnId: 't1' })])
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await call($, { tool: 'Agent', tool_use_id: 'a', description: 'd', prompt: 'p', run_in_background: true })
  await $.turn.complete({ answer: '', reason: 'answer', turnId: 'sub1', durationMs: 1, isAborted: false, agentId: 'ag1' } as never)
  await notify($, 'ag1')
  expect(view(ledger)[0]).toMatchObject({ status: 'in_progress', followUp: true })
})

test('a shell task that left the Stop list still flags its step on the later notification', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Bash' }, () => ({ result: { backgroundTaskId: 'b1' } }) as never)
  on('classic.Stop', () => ({}))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await call($, { tool: 'Bash', tool_use_id: 'b', command: 'sleep 1', run_in_background: true })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)
  await notify($, 'b1')
  expect(view(ledger)[0]).toMatchObject({ status: 'in_progress', followUp: true })
})

test('a flagged step cleared by mark_step is flagged again by a later task', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', delegated: true, activeTurnId: 't1' })])
  const lines: string[] = []
  let n = 0
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: `ag${++n}` } }) as never)
  on('prompt.submit', (_, e) => { lines.push(...((e as { context?: string[] }).context ?? [])); return { text: e.text } })
  await call($, { tool: 'Agent', tool_use_id: 'a1', description: 'd', prompt: 'p', run_in_background: true })
  await call($, { tool: 'Agent', tool_use_id: 'a2', description: 'd', prompt: 'p', run_in_background: true })
  await notify($, 'ag1')
  await notify($, 'ag1')
  expect(lines.filter(l => l.includes('background work finished'))).toHaveLength(1)
  await call($, { tool: 'mcp__track__mark_step', id: 'plan:1', status: 'in_progress', note: 'checked ag1' })
  expect(ledger.value.steps[0]?.followUp).toBeUndefined()
  await notify($, 'ag2')
  expect(lines.filter(l => l.includes('background work finished'))).toHaveLength(2)
  expect(ledger.value.steps[0]?.followUp).toBe(true)
})

test('a background agent launched for the delegated step while a main step also runs flags the delegated step', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', delegated: true, activeTurnId: 't1' }), step('plan:2', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await call($, { tool: 'Agent', tool_use_id: 'a', description: 'd', prompt: 'p', run_in_background: true })
  await notify($, 'ag1')
  expect(view(ledger)[0]).toMatchObject({ id: 'plan:1', followUp: true })
  expect(view(ledger)[1]?.followUp).toBeUndefined()
})

test('a cancelled Agent launch is owned by the single delegated in-progress step of this turn', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', delegated: true, activeTurnId: 't1' })])
  on('tool.call', { tool: 'Agent' }, () => ({ result: CANCELLED, isError: true }))
  await call($, { tool: 'Agent', tool_use_id: 'a', description: 'd', prompt: 'p' })
  expect(view(ledger)[0]).toMatchObject({ status: 'paused', note: 'cancelled by you' })
})
