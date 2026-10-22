// FIXTURE: TRACK-27 refuter pass 3, both medium findings. The process.run stub applies
// the helper's stale rule; tests/helpers/test_track27_rework.py proves the real helper.
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
  return { bash, snapshot: () => JSON.parse(env.get('TRACK_GATE_SNAPSHOT') ?? '{}') }
}

test('pass 3 finding 1: a task stays attributed after its launch step completes, so another stale step still blocks', async ($, on) => {
  const fixture = await prepare($, on, [step(), step({ id: 'plan:2', subject: 'Second change' })])
  await mark($, 'in_progress')
  fixture.bash.value = { result: { backgroundTaskId: 'shell-9' } }
  await invoke($, 'Bash', { command: 'sleep 600', run_in_background: true })
  await mark($, 'completed')
  await $.turn.start({ text: 'Continue with the second change', turnId: 't2' } as never)
  await mark($, 'in_progress', 'plan:2')
  await response($)
  expect(fixture.snapshot().attributed_task_ids).toContain('shell-9')
  expect((await stop($, { background_tasks: [{ id: 'shell-9', type: 'shell' }] })).block).toBe(stale('plan:2'))
})

for (const [id, source] of [['restored:task:7', 'task'], ['todo:', 'todo']] as const) {
  test(`pass 3 finding 2: a waiting ${id} row is satisfied by its own arrow`, async ($, on) => {
    const fixture = await prepare($, on, [{ id, source, subject: 'Ship it', status: 'pending' }])
    await mark($, 'waiting', id)
    await response($, `The release is ready.\n👉 Note: this line names no step.\n👉 ${id}: Please approve the release.`)
    expect(fixture.snapshot().response?.arrow_ids).toEqual([id])
    expect(fixture.snapshot().candidates).toEqual([])
  })
}
