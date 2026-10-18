// FIXTURE: TRACK-27 refuter pass 5. A task belongs to the row launched for it,
// not a later row that reuses its id. The helper receipt follows the real
// ownership rules; Python's helper suite independently exercises that boundary.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Activity, Ledger, Step } from '../types'

const FROM = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const TASK = 'shell-9'
const RUNNING = { background_tasks: [{ id: TASK, type: 'shell' }] }
const STALE = 'track: plan:1 is still in_progress, but no work owns it. Call mark_step with completed, paused, or waiting and the true result, then finish.'
const PREMATURE = 'track: plan:1 is completed while its owned task shell-9 is still running. Reopen or pause the step, or wait for that task, then finish.'
const step = (extra: Partial<Step> = {}): Step => ({ id: 'plan:1', source: 'plan', subject: 'Start the dev server', status: 'pending', ...extra })
const invoke = ($: Engine, tool: string, input: object = {}) => $.tool.call({ tool, tool_use_id: `${tool}-call`, ...input } as never)
const mark = ($: Engine, status: Step['status'], id = 'plan:1') => invoke($, 'mcp__track__mark_step', { id, status })
const response = ($: Engine) => $.session.append({
  door: 'response', uuid: '11111111-2222-4333-8444-555555555555',
  message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'The requested work is ready.' }] },
  origin: { kind: 'model', model: 'fixture' },
} as never)
const stop = ($: Engine) => $.classic.Stop({ session_id: SESSION, stop_hook_active: false, ...RUNNING } as never)

type Candidate = { kind: string; id?: string; owner_task_ids?: string[] }
type Sent = { candidates?: Candidate[]; attributed_task_ids?: string[] }

const prepare = async ($: Engine, on: On, steps: Step[] = [step()]) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps })
  const activity = atomStore<Activity>(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [], owners: {} })
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on, { [`s:${FROM}`]: { ledger: { ...EMPTY, v: 1, steps: [step({ subject: 'Write the migration' })] } } })
  logs(on)
  const env = new Map<string, string>([['CLAUDE_PLUGIN_ROOT', '/fixture/track'], ['CLAUDE_CONFIG_DIR', '/fixture/config']])
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, e, next) => next(e))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { backgroundTaskId: TASK } }))
  on('env.get', (_, e) => ({ value: env.get(e.name) }))
  on('env.set', (_, e) => { env.set(e.name, String(e.value)); return { value: undefined } })
  on('process.run', (_, e) => {
    const sent = JSON.parse(e.init?.env?.TRACK_GATE_SNAPSHOT ?? '{}') as Sent
    const running = ((JSON.parse(e.init?.stdin ?? '{}') as { background_tasks?: Array<{ id: string }> }).background_tasks ?? []).map(task => task.id)
    const completion = sent.candidates?.find(row => row.kind === 'premature_completion' && row.owner_task_ids?.some(id => running.includes(id)))
    const stale = sent.candidates?.find(row => row.kind === 'stale_in_progress' && row.owner_task_ids?.some(id => running.includes(id)) !== true && running.every(id => sent.attributed_task_ids?.includes(id) === true))
    const reason = completion !== undefined ? PREMATURE : stale !== undefined ? STALE : undefined
    return { value: { exitCode: 0, stdout: JSON.stringify(reason === undefined ? {} : { decision: 'block', reason }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.turn.start({ text: 'Start the agreed work', turnId: 't1' } as never)
  return { ledger, activity, snapshot: () => JSON.parse(env.get('TRACK_GATE_SNAPSHOT') ?? '{}') as Sent,
    launch: () => invoke($, 'Bash', { command: 'sleep 600', run_in_background: true }) }
}

for (const replacement of ['full-plan', 'restore'] as const) {
  test(`${replacement} replacement reusing plan:1 cannot inherit the old row's running task`, async ($, on) => {
    const fixture = await prepare($, on)
    await mark($, 'in_progress')
    await fixture.launch()
    await mark($, 'completed')
    await $.turn.start({ text: 'Write the new migration', turnId: 't2' } as never)
    const replaced = replacement === 'full-plan'
      ? await invoke($, 'mcp__track__track_steps', { steps: ['Write the migration'] })
      : await invoke($, 'mcp__track__restore_tracker', { from_session: FROM, replace: true })
    expect(replaced.deny).toBeUndefined()
    expect(fixture.ledger.value.steps).toContainEqual(expect.objectContaining({ id: 'plan:1', subject: 'Write the migration' }))
    await mark($, 'in_progress')
    await response($)
    expect((await stop($)).block).toBe(STALE)
    expect(fixture.snapshot().candidates).toContainEqual(expect.objectContaining({ kind: 'stale_in_progress', id: 'plan:1', owner_task_ids: [] }))
    expect(fixture.snapshot().attributed_task_ids).toContain(TASK)
    expect(fixture.activity.value.launchOwners).toContainEqual({ task: TASK, steps: [{ id: 'plan:1', subject: 'start the dev server' }] })
  })
}

test('completing a reopened row while its own launched task runs blocks premature completion', async ($, on) => {
  const fixture = await prepare($, on)
  await mark($, 'in_progress')
  await fixture.launch()
  await mark($, 'completed')
  await $.turn.start({ text: 'Continue the same work', turnId: 't2' } as never)
  await mark($, 'in_progress')
  await mark($, 'completed')
  await response($)
  expect((await stop($)).block).toBe(PREMATURE)
  expect(fixture.snapshot().candidates).toContainEqual(expect.objectContaining({ kind: 'premature_completion', id: 'plan:1', owner_task_ids: [TASK] }))
})

test('the unchanged reopened row stays live-owned while its own launched task runs', async ($, on) => {
  const fixture = await prepare($, on)
  await mark($, 'in_progress')
  await fixture.launch()
  await mark($, 'completed')
  await $.turn.start({ text: 'Continue the same work', turnId: 't2' } as never)
  await mark($, 'in_progress')
  await response($)
  expect(fixture.snapshot().candidates).toContainEqual(expect.objectContaining({ kind: 'stale_in_progress', id: 'plan:1', owner_task_ids: [TASK] }))
  expect((await stop($)).block).toBeUndefined()
})

test('inserting after a row keeps its launch ownership', async ($, on) => {
  const fixture = await prepare($, on)
  await mark($, 'in_progress')
  await fixture.launch()
  await invoke($, 'mcp__track__track_steps', { steps: ['Write the migration'], after: 'plan:1' })
  await response($)
  expect(fixture.activity.value.launchOwners).toContainEqual({ task: TASK, steps: [{ id: 'plan:1', subject: 'start the dev server' }] })
  expect((await stop($)).block).toBeUndefined()
})

for (const tool of ['TodoWrite', 'mcp__track__track_steps'] as const) {
  test(`${tool} preserves ownership of a retained todo row`, async ($, on) => {
    on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { newTodos: [{ content: 'Start the dev server!', status: 'in_progress' }] } }))
    const id = 'todo:start the dev server'
    const fixture = await prepare($, on, [step({ id, source: 'todo' })])
    await mark($, 'in_progress', id)
    await fixture.launch()
    await invoke($, tool, tool === 'TodoWrite' ? { todos: [{ content: 'Start the dev server!', status: 'in_progress' }] } : { steps: ['Write the migration'] })
    await response($)
    expect(fixture.activity.value.launchOwners).toContainEqual({ task: TASK, steps: [{ id, subject: 'start the dev server' }] })
    expect((await stop($)).block).toBeUndefined()
  })
}
