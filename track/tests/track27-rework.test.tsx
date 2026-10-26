// FIXTURE: TRACK-27 refuter verdict 2, findings 1-4, 7 and 8. The real helper's
// decisions are proven in tests/helpers/test_track27_rework.py; this kit records the
// plugin's helper call and can make one turn write lose its compare-and-set.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Activity, Ledger, Step, Turn } from '../types'

const STALE = 'track: plan:1 is still in_progress, but no work owns it. Call mark_step with completed, paused, or waiting and the true result, then finish.'
const BASH = 'track: this turn ran Bash without a step update; reconcile a step when the command was work.'
const IDENTITY = 'track: current turn identity unavailable; reconcile steps before finishing.'
const step = (extra: Partial<Step> = {}): Step => ({ id: 'plan:1', source: 'plan', subject: 'Finish the change', status: 'pending', ...extra })
const invoke = ($: Engine, tool: string, input: object = {}) => $.tool.call({ tool, tool_use_id: `${tool}-call`, ...input } as never)
const mark = ($: Engine, status: Step['status'], id = 'plan:1') => invoke($, 'mcp__track__mark_step', { id, status })
const response = ($: Engine, text = 'The requested work is ready.') => $.session.append({
  door: 'response', uuid: '11111111-2222-4333-8444-555555555555',
  message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
  origin: { kind: 'model', model: 'fixture' },
} as never)
const stop = ($: Engine, extra: object = {}) => $.classic.Stop({ session_id: SESSION, stop_hook_active: false, background_tasks: [], ...extra } as never)

type HeldTurn = { value: Turn; version: number }
type Options = { env?: Record<string, string>; beforeTurnSet?: (held: HeldTurn, next: Turn) => void }

const prepare = async ($: Engine, on: On, steps: Step[] = [step()], options: Options = {}) => {
  mock.clock(on)
  atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps })
  const turn: HeldTurn = { value: { currentId: null, gatedTurnId: null, eventOrder: 0 }, version: 1 }
  on('state.get', { plugin: 'track', key: 'turn' }, () => ({ value: { value: turn.value, version: turn.version } }))
  on('state.set', { plugin: 'track', key: 'turn' }, (_, e) => {
    options.beforeTurnSet?.(turn, e.value as Turn)
    if (e.ifVersion !== undefined && e.ifVersion !== turn.version) return { value: { isSet: false as const, version: turn.version } }
    turn.value = e.value as Turn
    turn.version += 1
    return { value: { isSet: true as const, version: turn.version } }
  })
  const activity = atomStore<Activity>(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [], owners: {} })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on)
  const lines = logs(on)
  const env = new Map<string, string>(Object.entries(options.env ?? { CLAUDE_PLUGIN_ROOT: '/fixture/track', CLAUDE_CONFIG_DIR: '/fixture/config' }))
  const helper = { configs: [] as Array<string | undefined>, taken: false }
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, e, next) => next(e))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'fixture success' }))
  on('env.get', (_, e) => ({ value: env.get(e.name) }))
  on('env.set', (_, e) => { env.set(e.name, String(e.value)); return { value: {} } })
  // Observed 2026-10-23: own-save publication also calls process.run; model only Stop claims, leaving blob publication unavailable.
  on('process.run', { argv: /^\/.*\/hooks\/stop-gate\.py$/ }, (_, e) => {
    helper.configs.push(e.init?.env?.CLAUDE_CONFIG_DIR)
    const sent = JSON.parse(e.init?.env?.TRACK_GATE_SNAPSHOT ?? '{}') as { candidates?: Array<{ kind: string }> }
    const block = !helper.taken && sent.candidates?.some(row => row.kind === 'stale_in_progress') === true
    if (block) helper.taken = true
    return { value: { exitCode: 0, stdout: JSON.stringify(block ? { decision: 'block', reason: STALE } : {}), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.turn.start({ text: 'Continue the agreed work', turnId: 't1' } as never)
  return { turn, activity, lines, helper, snapshot: () => JSON.parse(env.get('TRACK_GATE_SNAPSHOT') ?? '{}') }
}

test('finding 1: with CLAUDE_CONFIG_DIR unset the plugin claims under HOME/.claude and blocks', async ($, on) => {
  const fixture = await prepare($, on, undefined, { env: { CLAUDE_PLUGIN_ROOT: '/fixture/track', HOME: '/fixture/home' } })
  await mark($, 'in_progress')
  await response($)
  expect((await stop($)).block).toBe(STALE)
  expect(fixture.helper.configs).toEqual(['/fixture/home/.claude'])
})

test('finding 2: steps inserted after a row do not make a prior-turn waiting row ask again', async ($, on) => {
  const fixture = await prepare($, on, [step(), step({ id: 'plan:2', subject: 'Await approval', status: 'waiting', activeTurnId: 'old' })])
  await invoke($, 'mcp__track__track_steps', { steps: ['Follow-up check'], after: 'plan:1' })
  await response($)
  expect(fixture.snapshot().candidates).toEqual([])
  expect((await stop($)).block).toBeUndefined()
})

test('finding 3: a waiting todo step whose id has spaces is satisfied by its own arrow', async ($, on) => {
  const fixture = await prepare($, on, [{ id: 'todo:ship it', source: 'todo', subject: 'Ship it', status: 'pending' }])
  await mark($, 'waiting', 'todo:ship it')
  await response($, 'The release is ready.\n👉 todo:ship it: Please approve the release.')
  expect(fixture.snapshot().response?.arrow_ids).toEqual(['todo:ship it'])
  expect(fixture.snapshot().candidates).toEqual([])
})

test('finding 4: the snapshot tells the helper which tasks have a recorded owner', async ($, on) => {
  const fixture = await prepare($, on)
  fixture.activity.value = { ...fixture.activity.value, owners: { 'worker-1': ['plan:1'] } }
  await mark($, 'in_progress')
  await response($)
  expect(fixture.snapshot().attributed_task_ids).toEqual(['worker-1'])
  fixture.activity.value = { ...fixture.activity.value, owners: undefined }
  await response($)
  expect(fixture.snapshot().attributed_task_ids).toEqual([])
})

test('finding 7: a held-kind write that retries into a new turn returns no block', async ($, on) => {
  let moved = false
  await prepare($, on, undefined, { beforeTurnSet: (held, next) => {
    if (moved || next.freshness?.held.includes('stale_in_progress') !== true) return
    moved = true // FIXTURE: a new turn starts between this write's read and its compare-and-set.
    held.value = { ...held.value, currentId: 't2', freshness: undefined }
    held.version += 1
  } })
  await mark($, 'in_progress')
  await response($)
  expect((await stop($)).block).toBeUndefined()
  expect(moved).toBe(true)
})

test('finding 7: a nudge another Stop recorded during the retry is not shown again', async ($, on) => {
  let raced = false
  const fixture = await prepare($, on, [], { beforeTurnSet: (held, next) => {
    if (raced || next.freshness?.nudged.includes('bash') !== true) return
    raced = true // FIXTURE: a concurrent Stop recorded and showed the same nudge first.
    held.value = { ...held.value, freshness: { ...next.freshness, nudged: ['bash'] } }
    held.version += 1
  } })
  await invoke($, 'Bash', { command: 'git status --porcelain' })
  await response($)
  expect((await stop($)).block).toBeUndefined()
  expect(raced).toBe(true)
  expect(fixture.lines.filter(line => line === BASH)).toHaveLength(0)
})

test('finding 8: a Stop without turn identity shows its nudge once per session', async ($, on) => {
  const fixture = await prepare($, on)
  fixture.turn.value = { ...fixture.turn.value, currentId: null }
  expect((await stop($)).block).toBeUndefined()
  expect((await stop($)).block).toBeUndefined()
  expect(fixture.lines.filter(line => line === IDENTITY)).toHaveLength(1)
})
