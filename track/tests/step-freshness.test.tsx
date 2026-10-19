// FIXTURE: TRACK-27's approved Stop contract. The Python tests exercise the real
// exclusive claim file; this kit controls only the plugin's helper receipt.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Activity, Ledger, Step, Turn } from '../types'

const STALE = 'track: plan:1 is still in_progress, but no work owns it. Call mark_step with completed, paused, or waiting and the true result, then finish.'
const PREMATURE = 'track: plan:1 is completed while its owned task worker-1 is still running. Reopen or pause the step, or wait for that task, then finish.'
const WAITING = 'track: plan:1 is waiting, but the final reply has no 👉 plan:1: request line. Ask the user visibly, then finish.'
const EDIT = 'track: this turn changed files but no step was created or marked. Reuse a step with mark_step or register one with track_steps, then finish.'
const BASH = 'track: this turn ran Bash without a step update; reconcile a step when the command was work.'
const step = (extra: Partial<Step> = {}): Step => ({ id: 'plan:1', source: 'plan', subject: 'Finish the change', status: 'pending', ...extra })
const invoke = ($: Engine, tool: string, input: object = {}) => $.tool.call({ tool, tool_use_id: `${tool}-call`, ...input } as never)
const mark = ($: Engine, status: Step['status'], id = 'plan:1') => invoke($, 'mcp__track__mark_step', { id, status })
const response = ($: Engine, text = 'The requested work is ready.', extra: object = {}) => $.session.append({
  door: 'response', uuid: '11111111-2222-4333-8444-555555555555',
  message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
  origin: { kind: 'model', model: 'fixture' }, ...extra,
} as never)
const stop = ($: Engine, extra: object = {}) => $.classic.Stop({ session_id: SESSION, stop_hook_active: false, background_tasks: [], ...extra } as never)

const prepare = async ($: Engine, on: On, steps: Step[] = [step()]) => {
  const clock = mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps })
  const turn = atomStore<Turn>(on, 'turn', { currentId: null, gatedTurnId: null, eventOrder: 0 })
  const activity = atomStore<Activity>(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [], owners: {} })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on)
  const lines = logs(on)
  const lower = { block: undefined as string | undefined, context: [] as string[], payload: {} as { background_tasks?: Array<{ id: string }> } }
  const work = { value: { result: 'fixture success' } as { result?: unknown; deny?: string; isError?: boolean } }
  const claim = { kind: 'stale_in_progress', reason: STALE, taken: false, denied: false, calls: 0 }
  const env = new Map<string, string>([['CLAUDE_PLUGIN_ROOT', '/fixture/track'], ['CLAUDE_CONFIG_DIR', '/fixture/config']])
  const contexts: string[] = []
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, e, next) => next(e))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', (_, e) => { lower.payload = e; return { ...(lower.block !== undefined && { block: lower.block }), ...(lower.context.length > 0 && { additionalContext: lower.context }) } })
  on('prompt.submit', (_, e) => { contexts.push(...(e.context ?? [])); return { text: e.text } })
  on('tool.call', { tool: /^(Edit|Write|MultiEdit|NotebookEdit|Bash)$/ }, () => work.value)
  on('env.get', (_, e) => ({ value: env.get(e.name) }))
  on('env.set', (_, e) => { env.set(e.name, String(e.value)); return { value: undefined } })
  on('process.run', (_, e) => {
    expect(e.argv).toContain('/fixture/track/hooks/stop-gate.py')
    claim.calls++
    if (claim.denied) return { deny: 'fixture claim process denied' }
    const snapshot = JSON.parse(env.get('TRACK_GATE_SNAPSHOT') ?? '{}')
    const candidate = snapshot.candidates?.find((row: { kind: string }) => row.kind === claim.kind)
    const tasks = lower.payload.background_tasks
    const responseKnown = snapshot.response?.turn_id === snapshot.turn_id && typeof snapshot.response?.request_id === 'string'
    const needsOwner = claim.kind === 'stale_in_progress' || claim.kind === 'premature_completion'
    const ownerKnown = Array.isArray(candidate?.owner_task_ids) && Array.isArray(tasks)
    const ownsLive = ownerKnown && candidate.owner_task_ids.some((id: string) => tasks!.some(task => task.id === id))
    const eligible = candidate !== undefined && responseKnown && (!needsOwner || ownerKnown && (claim.kind === 'premature_completion' ? ownsLive : !ownsLive))
    const answer = eligible && !claim.taken ? { decision: 'block', reason: claim.reason } : {}
    if ('decision' in answer) claim.taken = true
    const stderr = !responseKnown ? 'track: main response receipt unavailable' : needsOwner && !ownerKnown ? 'track: owner or background task list unavailable' : ''
    return { value: { exitCode: 0, stdout: JSON.stringify(answer), stderr } }
  })
  await $.turn.start({ text: 'Continue the agreed work', turnId: 't1' } as never)
  return { ledger, turn, activity, lines, lower, work, claim, contexts, clock,
    snapshot: () => JSON.parse(env.get('TRACK_GATE_SNAPSHOT') ?? '{}') }
}

// FIXTURE: TRACK-30 (2026-10-19). Candidate publication and native Stop context are
// exercised here; test_finished_delegation_stop.py exercises the actual helper.
const delegatedRow = (extra: Partial<Step> = {}): Step => step({ status: 'in_progress', delegated: true, followUp: true, activeTurnId: 'old-turn', ...extra })
const finishedOwners = (a: Activity): Activity => ({ ...a, launchOwners: [{ task: 'worker-1', steps: [{ id: 'plan:1', subject: 'finish the change' }] }] })

for (const activeTurnId of ['old-turn', 't1']) {
  test(`TRACK-30 publishes a finished delegated row from ${activeTurnId}`, async ($, on) => {
    const f = await prepare($, on, [delegatedRow({ activeTurnId })])
    f.activity.value = finishedOwners(f.activity.value)
    await response($)
    await stop($)
    expect(f.snapshot().candidates).toContainEqual({ kind: 'finished_delegation', id: 'plan:1', owner_task_ids: ['worker-1'] })
  })
}

for (const extra of [{ followUp: undefined }, { delegated: false }, { cleared: true }, { status: 'paused' }, { status: 'completed' }, { status: 'waiting' }] as Partial<Step>[]) {
  test(`TRACK-30 does not publish an acknowledged or inactive row: ${JSON.stringify(extra)}`, async ($, on) => {
    const f = await prepare($, on, [delegatedRow(extra)])
    f.activity.value = finishedOwners(f.activity.value)
    await response($)
    await stop($)
    expect(f.snapshot().candidates.filter((row: { kind: string }) => row.kind === 'finished_delegation')).toEqual([])
  })
}

test('TRACK-30 an explicit update after completion acknowledges the follow-up', async ($, on) => {
  const f = await prepare($, on, [delegatedRow()])
  f.activity.value = finishedOwners(f.activity.value)
  await invoke($, 'mcp__track__mark_step', { id: 'plan:1', status: 'in_progress', delegated: true, note: 'Reviewed the result; another peer is still responsible.' })
  await response($)
  await stop($)
  expect(f.ledger.value.steps[0]?.followUp).toBeUndefined()
  expect(f.snapshot().candidates.filter((row: { kind: string }) => row.kind === 'finished_delegation')).toEqual([])
})

test('TRACK-30 a reused step id does not inherit the finished task of different work', async ($, on) => {
  const f = await prepare($, on, [delegatedRow({ subject: 'Different work' })])
  f.activity.value = finishedOwners(f.activity.value)
  await response($)
  await stop($)
  expect(f.snapshot().candidates.filter((row: { kind: string }) => row.kind === 'finished_delegation')).toEqual([])
})

test('TRACK-30 long-turn review is nonblocking, lists open rows and preserves lower context once', async ($, on) => {
  const f = await prepare($, on, [step(), step({ id: 'plan:2', status: 'paused' }), step({ id: 'plan:3', status: 'completed' })])
  f.lower.context = ['existing lower-hook context']
  await response($)
  await f.clock.advance(299_999)
  expect((await stop($)).additionalContext).toEqual(['existing lower-hook context'])
  await f.clock.advance(2)
  const reviewed = await stop($)
  expect(reviewed.block).toBeUndefined()
  expect(reviewed.additionalContext?.[0]).toBe('existing lower-hook context')
  const reminder = reviewed.additionalContext?.slice(1).join('\n') ?? ''
  expect(reminder).toContain('review open steps')
  expect(reminder).toContain('plan:1 (pending)')
  expect(reminder).toContain('plan:2 (paused)')
  expect(reminder).not.toContain('plan:3')
  expect((await stop($)).additionalContext).toEqual(['existing lower-hook context'])
})

test('TRACK-30 the long-turn reminder resets next turn and never runs for a subagent', async ($, on) => {
  const f = await prepare($, on)
  await response($)
  await f.clock.advance(300_001)
  expect((await stop($, { agent_id: 'worker-1' })).additionalContext).toBeUndefined()
  expect((await stop($)).additionalContext?.join('\n')).toContain('review open steps')
  await $.turn.start({ text: 'Continue the agreed work', turnId: 't2' } as never)
  expect((await stop($)).additionalContext).toBeUndefined()
  await f.clock.advance(300_001)
  await response($)
  expect((await stop($)).additionalContext?.join('\n')).toContain('review open steps')
})

test('stale current-turn step blocks once without a live owner', async ($, on) => {
  const fixture = await prepare($, on)
  await mark($, 'in_progress')
  await response($)
  expect((await stop($)).block).toBe(STALE)
  expect(fixture.claim.calls).toBe(1)
  expect((await stop($)).block).toBeUndefined()
  await mark($, 'completed')
  expect((await stop($)).block).toBeUndefined()
})

for (const exempt of ['prior-turn', 'delegated', 'live-owner', 'cleared'] as const) {
  test(`stale-step gate exempts ${exempt} work`, async ($, on) => {
    const fixture = await prepare($, on, [step({ status: 'in_progress', activeTurnId: exempt === 'prior-turn' ? 'old' : 't1', ...(exempt === 'delegated' && { delegated: true }), ...(exempt === 'cleared' && { cleared: true }) })])
    if (exempt === 'live-owner') fixture.activity.value = { ...fixture.activity.value, owners: { 'worker-1': ['plan:1'] } }
    await response($)
    expect((await stop($, { background_tasks: exempt === 'live-owner' ? [{ id: 'worker-1', type: 'agent' }] : [] })).block).toBeUndefined()
  })
}

test('missing Stop task list or main response nudges and passes', async ($, on) => {
  const fixture = await prepare($, on)
  await mark($, 'in_progress')
  expect((await stop($)).block).toBeUndefined()
  await response($)
  expect((await stop($, { background_tasks: undefined })).block).toBeUndefined()
  expect(fixture.lines.join('\n')).toMatch(/response|task list|background/i)
})

test('owned running task prevents premature completion; unrelated task does not', async ($, on) => {
  const fixture = await prepare($, on)
  fixture.claim.kind = 'premature_completion'
  fixture.claim.reason = PREMATURE
  await mark($, 'in_progress')
  fixture.activity.value = { ...fixture.activity.value, owners: { 'worker-1': ['plan:1'], other: ['plan:2'] }, background: ['worker-1', 'other'] }
  await mark($, 'completed')
  expect(fixture.activity.value.owners?.['worker-1']).toBeUndefined()
  await response($)
  expect((await stop($, { background_tasks: [{ id: 'other', type: 'agent' }] })).block).toBeUndefined()
  expect((await stop($, { background_tasks: [{ id: 'worker-1', type: 'agent' }] })).block).toBe(PREMATURE)
  expect(fixture.snapshot().v).toBe(2)
  expect(fixture.snapshot().candidates).toContainEqual(expect.objectContaining({ kind: 'premature_completion', id: 'plan:1', owner_task_ids: ['worker-1'] }))
})

for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
  test(`successful ${tool} without step receipt blocks`, async ($, on) => {
    const fixture = await prepare($, on, [])
    fixture.claim.kind = 'untracked_edit'
    fixture.claim.reason = EDIT
    await invoke($, tool)
    await response($)
    expect((await stop($)).block).toBe(EDIT)
    expect((await stop($)).block).toBeUndefined()
  })
}

for (const outcome of ['denied', 'failed', 'subagent'] as const) {
  test(`${outcome} Edit supplies no main-turn file-write receipt`, async ($, on) => {
    const fixture = await prepare($, on, [])
    fixture.claim.kind = 'untracked_edit'
    fixture.claim.reason = EDIT
    fixture.work.value = outcome === 'denied' ? { deny: 'fixture denial' } : outcome === 'failed' ? { result: 'fixture failure', isError: true } : { result: 'fixture success' }
    await invoke($, 'Edit', outcome === 'subagent' ? { agentId: 'worker' } : {})
    await response($)
    expect((await stop($)).block).toBeUndefined()
  })
}

test('Bash-only and doorbell do not hard-block; Bash nudges once and reminds the next prompt', async ($, on) => {
  const fixture = await prepare($, on, [])
  fixture.claim.kind = 'untracked_edit'
  fixture.claim.reason = EDIT
  await invoke($, 'Bash', { command: 'git status --porcelain' })
  await response($)
  expect((await stop($)).block).toBeUndefined()
  expect((await stop($)).block).toBeUndefined()
  expect(fixture.lines.filter(line => line === BASH)).toHaveLength(1)
  await $.prompt.submit({ text: 'Continue the agreed work', origin: { kind: 'composer' } } as never)
  expect(fixture.contexts.join('\n')).toContain(BASH)
  await $.turn.start({ text: ': AMQ doorbell', turnId: 't2' } as never)
  await $.prompt.submit({ text: ': AMQ doorbell run amq drain --include-body then act on it', origin: { kind: 'peer' } } as never)
  await response($)
  expect((await stop($)).block).toBeUndefined()
  expect(fixture.lines.filter(line => line === BASH)).toHaveLength(1)
})

for (const receipt of ['track_steps', 'mark_step', 'TaskCreate', 'TaskUpdate', 'TodoWrite'] as const) {
  test(`successful ${receipt} counts as this turn's step receipt`, async ($, on) => {
    on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '7' } } }))
    on('tool.call', { tool: 'TaskUpdate' }, () => ({ result: { success: true } }))
    on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { newTodos: [{ content: 'Finish', status: 'pending' }] } }))
    const fixture = await prepare($, on, receipt === 'TaskUpdate' ? [step({ taskId: '7' })] : undefined)
    fixture.claim.kind = 'untracked_edit'
    fixture.claim.reason = EDIT
    const inputs = { track_steps: { steps: ['Finish'] }, mark_step: { id: 'plan:1', status: 'completed' }, TaskCreate: { subject: 'Finish', description: 'Finish' }, TaskUpdate: { taskId: '7', status: 'completed' }, TodoWrite: { todos: [{ content: 'Finish', status: 'pending' }] } }
    await invoke($, receipt.includes('_') ? `mcp__track__${receipt}` : receipt, inputs[receipt])
    await invoke($, 'Edit')
    await response($)
    expect(fixture.snapshot()).toMatchObject({ v: 2, candidates: [] })
    expect((await stop($)).block).toBeUndefined()
  })
}

for (const text of ['A status note.', '👉 plan:2: Please approve.', '```text\n👉 plan:1: Please approve.\n```', '> 👉 plan:1: Please approve.', '👉 plan:1:   ']) {
  test(`waiting step needs its own visible request, excluding ${JSON.stringify(text)}`, async ($, on) => {
    const fixture = await prepare($, on)
    fixture.claim.kind = 'missing_waiting_request'
    fixture.claim.reason = WAITING
    await mark($, 'waiting')
    await response($, text)
    expect((await stop($)).block).toBe(WAITING)
    expect((await stop($)).block).toBeUndefined()
  })
}

test('the full 1200-character main reply can put its waiting arrow after character 1000', async ($, on) => {
  const fixture = await prepare($, on)
  fixture.claim.kind = 'missing_waiting_request'
  fixture.claim.reason = WAITING
  await mark($, 'waiting')
  await response($, `${'x'.repeat(1200)}\n👉 plan:1: Please approve the result.`)
  expect(fixture.turn.value.lastText?.text).not.toContain('👉')
  expect((await stop($)).block).toBeUndefined()
})

test('two waiting steps with one arrow still require the other step request', async ($, on) => {
  const fixture = await prepare($, on, [step(), step({ id: 'plan:2', subject: 'Second check' })])
  fixture.claim.kind = 'missing_waiting_request'
  fixture.claim.reason = WAITING
  await mark($, 'waiting')
  await mark($, 'waiting', 'plan:2')
  await response($, '👉 plan:2: Please approve this check.')
  expect((await stop($)).block).toBe(WAITING)
})

test('a prior-turn waiting step requires no repeated ask', async ($, on) => {
  const fixture = await prepare($, on, [step({ status: 'waiting', activeTurnId: 'old' })])
  fixture.claim.kind = 'missing_waiting_request'
  fixture.claim.reason = WAITING
  await response($)
  expect((await stop($)).block).toBeUndefined()
})

// stop_hook_active no longer bypasses freshness (Ohad, 2026-10-18): track27-recheck.test.tsx.
for (const bypass of [{ agent_id: 'worker' }]) {
  test(`Stop bypass ${JSON.stringify(bypass)} does not consume a freshness hold`, async ($, on) => {
    const fixture = await prepare($, on)
    await mark($, 'in_progress')
    await response($)
    expect((await stop($, bypass)).block).toBeUndefined()
    expect(fixture.claim.calls).toBe(0)
    expect((await stop($)).block).toBe(STALE)
  })
}

test('fallback then plugin shares one hold and respects the lower hook block', async ($, on) => {
  const fixture = await prepare($, on)
  await mark($, 'in_progress')
  await response($)
  fixture.lower.block = STALE
  fixture.claim.taken = true // FIXTURE: the ordinary helper already claimed this kind.
  expect((await stop($)).block).toBe(STALE)
  expect(fixture.claim.calls).toBe(0)
  fixture.lower.block = undefined
  expect((await stop($)).block).toBeUndefined()
})

test('plugin then fallback shares one hold', async ($, on) => {
  const fixture = await prepare($, on)
  await mark($, 'in_progress')
  await response($)
  expect((await stop($)).block).toBe(STALE)
  expect(fixture.claim.taken).toBe(true)
  // The test engine has no $.process to run the fallback here. The fallback reads this snapshot and
  // skips a held kind; the real helper proves it in test_step_freshness_stop.py
  // (fallback_then_plugin_and_plugin_then_fallback_share_one_claim, snapshot_held_kind_cannot_block_twice).
  expect(fixture.snapshot().held).toContain('stale_in_progress')
  expect((await stop($)).block).toBeUndefined()
})

test('a denied shared claim logs a nudge and passes', async ($, on) => {
  const fixture = await prepare($, on)
  fixture.claim.denied = true
  await mark($, 'in_progress')
  await response($)
  expect((await stop($)).block).toBeUndefined()
  expect(fixture.lines.join('\n')).toMatch(/claim.*(denied|unavailable|failed)/i)
})

test('a new turn clears old work receipts and held kinds', async ($, on) => {
  const fixture = await prepare($, on, [])
  fixture.claim.kind = 'untracked_edit'
  fixture.claim.reason = EDIT
  await invoke($, 'Edit')
  await response($)
  expect((await stop($)).block).toBe(EDIT)
  await $.turn.start({ text: 'Continue', turnId: 't2' } as never)
  fixture.claim.taken = false
  await response($)
  expect((await stop($)).block).toBeUndefined()
  await invoke($, 'Edit')
  await response($)
  expect((await stop($)).block).toBe(EDIT)
})
