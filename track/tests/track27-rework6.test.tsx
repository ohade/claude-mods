// FIXTURE: TRACK-27 refuter 7b. Recreated rows keep their identity; evicting a
// launch identity must not turn its task into a legacy id-only owner.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Activity, Ledger, Step } from '../types'

const TASK = 'shell-9'
const TODO = 'todo:start the dev server'
const PREMATURE = 'track: todo:start the dev server is completed while its owned task shell-9 is still running. Reopen or pause the step, or wait for that task, then finish.'
const step = (extra: Partial<Step> = {}): Step => ({ id: 'plan:1', source: 'plan', subject: 'Start the dev server', status: 'pending', ...extra })
const invoke = ($: Engine, tool: string, input: object = {}) => $.tool.call({ tool, tool_use_id: `${tool}-call`, ...input } as never)
const mark = ($: Engine, status: Step['status'], id = 'plan:1') => invoke($, 'mcp__track__mark_step', { id, status })
const todos = ($: Engine, rows: Array<{ content: string; status: Step['status'] }>) => invoke($, 'TodoWrite', { todos: rows })
const response = ($: Engine) => $.session.append({
  door: 'response', uuid: '11111111-2222-4333-8444-555555555555',
  message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'The requested work is ready.' }] },
  origin: { kind: 'model', model: 'fixture' },
} as never)
const stop = ($: Engine, launcher: 'Bash' | 'Agent', task = TASK) => $.classic.Stop({
  session_id: SESSION, stop_hook_active: false, background_tasks: [{ id: task, type: launcher === 'Bash' ? 'shell' : 'agent' }],
} as never)
type Candidate = { kind: string; id?: string; owner_task_ids?: string[] }
type Sent = { candidates?: Candidate[]; attributed_task_ids?: string[] }

const prepare = async ($: Engine, on: On, launcher: 'Bash' | 'Agent', steps: Step[] = []) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps })
  const activity = atomStore<Activity>(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [], owners: {} })
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on)
  const lines = logs(on)
  const launch = { task: TASK }
  const env = new Map<string, string>([['CLAUDE_PLUGIN_ROOT', '/fixture/track'], ['CLAUDE_CONFIG_DIR', '/fixture/config']])
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, e, next) => next(e))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { backgroundTaskId: launch.task } }))
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: launch.task } }))
  on('tool.call', { tool: 'TodoWrite' }, (_, e) => ({ result: { newTodos: (e as unknown as { todos: unknown }).todos } }))
  on('env.get', (_, e) => ({ value: env.get(e.name) }))
  on('env.set', (_, e) => { env.set(e.name, String(e.value)); return { value: {} } })
  // Observed 2026-10-23: own-save publication also calls process.run; model only Stop claims, leaving blob publication unavailable.
  on('process.run', { argv: /^\/.*\/hooks\/stop-gate\.py$/ }, (_, e) => {
    const sent = JSON.parse(e.init?.env?.TRACK_GATE_SNAPSHOT ?? '{}') as Sent
    const running = ((JSON.parse(e.init?.stdin ?? '{}') as { background_tasks?: Array<{ id: string }> }).background_tasks ?? []).map(task => task.id)
    const completion = sent.candidates?.find(row => row.kind === 'premature_completion' && row.owner_task_ids?.some(id => running.includes(id)))
    const owner = completion?.owner_task_ids?.find(id => running.includes(id))
    const stale = sent.candidates?.find(row => row.kind === 'stale_in_progress' && row.owner_task_ids?.some(id => running.includes(id)) !== true)
    const unknown = stale !== undefined && running.some(id => sent.attributed_task_ids?.includes(id) !== true)
    const reason = completion !== undefined
      ? `track: ${completion.id} is completed while its owned task ${owner} is still running. Reopen or pause the step, or wait for that task, then finish.`
      : stale?.id !== undefined && !unknown ? `track: ${stale.id} is still in_progress, but no work owns it. Call mark_step with completed, paused, or waiting and the true result, then finish.` : undefined
    return { value: { exitCode: 0, stdout: JSON.stringify(reason === undefined ? {} : { decision: 'block', reason }),
      stderr: unknown ? 'track: owner identity unavailable; reconcile the step before finishing' : '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.turn.start({ text: 'Continue the agreed work', turnId: 't1' } as never)
  return { ledger, activity, lines, snapshot: () => JSON.parse(env.get('TRACK_GATE_SNAPSHOT') ?? '{}') as Sent,
    launch: (task = TASK) => {
      launch.task = task
      return invoke($, launcher, launcher === 'Bash' ? { command: 'sleep 600', run_in_background: true } : { prompt: 'Keep the dev server running', run_in_background: true })
    } }
}

for (const launcher of ['Bash', 'Agent'] as const) {
  for (const removal of ['clear-all', 'todo-drop', 'keep'] as const) {
    test(`${launcher}: completing the same todo after ${removal} still detects its running owner`, async ($, on) => {
      const fixture = await prepare($, on, launcher)
      await todos($, [{ content: 'Start the dev server', status: 'in_progress' }])
      await fixture.launch()
      if (removal === 'clear-all') {
        const ui = await $.ui.mount(pane('dock'))
        await ui.press({ key: 'clear-steps' })
      } else if (removal === 'todo-drop') {
        await todos($, [{ content: 'Write the migration', status: 'pending' }])
      }
      if (removal !== 'keep') expect(fixture.ledger.value.steps.some(row => row.id === TODO)).toBe(false)
      await todos($, [{ content: 'START the dev server!', status: 'completed' }])
      await response($)
      expect((await stop($, launcher)).block).toBe(PREMATURE)
      expect(fixture.snapshot().candidates).toContainEqual(expect.objectContaining({ kind: 'premature_completion', id: TODO, owner_task_ids: [TASK] }))
    })
  }
}

for (const completion of [false, true]) {
  test(`cap eviction makes the old task unknown before ${completion ? 'completion' : 'stale check'}`, { timeoutMs: 60000 }, async ($, on) => {
    const fixture = await prepare($, on, 'Bash', [step(), step({ id: 'plan:2', subject: 'Run the batch' })])
    await mark($, 'in_progress')
    await fixture.launch('t0')
    await mark($, 'paused')
    await mark($, 'in_progress', 'plan:2')
    for (let i = 1; i <= 63; i++) await fixture.launch(`t${i}`)
    await mark($, 'completed', 'plan:2')
    await mark($, 'in_progress', 'plan:2')
    await fixture.launch('t64')
    await mark($, 'completed', 'plan:2')
    await invoke($, 'mcp__track__track_steps', { steps: ['Write the migration'] })
    await mark($, 'in_progress')
    if (completion) await mark($, 'completed')
    await response($)
    expect((await stop($, 'Bash', 't0')).block).toBeUndefined()
    expect(fixture.activity.value.launchOwners).toHaveLength(64)
    expect(fixture.activity.value.launchOwners?.some(row => row.task === 't0')).toBe(false)
    expect(fixture.activity.value.owners?.t0).toBeUndefined()
    expect(fixture.activity.value.ownerOrder).not.toContain('t0')
    expect(fixture.snapshot().attributed_task_ids).not.toContain('t0')
    if (!completion) expect(fixture.lines.join('\n')).toMatch(/owner identity unavailable/)
  })
}
