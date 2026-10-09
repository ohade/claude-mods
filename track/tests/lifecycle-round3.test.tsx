// Refuter round 3 adversarial tests for CC-170 correction round 2 (diff e285049..090142c).
import { expect, mock, test } from 'claude-code/testing'
import type { Activity, Ledger, Step } from '../types'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine, On } from './kit'

const CANCELLED = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."
const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)."
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
const bashLauncher = (on: On) => {
  let next = ''
  on('tool.call', { tool: 'Bash' }, () => ({ result: { backgroundTaskId: next } }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  return async ($: Engine, id: string) => { next = id; await call($, { tool: 'Bash', tool_use_id: `u-${id}`, command: 'sleep 9', run_in_background: true }) }
}

// Item 3 cap
test('zz-r3 cap: 65 launches keep the newest 64 owner ids and evict the oldest', async ($, on) => {
  const { ledger, activity } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  const launch = bashLauncher(on)
  for (let i = 1; i <= 65; i++) await launch($, `b${i}`)
  const keys = Object.keys(activity.value.owners ?? {})
  expect(keys.length).toBe(64)
  expect(keys.includes('b1')).toBe(false)
  expect(keys.includes('b65')).toBe(true)
  expect(keys.includes('b2')).toBe(true)
  await notify($, 'b1')
  expect(view(ledger)[0]?.followUp).toBeUndefined()
  await notify($, 'b2')
  expect(view(ledger)[0]?.followUp).toBe(true)
})
test('zz-r3 cap: a relaunched id moves to newest and survives the next eviction', async ($, on) => {
  const { activity } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  const launch = bashLauncher(on)
  for (let i = 1; i <= 64; i++) await launch($, `b${i}`)
  await launch($, 'b1')
  await launch($, 'b65')
  const keys = Object.keys(activity.value.owners ?? {})
  expect(keys.length).toBe(64)
  expect(keys.includes('b1')).toBe(true)
  expect(keys.includes('b2')).toBe(false)
})
test('zz-r3 cap: a numeric-looking newest id is not the one evicted', async ($, on) => {
  const { activity } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  const launch = bashLauncher(on)
  for (let i = 1; i <= 64; i++) await launch($, `x${i}`)
  await launch($, '7')
  const keys = Object.keys(activity.value.owners ?? {})
  expect(keys.includes('7')).toBe(true)
  expect(keys.includes('x1')).toBe(false)
})

// Item 3 drop when the owned step leaves in_progress/delegated
test('zz-r3 drop: mark_step completed drops the owner, and the later notification flags nothing', async ($, on) => {
  const { ledger, activity } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  const launch = bashLauncher(on)
  await launch($, 'b1')
  expect(activity.value.owners?.b1).toEqual(['plan:1'])
  await call($, { tool: 'mcp__track__mark_step', id: 'plan:1', status: 'completed' })
  expect(activity.value.owners?.b1).toBeUndefined()
  await notify($, 'b1')
  expect(view(ledger)[0]).toMatchObject({ status: 'completed', followUp: undefined })
})
test('zz-r3 drop: TodoWrite completing the owned todo drops the owner', async ($, on) => {
  const { ledger, activity } = setup(on, [])
  let todos = [{ content: 'Ship it', status: 'in_progress', activeForm: 'Shipping' }]
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: todos } }) as never)
  const launch = bashLauncher(on)
  await call($, { tool: 'TodoWrite', todos })
  const id = ledger.value.steps[0]?.id ?? ''
  await launch($, 'b1')
  expect(activity.value.owners?.b1).toEqual([id])
  todos = [{ content: 'Ship it', status: 'completed', activeForm: 'Shipping' }]
  await call($, { tool: 'TodoWrite', todos })
  expect(activity.value.owners?.b1).toBeUndefined()
})
test('zz-r3 drop: a delegated step paused by mark_step keeps its Agent owner and is flagged later', async ($, on) => {
  const { ledger, activity } = setup(on, [step('plan:1', { status: 'in_progress', delegated: true, activeTurnId: 't1' })])
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await call($, { tool: 'Agent', tool_use_id: 'a', description: 'd', prompt: 'p', run_in_background: true })
  await call($, { tool: 'mcp__track__mark_step', id: 'plan:1', status: 'paused', note: 'waiting on agent' })
  expect(activity.value.owners?.ag1).toEqual(['plan:1'])
  await notify($, 'ag1')
  expect(view(ledger)[0]).toMatchObject({ status: 'paused', followUp: true })
})

// Brief case 4: a paused step is still flaggable. Esc or a cancel parks the owner of a live background shell.
test('zz-r3 case4: a step interrupted by Esc while its background shell runs is flagged when the shell finishes', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const launch = bashLauncher(on)
  await launch($, 'b1')
  await $.turn.complete({ answer: '', reason: 'aborted', turnId: 't1', durationMs: 1, isAborted: true } as never)
  expect(view(ledger)[0]).toMatchObject({ status: 'paused', note: 'interrupted' })
  await notify($, 'b1')
  expect(view(ledger)[0]).toMatchObject({ status: 'paused', followUp: true })
})
test('zz-r3 case4: a step paused by mark_step while its background shell runs is flagged when the shell finishes', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  const launch = bashLauncher(on)
  await launch($, 'b1')
  await call($, { tool: 'mcp__track__mark_step', id: 'plan:1', status: 'paused', note: 'waiting on build' })
  await notify($, 'b1')
  expect(view(ledger)[0]).toMatchObject({ status: 'paused', followUp: true })
})

// Item 1 reading: test text first, then result
test('zz-r3 item1: an error whose model-read text does not match but whose stored result starts with the cancel marks the step', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Bash' }, () => ({ result: CANCELLED, text: 'Error: interrupted', isError: true }) as never)
  await call($, { tool: 'Bash', tool_use_id: 'b', command: 'ls' })
  expect(view(ledger)[0]).toMatchObject({ status: 'paused', note: 'cancelled by you' })
})
test('zz-r3 item1 control: a non-error result whose model-read text is the cancel changes nothing', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Read' }, () => ({ result: 'file', text: CANCELLED }) as never)
  await call($, { tool: 'Read', tool_use_id: 'r', file_path: '/x' })
  expect(view(ledger)[0]).toMatchObject({ status: 'in_progress', note: undefined })
})
test('zz-r3 item1 control: an error whose text quotes the cancel after other text changes nothing, whatever result holds', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Bash' }, () => ({ result: `grep: ${CANCELLED}`, text: `grep: ${CANCELLED}`, isError: true }) as never)
  await call($, { tool: 'Bash', tool_use_id: 'b', command: 'grep' })
  expect(view(ledger)[0]).toMatchObject({ status: 'in_progress', note: undefined })
})

// Item 5 deny
test('zz-r3 item5: a deny that starts with the cancel sentence marks nothing', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Bash' }, () => ({ deny: CANCELLED }))
  await call($, { tool: 'Bash', tool_use_id: 'b', command: 'ls' })
  expect(view(ledger)[0]).toMatchObject({ status: 'in_progress', note: undefined })
})
test('zz-r3 item5: a deny that quotes the permission sentence after other text marks nothing', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Bash' }, () => ({ deny: 'policy: Permission to use Bash has been denied.' }))
  await call($, { tool: 'Bash', tool_use_id: 'b', command: 'ls' })
  expect(view(ledger)[0]).toMatchObject({ status: 'in_progress', note: undefined })
})
test('zz-r3 item5: a deny that starts with the rejection sentence marks refused', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Bash' }, () => ({ deny: `\n${REJECTED}` }))
  await call($, { tool: 'Bash', tool_use_id: 'b', command: 'ls' })
  expect(view(ledger)[0]).toMatchObject({ status: 'paused', note: 'refused' })
})

// Item 2 write-time recheck
test('zz-r3 item2: a step completed while the cancelled call was in flight stays completed', async ($, on) => {
  const { ledger } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Bash' }, () => {
    ledger.value = { ...ledger.value, steps: [{ ...ledger.value.steps[0]!, status: 'completed' }] }
    return { result: CANCELLED, isError: true }
  })
  await call($, { tool: 'Bash', tool_use_id: 'b', command: 'ls' })
  expect(view(ledger)[0]).toMatchObject({ status: 'completed', note: undefined })
})
test('zz-r3 item2: a step whose turn changed while the call was in flight is not changed', async ($, on) => {
  const { ledger, turn } = setup(on, [step('plan:1', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Bash' }, () => {
    turn.value = { ...turn.value, currentId: 't2' }
    return { result: CANCELLED, isError: true }
  })
  await call($, { tool: 'Bash', tool_use_id: 'b', command: 'ls' })
  expect(view(ledger)[0]).toMatchObject({ status: 'in_progress', note: undefined })
})

// Item 4 owner rules
test('zz-r3 item4: two delegated in-progress steps and a main step mean nobody owns the Agent launch', async ($, on) => {
  const { ledger, activity } = setup(on, [step('plan:1', { status: 'in_progress', delegated: true, activeTurnId: 't1' }), step('plan:2', { status: 'in_progress', delegated: true, activeTurnId: 't1' }), step('plan:3', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await call($, { tool: 'Agent', tool_use_id: 'a', description: 'd', prompt: 'p', run_in_background: true })
  expect(activity.value.owners?.ag1).toBeUndefined()
  await notify($, 'ag1')
  expect(view(ledger).map(s => s.followUp)).toEqual([undefined, undefined, undefined])
})
test('zz-r3 item4: an older-turn delegated step never owns this turn\'s Agent launch; the main step does', async ($, on) => {
  const { activity } = setup(on, [step('plan:1', { status: 'in_progress', delegated: true, activeTurnId: 't0' }), step('plan:2', { status: 'in_progress', activeTurnId: 't1' })])
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } }) as never)
  await call($, { tool: 'Agent', tool_use_id: 'a', description: 'd', prompt: 'p', run_in_background: true })
  expect(activity.value.owners?.ag1).toEqual(['plan:2'])
})
test('zz-r3 item4: a Bash background launch with a delegated and a main step in this turn has no owner', async ($, on) => {
  const { activity } = setup(on, [step('plan:1', { status: 'in_progress', delegated: true, activeTurnId: 't1' }), step('plan:2', { status: 'in_progress', activeTurnId: 't1' })])
  const launch = bashLauncher(on)
  await launch($, 'b1')
  expect(activity.value.owners?.b1).toBeUndefined()
})

// Item 3 Stop + loop end together
test('zz-r3 item3: an agent whose loop ended and which left the Stop list still flags its step', async ($, on) => {
  const { ledger, activity } = setup(on, [step('plan:1', { status: 'in_progress', delegated: true, activeTurnId: 't1' })])
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('classic.Stop', () => ({}))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await call($, { tool: 'Agent', tool_use_id: 'a', description: 'd', prompt: 'p', run_in_background: true })
  await $.turn.complete({ answer: '', reason: 'answer', turnId: 'sub1', durationMs: 1, isAborted: false, agentId: 'ag1' } as never)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)
  expect(activity.value.background).not.toContain('ag1')
  await notify($, 'ag1')
  expect(view(ledger)[0]).toMatchObject({ status: 'in_progress', followUp: true })
  expect(activity.value.owners?.ag1).toBeUndefined()
})
