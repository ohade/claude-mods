// FIXTURE: TRACK-30, 2026-10-19. Real plugin events and snapshots, controlled
// helper receipt. The Python suite separately proves the actual shared claim.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Activity, Ledger, Step, Turn } from '../types'

const FINISHED = 'track: local background owners finished; reconcile plan:1'
const invoke = ($: Engine, tool: string, input: object = {}) => $.tool.call({ tool, tool_use_id: `${tool}-call`, ...input } as never)
const response = ($: Engine) => $.session.append({ door: 'response', uuid: '11111111-2222-4333-8444-555555555555', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'The work can now be reviewed.' }] }, origin: { kind: 'model', model: 'fixture' } } as never)
const stop = ($: Engine, ids: string[] = [], extra: object = {}) => $.classic.Stop({ session_id: SESSION, stop_hook_active: false, background_tasks: ids.map(id => ({ id, type: 'subagent' })), ...extra } as never)
const row = (extra: object = {}): Step => ({ id: 'plan:1', source: 'plan', subject: 'Review local work', status: 'in_progress', delegated: true, activeTurnId: 'old-turn', external_owner: false, ...extra } as Step)

const prepare = async ($: Engine, on: On, extra: object = {}, tasks = ['worker-1']) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps: [row(extra)] })
  const activity = atomStore<Activity>(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [...tasks], tasks: [], owners: Object.fromEntries(tasks.map(id => [id, ['plan:1']])), launchOwners: tasks.map(task => ({ task, steps: [{ id: 'plan:1', subject: 'review local work' }] })) })
  atomStore<Turn>(on, 'turn', { currentId: null, gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  const store = pluginStore(on)
  logs(on)
  const env = new Map([['CLAUDE_PLUGIN_ROOT', '/fixture/track'], ['CLAUDE_CONFIG_DIR', '/fixture/config']])
  const held = new Set<string>()
  let snapshot: any = {}
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, e, next) => next(e))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('env.get', (_, e) => ({ value: env.get(e.name) }))
  on('env.set', (_, e) => { env.set(e.name, String(e.value)); return { value: undefined } })
  const launch = { id: 'worker-new' }
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: launch.id } }))
  on('tool.call', { tool: 'TodoWrite' }, (_, e) => ({ result: { newTodos: e.todos } }))
  on('process.run', (_, e) => {
    expect(e.argv).toContain('/fixture/track/hooks/stop-gate.py')
    snapshot = JSON.parse(env.get('TRACK_GATE_SNAPSHOT') ?? '{}')
    const payload = JSON.parse(e.init?.stdin ?? '{}')
    const live: string[] | undefined = Array.isArray(payload.background_tasks) ? payload.background_tasks.map((task: any) => task.id) : undefined
    const candidate = snapshot.candidates?.find((one: any) => one.kind === 'finished_delegation' && one.external_owner === false && one.owner_task_ids?.length > 0 && live !== undefined && !live.some(id => !snapshot.attributed_task_ids?.includes(id)) && !one.owner_task_ids.some((id: string) => live.includes(id)))
    const key = `${snapshot.turn_id}:finished_delegation`
    const knownResponse = snapshot.response?.turn_id === snapshot.turn_id && typeof snapshot.response?.request_id === 'string'
    const block = candidate !== undefined && knownResponse && !held.has(key)
    if (block) held.add(key)
    return { value: { exitCode: 0, stdout: JSON.stringify(block ? { decision: 'block', reason: FINISHED } : {}), stderr: '' } }
  })
  await $.turn.start({ text: 'Continue agreed work', turnId: 't1' } as never)
  return { ledger, activity, store, launch, snapshot: () => snapshot }
}

for (const activeTurnId of ['old-turn', 't1']) {
  test(`TRACK-30 lost completion notification still blocks local delegation from ${activeTurnId} once`, async ($, on) => {
    await prepare($, on, { activeTurnId })
    await response($)
    expect((await stop($)).block).toBe(FINISHED)
    expect((await stop($, [], { stop_hook_active: true })).block).toBeUndefined()
  })
}

for (const external_owner of [true, undefined]) {
  test(`TRACK-30 external scope ${external_owner} cannot block a delegated row`, async ($, on) => {
    await prepare($, on, { external_owner, followUp: true })
    await response($)
    expect((await stop($)).block).toBeUndefined()
  })
}

test('TRACK-30 real mark_step and Agent launch form the positive local workflow', async ($, on) => {
  const f = await prepare($, on, { status: 'pending', delegated: undefined, external_owner: undefined }, [])
  await invoke($, 'mcp__track__mark_step', { id: 'plan:1', status: 'in_progress', delegated: true, external_owner: false })
  expect((f.ledger.value.steps[0] as any).external_owner).toBe(false)
  expect((f.store.held.get(`s:${SESSION}`) as any).ledger.steps[0].external_owner).toBe(false)
  await invoke($, 'Agent', { run_in_background: true })
  await response($)
  expect((await stop($, [f.launch.id])).block).toBeUndefined()
  expect((await stop($)).block).toBe(FINISHED)
})

test('TRACK-30 an acknowledged finished task stays acknowledged next turn, but new work does not', async ($, on) => {
  const f = await prepare($, on, { followUp: true })
  await response($)
  await stop($)
  await invoke($, 'mcp__track__mark_step', { id: 'plan:1', status: 'in_progress', delegated: true, external_owner: false, note: 'Reviewed worker-1; preparing the next local review.' })
  await $.turn.start({ text: 'Continue', turnId: 't2' } as never)
  await response($)
  expect((await stop($)).block).toBeUndefined()
  await invoke($, 'mcp__track__mark_step', { id: 'plan:1', status: 'in_progress', delegated: true, external_owner: false })
  await invoke($, 'Agent', { run_in_background: true })
  expect((await stop($, [f.launch.id])).block).toBeUndefined()
  expect((await stop($)).block).toBe(FINISHED)
})

test('TRACK-30 acknowledging one finished task never acknowledges its still-running sibling', async ($, on) => {
  await prepare($, on, { followUp: true }, ['worker-1', 'worker-2'])
  await response($)
  expect((await stop($, ['worker-2'])).block).toBeUndefined()
  await invoke($, 'mcp__track__mark_step', { id: 'plan:1', status: 'in_progress', delegated: true, external_owner: false, note: 'Reviewed worker-1; worker-2 remains responsible.' })
  await $.turn.start({ text: 'Continue', turnId: 't2' } as never)
  await response($)
  expect((await stop($, ['worker-2'])).block).toBeUndefined()
  expect((await stop($)).block).toBe(FINISHED)
})

test('TRACK-30 reusing a task id drops its prior acknowledgement', async ($, on) => {
  const f = await prepare($, on, { followUp: true })
  await response($)
  await stop($)
  await invoke($, 'mcp__track__mark_step', { id: 'plan:1', status: 'in_progress', delegated: true, external_owner: false })
  await $.turn.start({ text: 'Continue', turnId: 't2' } as never)
  await invoke($, 'mcp__track__mark_step', { id: 'plan:1', status: 'in_progress', delegated: true, external_owner: false })
  f.launch.id = 'worker-1'
  await invoke($, 'Agent', { run_in_background: true })
  await response($)
  expect((await stop($, ['worker-1'])).block).toBeUndefined()
  expect((await stop($)).block).toBe(FINISHED)
})

test('TRACK-30 unchanged TodoWrite cannot acknowledge a completed delegated result', async ($, on) => {
  const f = await prepare($, on, { id: 'todo:review local work', source: 'todo', followUp: true })
  f.activity.value = { ...f.activity.value, owners: { 'worker-1': ['todo:review local work'] }, launchOwners: [{ task: 'worker-1', steps: [{ id: 'todo:review local work', subject: 'review local work' }] }] }
  await invoke($, 'TodoWrite', { todos: [{ content: 'Review local work', status: 'in_progress' }] })
  expect(f.ledger.value.steps[0]?.followUp).toBe(true)
  await response($)
  expect((await stop($)).block).toBe(FINISHED)
})

test('TRACK-30 an unrelated unattributed task or lost launch history stays nonblocking', async ($, on) => {
  const f = await prepare($, on, { followUp: true })
  await response($)
  expect((await stop($, ['unattributed-peer'])).block).toBeUndefined()
  f.activity.value = { ...f.activity.value, owners: {}, launchOwners: [] }
  expect((await stop($)).block).toBeUndefined()
})

test('TRACK-30 invalid external ownership is refused before changing the row', async ($, on) => {
  const f = await prepare($, on)
  const before = JSON.stringify(f.ledger.value)
  const result = await invoke($, 'mcp__track__mark_step', { id: 'plan:1', status: 'in_progress', delegated: true, external_owner: 'false' })
  expect(result.deny).toContain('external_owner')
  expect(JSON.stringify(f.ledger.value)).toBe(before)
})

test('TRACK-30 omitting scope after a local declaration makes the next delegation unknown', async ($, on) => {
  const f = await prepare($, on)
  await invoke($, 'mcp__track__mark_step', { id: 'plan:1', status: 'in_progress', delegated: true, note: 'A peer now owns the remaining work; exact scope is unknown.' })
  expect((f.ledger.value.steps[0] as any).external_owner).toBeUndefined()
  await invoke($, 'Agent', { run_in_background: true })
  await response($)
  expect((await stop($)).block).toBeUndefined()
})

for (const status of ['completed', 'waiting'] as const) {
  test(`TRACK-30 TodoWrite ${status} drops the retired delegation scope before a reopen`, async ($, on) => {
    const f = await prepare($, on, { id: 'todo:review local work', source: 'todo' })
    await invoke($, 'TodoWrite', { todos: [{ content: 'Review local work', status }] })
    expect((f.ledger.value.steps[0] as any).external_owner).toBeUndefined()
    await invoke($, 'mcp__track__mark_step', { id: 'todo:review local work', status: 'in_progress', delegated: true })
    expect((f.ledger.value.steps[0] as any).external_owner).toBeUndefined()
  })
}

test('TRACK-30 scope-only changes participate in the acknowledged checkpoint', async ($, on) => {
  const f = await prepare($, on)
  const first = JSON.parse(String((await invoke($, 'mcp__track__checkpoint', { expected_session: SESSION })).result))
  expect(first.ok).toBe(true)
  f.ledger.value = { ...f.ledger.value, steps: f.ledger.value.steps.map(step => ({ ...step, external_owner: true } as Step)) }
  const second = JSON.parse(String((await invoke($, 'mcp__track__checkpoint', { expected_session: SESSION })).result))
  expect(second.ok).toBe(true)
  expect(second.checksum).not.toBe(first.checksum)
  expect(second.revision).toBe(first.revision + 1)
})

test('TRACK-30 resume preserves declared scope but lost launch history stays nonblocking', async ($, on) => {
  on('classic.SessionStart', () => ({}))
  const f = await prepare($, on)
  expect(JSON.parse(String((await invoke($, 'mcp__track__checkpoint', { expected_session: SESSION })).result)).ok).toBe(true)
  f.ledger.value = { ...EMPTY, v: 1 }
  f.activity.value = { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [], owners: {}, launchOwners: [] }
  await $.classic.SessionStart({ source: 'resume', session_id: SESSION } as never)
  expect((f.ledger.value.steps[0] as any).external_owner).toBe(false)
  await response($)
  expect((await stop($)).block).toBeUndefined()
})
