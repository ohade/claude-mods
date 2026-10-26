// FIXTURE: TRACK-27 finding 5, Ohad's decision 2026-10-18 ("recheck after a block"). Every Stop
// after a block carries stop_hook_active; the freshness kinds still check, each once per turn.
// The process.run stub holds one claim per kind; tests/helpers/test_track27_recheck.py proves
// the real helper.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Activity, Ledger, Step } from '../types'

const STALE = 'track: plan:1 is still in_progress, but no work owns it. Call mark_step with completed, paused, or waiting and the true result, then finish.'
const WAITING = 'track: plan:2 is waiting, but the final reply has no 👉 plan:2: request line. Ask the user visibly, then finish.'
const step = (extra: Partial<Step> = {}): Step => ({ id: 'plan:1', source: 'plan', subject: 'Finish the change', status: 'pending', ...extra })
const invoke = ($: Engine, tool: string, input: object = {}) => $.tool.call({ tool, tool_use_id: `${tool}-call`, ...input } as never)
const mark = ($: Engine, status: Step['status'], id = 'plan:1') => invoke($, 'mcp__track__mark_step', { id, status })
const response = ($: Engine, text = 'The requested work is ready.') => $.session.append({
  door: 'response', uuid: '11111111-2222-4333-8444-555555555555',
  message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
  origin: { kind: 'model', model: 'fixture' },
} as never)
const stop = ($: Engine, extra: object = {}) => $.classic.Stop({ session_id: SESSION, stop_hook_active: false, background_tasks: [], ...extra } as never)

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
  const claimed = new Set<string>()
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, e, next) => next(e))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  on('env.get', (_, e) => ({ value: env.get(e.name) }))
  on('env.set', (_, e) => { env.set(e.name, String(e.value)); return { value: {} } })
  // Observed 2026-10-23: own-save publication also calls process.run; model only Stop claims, leaving blob publication unavailable.
  on('process.run', { argv: /^\/.*\/hooks\/stop-gate\.py$/ }, (_, e) => {
    const sent = JSON.parse(e.init?.env?.TRACK_GATE_SNAPSHOT ?? '{}') as { candidates?: Array<{ kind: string }> }
    const kind = sent.candidates?.[0]?.kind
    const reason = kind === 'stale_in_progress' ? STALE : kind === 'missing_waiting_request' ? WAITING : undefined
    const block = kind !== undefined && reason !== undefined && !claimed.has(kind)
    if (block) claimed.add(kind)
    return { value: { exitCode: 0, stdout: JSON.stringify(block ? { decision: 'block', reason } : {}), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.turn.start({ text: 'Continue the agreed work', turnId: 't1' } as never)
  return { claimed }
}

test('a Stop after a block still checks the other freshness kinds, each once per turn', async ($, on) => {
  const fixture = await prepare($, on, [step(), step({ id: 'plan:2', subject: 'Await approval' })])
  await mark($, 'in_progress')
  await mark($, 'waiting', 'plan:2')
  await response($)
  expect((await stop($)).block).toBe(STALE)
  expect((await stop($, { stop_hook_active: true })).block).toBe(WAITING)
  expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
  expect([...fixture.claimed]).toEqual(['stale_in_progress', 'missing_waiting_request'])
})

test('a first Stop that another hook continued still gets its freshness check', async ($, on) => {
  await prepare($, on, [step()])
  await mark($, 'in_progress')
  await response($)
  expect((await stop($, { stop_hook_active: true })).block).toBe(STALE)
  expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
})

test('a subagent Stop still checks nothing', async ($, on) => {
  const fixture = await prepare($, on, [step()])
  await mark($, 'in_progress')
  await response($)
  expect((await stop($, { agent_id: 'worker', stop_hook_active: true })).block).toBeUndefined()
  expect(fixture.claimed.size).toBe(0)
})
