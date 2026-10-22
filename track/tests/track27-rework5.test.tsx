// FIXTURE: TRACK-27 refuter pass 6. Ownership follows id + normalized title,
// across replacement and clear-all, for both Bash and Agent launch sites.
// The controlled helper receipt follows the real helper's ownership decisions.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Activity, Ledger, Step } from '../types'

const FROM = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const TASK = 'shell-9'
const TODO = 'todo:start the dev server'
const step = (extra: Partial<Step> = {}): Step => ({ id: 'plan:1', source: 'plan', subject: 'Start the dev server', status: 'pending', ...extra })
const invoke = ($: Engine, tool: string, input: object = {}) => $.tool.call({ tool, tool_use_id: `${tool}-call`, ...input } as never)
const mark = ($: Engine, status: Step['status'], id = 'plan:1') => invoke($, 'mcp__track__mark_step', { id, status })
const response = ($: Engine) => $.session.append({
  door: 'response', uuid: '11111111-2222-4333-8444-555555555555',
  message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'The requested work is ready.' }] },
  origin: { kind: 'model', model: 'fixture' },
} as never)
const stop = ($: Engine, launcher: 'Bash' | 'Agent') => $.classic.Stop({
  session_id: SESSION, stop_hook_active: false, background_tasks: [{ id: TASK, type: launcher === 'Bash' ? 'shell' : 'agent' }],
} as never)
const stale = (id: string) => `track: ${id} is still in_progress, but no work owns it. Call mark_step with completed, paused, or waiting and the true result, then finish.`
type Candidate = { kind: string; id?: string; owner_task_ids?: string[] }
type Sent = { candidates?: Candidate[]; attributed_task_ids?: string[] }

const prepare = async ($: Engine, on: On, launcher: 'Bash' | 'Agent', steps: Step[] = [step()]) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps })
  atomStore<Activity>(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [], owners: {} })
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
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: TASK } }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { newTodos: [{ content: 'Start the dev server!', status: 'in_progress' }] } }))
  on('env.get', (_, e) => ({ value: env.get(e.name) }))
  on('env.set', (_, e) => { env.set(e.name, String(e.value)); return { value: {} } })
  on('process.run', (_, e) => {
    const sent = JSON.parse(e.init?.env?.TRACK_GATE_SNAPSHOT ?? '{}') as Sent
    const running = ((JSON.parse(e.init?.stdin ?? '{}') as { background_tasks?: Array<{ id: string }> }).background_tasks ?? []).map(task => task.id)
    const completion = sent.candidates?.find(row => row.kind === 'premature_completion' && row.owner_task_ids?.some(id => running.includes(id)))
    const owner = completion?.owner_task_ids?.find(id => running.includes(id))
    const abandoned = sent.candidates?.find(row => row.kind === 'stale_in_progress' && row.owner_task_ids?.some(id => running.includes(id)) !== true && running.every(id => sent.attributed_task_ids?.includes(id) === true))
    const reason = completion !== undefined
      ? `track: ${completion.id} is completed while its owned task ${owner} is still running. Reopen or pause the step, or wait for that task, then finish.`
      : abandoned?.id !== undefined ? stale(abandoned.id) : undefined
    return { value: { exitCode: 0, stdout: JSON.stringify(reason === undefined ? {} : { decision: 'block', reason }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.turn.start({ text: 'Start the agreed work', turnId: 't1' } as never)
  return { ledger, snapshot: () => JSON.parse(env.get('TRACK_GATE_SNAPSHOT') ?? '{}') as Sent,
    launch: () => invoke($, launcher, launcher === 'Bash' ? { command: 'sleep 600', run_in_background: true } : { prompt: 'Keep the dev server running', run_in_background: true }) }
}

for (const launcher of ['Bash', 'Agent'] as const) {
  test(`${launcher} P2: restore replacement preserves the same normalized todo's launch owner`, async ($, on) => {
    const fixture = await prepare($, on, launcher, [])
    await invoke($, 'TodoWrite', { todos: [{ content: 'Start the dev server!', status: 'in_progress' }] })
    await fixture.launch()
    const restored = await invoke($, 'mcp__track__restore_tracker', { from_session: FROM, replace: true })
    expect(restored.deny).toBeUndefined()
    await invoke($, 'TodoWrite', { todos: [{ content: 'Start the dev server!', status: 'in_progress' }] })
    await response($)
    expect((await stop($, launcher)).block).toBeUndefined()
    expect(fixture.snapshot().candidates).toContainEqual(expect.objectContaining({ kind: 'stale_in_progress', id: TODO, owner_task_ids: [TASK] }))
  })

  test(`${launcher} P4: full replacement preserves ownership for the same id and normalized title`, async ($, on) => {
    const fixture = await prepare($, on, launcher)
    await mark($, 'in_progress')
    await fixture.launch()
    await invoke($, 'mcp__track__track_steps', { steps: ['START the dev server!', 'Write the migration'], replace: true })
    await mark($, 'in_progress')
    await response($)
    expect((await stop($, launcher)).block).toBeUndefined()
    expect(fixture.snapshot().candidates).toContainEqual(expect.objectContaining({ kind: 'stale_in_progress', id: 'plan:1', owner_task_ids: [TASK] }))
  })

  for (const replacement of ['full-plan', 'restore-without-replace'] as const) {
    test(`${launcher} ${replacement === 'full-plan' ? 'P1' : 'P5'}: clear-all then ${replacement} cannot transfer ownership to a different title`, async ($, on) => {
      const fixture = await prepare($, on, launcher)
      await mark($, 'in_progress')
      await fixture.launch()
      await mark($, 'completed')
      const ui = await $.ui.mount(pane('dock'))
      await ui.press({ key: 'clear-steps' })
      expect(fixture.ledger.value.steps).toEqual([])
      await $.turn.start({ text: 'Write the new migration', turnId: 't2' } as never)
      const replaced = replacement === 'full-plan'
        ? await invoke($, 'mcp__track__track_steps', { steps: ['Write the migration'] })
        : await invoke($, 'mcp__track__restore_tracker', { from_session: FROM })
      expect(replaced.deny).toBeUndefined()
      expect(fixture.ledger.value.steps).toContainEqual(expect.objectContaining({ id: 'plan:1', subject: 'Write the migration' }))
      await mark($, 'in_progress')
      await response($)
      expect((await stop($, launcher)).block).toBe(stale('plan:1'))
      expect(fixture.snapshot().candidates).toContainEqual(expect.objectContaining({ kind: 'stale_in_progress', id: 'plan:1', owner_task_ids: [] }))
      expect(fixture.snapshot().attributed_task_ids).toContain(TASK)
    })
  }

  test(`${launcher} P3 pin: completing a replacement with a different title has no old launch owner`, async ($, on) => {
    const fixture = await prepare($, on, launcher)
    await mark($, 'in_progress')
    await fixture.launch()
    await invoke($, 'mcp__track__track_steps', { steps: ['Write the migration'], replace: true })
    await mark($, 'in_progress')
    await mark($, 'completed')
    await response($)
    expect((await stop($, launcher)).block).toBeUndefined()
    expect(fixture.snapshot().candidates?.some(row => row.kind === 'premature_completion')).toBe(false)
    expect(fixture.snapshot().attributed_task_ids).toContain(TASK)
  })
}
