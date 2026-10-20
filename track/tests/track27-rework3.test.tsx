// FIXTURE: TRACK-27 refuter pass 4. A step reopened while its own launched task still runs is
// live-owned (plan row 1), so it must not read as stale. The process.run stub applies the
// helper's stale rule; tests/helpers/test_track27_rework.py proves the real helper.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Activity, Ledger, Step } from '../types'

const stale = (id: string) => `track: ${id} is still in_progress, but no work owns it. Call mark_step with completed, paused, or waiting and the true result, then finish.`
const step = (extra: Partial<Step> = {}): Step => ({ id: 'plan:1', source: 'plan', subject: 'Finish the change', status: 'pending', ...extra })
const invoke = ($: Engine, tool: string, input: object = {}) => $.tool.call({ tool, tool_use_id: `${tool}-call`, ...input } as never)
const mark = ($: Engine, status: Step['status'], id = 'plan:1') => invoke($, 'mcp__track__mark_step', { id, status })
const response = ($: Engine, text = 'The requested work is ready.') => $.session.append({
  door: 'response', uuid: '11111111-2222-4333-8444-555555555555',
  message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
  origin: { kind: 'model', model: 'fixture' },
} as never)
const stop = ($: Engine, extra: object = {}) => $.classic.Stop({ session_id: SESSION, stop_hook_active: false, background_tasks: [], ...extra } as never)

type Sent = { candidates?: Array<{ kind: string; id?: string; owner_task_ids?: string[] }>; attributed_task_ids?: string[] }

const prepare = async ($: Engine, on: On, steps: Step[]) => {
  mock.clock(on)
  atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps })
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null, eventOrder: 0 })
  atomStore<Activity>(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [], owners: {} })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on)
  logs(on)
  const env = new Map<string, string>([['CLAUDE_PLUGIN_ROOT', '/fixture/track'], ['CLAUDE_CONFIG_DIR', '/fixture/config']])
  const bash = { value: { result: 'fixture success' } as { result: unknown } }
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, e, next) => next(e))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  on('tool.call', { tool: 'Bash' }, () => bash.value)
  on('env.get', (_, e) => ({ value: env.get(e.name) }))
  on('env.set', (_, e) => { env.set(e.name, String(e.value)); return { value: {} } })
  on('process.run', (_, e) => {
    const sent = JSON.parse(e.init?.env?.TRACK_GATE_SNAPSHOT ?? '{}') as Sent
    const running = ((JSON.parse(e.init?.stdin ?? '{}') as { background_tasks?: Array<{ id: string }> }).background_tasks ?? []).map(task => task.id)
    const row = sent.candidates?.find(c => c.kind === 'stale_in_progress' && c.owner_task_ids?.some(id => running.includes(id)) !== true && running.every(id => sent.attributed_task_ids?.includes(id) === true))
    const stdout = JSON.stringify(row?.id === undefined ? {} : { decision: 'block', reason: stale(row.id) })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.turn.start({ text: 'Continue the agreed work', turnId: 't1' } as never)
  const launch = (taskId: string) => {
    bash.value = { result: { backgroundTaskId: taskId } }
    return invoke($, 'Bash', { command: 'sleep 600', run_in_background: true })
  }
  return { launch, snapshot: () => JSON.parse(env.get('TRACK_GATE_SNAPSHOT') ?? '{}') }
}

for (const pause of ['completed', 'waiting'] as const) {
  test(`a step reopened after ${pause} while its own task still runs is live-owned, not stale`, async ($, on) => {
    const fixture = await prepare($, on, [step()])
    await mark($, 'in_progress')
    await fixture.launch('shell-9')
    await mark($, pause)
    await $.turn.start({ text: 'Continue the change', turnId: 't2' } as never)
    await mark($, 'in_progress')
    await response($)
    expect(fixture.snapshot().candidates).toContainEqual(expect.objectContaining({ kind: 'stale_in_progress', id: 'plan:1', owner_task_ids: ['shell-9'] }))
    expect((await stop($, { background_tasks: [{ id: 'shell-9', type: 'shell' }] })).block).toBeUndefined()
  })
}

// Pins for the two fail-open rules (green before and after this change).
test('a relaunch with an unknown owner leaves the task unattributed', async ($, on) => {
  const fixture = await prepare($, on, [step(), step({ id: 'plan:2', subject: 'Second change' })])
  await mark($, 'in_progress')
  await fixture.launch('shell-9')
  await mark($, 'in_progress', 'plan:2')
  await fixture.launch('shell-9')
  await response($)
  expect(fixture.snapshot().attributed_task_ids).not.toContain('shell-9')
})

test('at most 64 launched tasks stay attributed, newest kept', async ($, on) => {
  const fixture = await prepare($, on, [step()])
  await mark($, 'in_progress')
  for (let i = 0; i <= 64; i++) await fixture.launch(`shell-${i}`)
  await response($)
  expect(fixture.snapshot().attributed_task_ids).not.toContain('shell-0')
  expect(fixture.snapshot().attributed_task_ids).toContain('shell-64')
  expect(fixture.snapshot().attributed_task_ids).toHaveLength(64)
})
