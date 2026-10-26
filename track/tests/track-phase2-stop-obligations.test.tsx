// FIXTURE: contract-stop-r1 (scope item 3, boundaries 2-4). classic.Stop is skipped on this host only
// some of the time, so the reminders and the background banner must reach the next main prompt either
// way, exactly once. "Skipped" fixtures never raise classic.Stop. turn.complete's activity update
// (isWorking false for the finished turn) is modelled on the atom; its save path is out of scope here.
// The inventory file models what stop-gate.py writes (D5); test_stop_inventory.py pins the writer.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Activity, Ledger, Step, Turn } from '../types'

const BASH = 'track: this turn ran Bash without a step update; reconcile a step when the command was work.'
const RESULT_LINE = 'track: missing completion result for plan:1.'
const OWNER = 'track-stop-inventory-v1'
const CONFIG = '/fixture/config'
const OTHER = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'
const step = (extra: Partial<Step> = {}): Step => ({ id: 'plan:1', source: 'plan', subject: 'Finish the change', status: 'pending', ...extra })

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
const inventoryPath = async (session = SESSION) => `${CONFIG}/state/track/stop-inventory/${await sha256(session)}.json`

const prepare = async ($: Engine, on: On, steps: Step[] = [step()]) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps })
  const turn = atomStore<Turn>(on, 'turn', { currentId: null, gatedTurnId: null, eventOrder: 0 })
  const activity = atomStore<Activity>(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [], owners: {} })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on)
  const lines = logs(on)
  const env = new Map<string, string>([['CLAUDE_CONFIG_DIR', CONFIG]])
  const files = new Map<string, string>()
  const contexts: string[] = []
  const session = { id: SESSION }
  const launches: string[] = []
  on('session.id', () => ({ value: session.id }))
  on('session.append', (_, e, next) => next(e))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  on('command.list', () => ({ value: [{ name: 'help', description: 'help', source: 'builtin' as const }] }))
  on('prompt.submit', (_, e) => { contexts.push(...(e.context ?? [])); return { text: e.text } })
  on('tool.call', { tool: 'Bash' }, () => {
    const id = launches.shift()
    return id === undefined ? { result: 'fixture command finished' } : { result: { backgroundTaskId: id } } as never
  })
  on('env.get', (_, e) => ({ value: env.get(e.name) }))
  on('env.set', (_, e) => { env.set(e.name, String(e.value)); return { value: {} } })
  on('fs.read', (_, e) => {
    const body = files.get(e.path)
    if (body === undefined) throw new Error(`ENOENT: no such file, open '${e.path}'`)
    return { value: body }
  })
  // classic.Stop claims: no freshness candidate in these fixtures blocks; a quiet receipt is enough.
  on('process.run', { argv: /^\/.*\/hooks\/stop-gate\.py$/ }, () => ({ value: { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  return { ledger, turn, activity, lines, files, contexts, session, launches,
    snapshot: () => JSON.parse(env.get('TRACK_GATE_SNAPSHOT') ?? '{}') as { turn_id?: string; launch_seq?: number } }
}

const start = ($: Engine, turnId: string) => $.turn.start({ text: 'Continue the agreed work', turnId } as never)
let calls = 0
const invoke = ($: Engine, tool: string, input: object = {}) => $.tool.call({ tool, tool_use_id: `${tool}-call-${++calls}`, ...input } as never)
const ask = ($: Engine, text = 'Continue the agreed work.') => $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
const stop = ($: Engine, extra: object = {}) => $.classic.Stop({ session_id: SESSION, stop_hook_active: false, background_tasks: [], ...extra } as never)
const launch = ($: Engine, fixture: Awaited<ReturnType<typeof prepare>>, id: string) => {
  fixture.launches.push(id)
  return invoke($, 'Bash', { command: `sleep 999 # ${id}`, run_in_background: true })
}
// turn.complete's effect on the banner state: the finished turn stops working.
const finish = (fixture: Awaited<ReturnType<typeof prepare>>, turnId: string) => {
  fixture.activity.value = { ...fixture.activity.value, isWorking: false, mainTurnId: turnId }
}
const count = (contexts: string[], text: string) => contexts.filter(line => line.includes(text)).length

test('O1 skipped Stop: the next prompt carries the missing-result reminder once, later prompts none', async ($, on) => {
  const fixture = await prepare($, on)
  await start($, 't1')
  await invoke($, 'mcp__track__mark_step', { id: 'plan:1', status: 'completed' })
  finish(fixture, 't1')
  await ask($)
  expect(count(fixture.contexts, RESULT_LINE)).toBe(1)
  await ask($, 'Continue again.')
  expect(count(fixture.contexts, RESULT_LINE)).toBe(1)
})

test('O2 classic Stop ran: still exactly one missing-result line at the next prompt', async ($, on) => {
  const fixture = await prepare($, on)
  await start($, 't1')
  await invoke($, 'mcp__track__mark_step', { id: 'plan:1', status: 'completed' })
  await stop($)
  finish(fixture, 't1')
  await ask($)
  await ask($, 'Continue again.')
  expect(count(fixture.contexts, RESULT_LINE)).toBe(1)
})

test('O3 skipped Stop: the next prompt carries the Bash nudge once, later prompts none', async ($, on) => {
  const fixture = await prepare($, on, [])
  await start($, 't1')
  await invoke($, 'Bash', { command: 'git status --porcelain' })
  finish(fixture, 't1')
  await ask($)
  expect(count(fixture.contexts, BASH)).toBe(1)
  await ask($, 'Continue again.')
  expect(count(fixture.contexts, BASH)).toBe(1)
})

test('O4 classic Stop ran: still exactly one Bash nudge line at the next prompt', async ($, on) => {
  const fixture = await prepare($, on, [])
  await start($, 't1')
  await invoke($, 'Bash', { command: 'git status --porcelain' })
  await stop($)
  finish(fixture, 't1')
  await ask($)
  await ask($, 'Continue again.')
  expect(count(fixture.contexts, BASH)).toBe(1)
})

test('O5 a prompt typed while the turn still works gets neither reminder for that turn', async ($, on) => {
  const fixture = await prepare($, on)
  await start($, 't1')
  await invoke($, 'Bash', { command: 'git status --porcelain' })
  await invoke($, 'mcp__track__mark_step', { id: 'plan:1', status: 'completed' })
  expect(fixture.activity.value.isWorking).toBe(true)
  await ask($, 'Also check the logs.')
  expect(count(fixture.contexts, BASH)).toBe(0)
  expect(count(fixture.contexts, RESULT_LINE)).toBe(0)
})

test('O6 after an owner switch the new session sees no reminder from the old session', async ($, on) => {
  const fixture = await prepare($, on)
  await start($, 't1')
  await invoke($, 'Bash', { command: 'git status --porcelain' })
  await invoke($, 'mcp__track__mark_step', { id: 'plan:1', status: 'completed' })
  finish(fixture, 't1')
  fixture.session.id = OTHER
  await ask($)
  expect(count(fixture.contexts, BASH)).toBe(0)
  expect(count(fixture.contexts, RESULT_LINE)).toBe(0)
})

const inventory = async (fixture: Awaited<ReturnType<typeof prepare>>, row: Record<string, unknown>, session = SESSION) => {
  fixture.files.set(await inventoryPath(session), JSON.stringify(row))
}
const banner = (fixture: Awaited<ReturnType<typeof prepare>>) => [...fixture.activity.value.background, ...(fixture.activity.value.tasks ?? [])].sort()

// Two tasks launched in t0 and still in the banner when t1 starts; t1's turn.start publishes the snapshot.
const twoTasks = async ($: Engine, fixture: Awaited<ReturnType<typeof prepare>>) => {
  await start($, 't0')
  await launch($, fixture, 'a')
  await launch($, fixture, 'b')
  finish(fixture, 't0')
  await start($, 't1')
  expect(banner(fixture)).toEqual(['a', 'b'])
  return fixture.snapshot().launch_seq
}

test('B1 skipped Stop: an inventory without task b drops b at the next prompt and keeps a', async ($, on) => {
  const fixture = await prepare($, on, [])
  const seq = await twoTasks($, fixture)
  await inventory(fixture, { owner: OWNER, session_id: SESSION, turn_id: 't1', launch_seq: seq, task_ids: ['a'], complete: true })
  finish(fixture, 't1')
  await ask($)
  expect(banner(fixture)).toEqual(['a'])
})

test('B2 a task launched after the inventory snapshot is kept although the inventory omits it', async ($, on) => {
  const fixture = await prepare($, on, [])
  await start($, 't0')
  await launch($, fixture, 'a')
  finish(fixture, 't0')
  await start($, 't1')
  const seq = fixture.snapshot().launch_seq
  await launch($, fixture, 'b')
  await inventory(fixture, { owner: OWNER, session_id: SESSION, turn_id: 't1', launch_seq: seq, task_ids: ['a'], complete: true })
  finish(fixture, 't1')
  await ask($)
  expect(banner(fixture)).toEqual(['a', 'b'])
})

const unusable: Array<[string, (seq: unknown) => Record<string, unknown> | 'none' | 'malformed', string?]> = [
  ['no inventory file', () => 'none'],
  ['malformed JSON', () => 'malformed'],
  ['complete false', seq => ({ owner: OWNER, session_id: SESSION, turn_id: 't1', launch_seq: seq, task_ids: [], complete: false })],
  ['another session inside the file', seq => ({ owner: OWNER, session_id: OTHER, turn_id: 't1', launch_seq: seq, task_ids: [], complete: true })],
  ['another session file only', seq => ({ owner: OWNER, session_id: OTHER, turn_id: 't1', launch_seq: seq, task_ids: [], complete: true }), OTHER],
  ['another turn', seq => ({ owner: OWNER, session_id: SESSION, turn_id: 't0', launch_seq: seq, task_ids: [], complete: true })],
  ['foreign owner marker', seq => ({ owner: 'someone-else', session_id: SESSION, turn_id: 't1', launch_seq: seq, task_ids: [], complete: true })],
]
for (const [name, build, session] of unusable) {
  test(`B3 ${name}: the banner is unchanged`, async ($, on) => {
    const fixture = await prepare($, on, [])
    const seq = await twoTasks($, fixture)
    const row = build(seq)
    if (row === 'malformed') fixture.files.set(await inventoryPath(), '{"owner": "track-stop-inventory-v1", "task_ids": [')
    else if (row !== 'none') await inventory(fixture, row, session ?? SESSION)
    finish(fixture, 't1')
    await ask($)
    expect(banner(fixture)).toEqual(['a', 'b'])
  })
}

test('B4 classic Stop ran: its replacement stands, the inventory changes nothing more, notifications still clear', async ($, on) => {
  const fixture = await prepare($, on, [])
  const seq = await twoTasks($, fixture)
  await stop($, { background_tasks: [{ id: 'a', type: 'shell', status: 'running', description: 'fixture' }] })
  expect(banner(fixture)).toEqual(['a'])
  await inventory(fixture, { owner: OWNER, session_id: SESSION, turn_id: 't1', launch_seq: seq, task_ids: ['a'], complete: true })
  finish(fixture, 't1')
  await ask($)
  expect(banner(fixture)).toEqual(['a'])
  await $.prompt.submit({ text: '<task-notification><task-id>a</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' } } as never)
  expect(banner(fixture)).toEqual([])
})

const FOLLOW_UP = 'track: background work finished while plan:1 is still in_progress; update it with mcp__track__mark_step.'

test('O7 a builtin command in the window leaves the banner and follow-up flags alone; the next typed prompt drops and nudges once', async ($, on) => {
  const fixture = await prepare($, on, [step({ status: 'in_progress', activeTurnId: 't0' })])
  await start($, 't0')
  await launch($, fixture, 'a')
  finish(fixture, 't0')
  await start($, 't1')
  const seq = fixture.snapshot().launch_seq
  await inventory(fixture, { owner: OWNER, session_id: SESSION, turn_id: 't1', launch_seq: seq, task_ids: [], complete: true })
  finish(fixture, 't1')
  await $.prompt.submit({ text: '/help', origin: { kind: 'composer' } } as never)
  expect(banner(fixture)).toEqual(['a'])
  expect((fixture.ledger.value.steps[0] as Step & { followUp?: true }).followUp).toBeUndefined()
  expect(count(fixture.contexts, FOLLOW_UP)).toBe(0)
  await ask($)
  expect(banner(fixture)).toEqual([])
  expect((fixture.ledger.value.steps[0] as Step & { followUp?: true }).followUp).toBe(true)
  expect(count(fixture.contexts, FOLLOW_UP)).toBe(1)
  await ask($, 'Continue again.')
  expect(count(fixture.contexts, FOLLOW_UP)).toBe(1)
})

test('O8 a task notification first after a skipped Stop: the next typed prompt still carries each reminder once', async ($, on) => {
  const fixture = await prepare($, on)
  const notify = () => $.prompt.submit({ text: '<task-notification><task-id>gone</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' } } as never)
  // Turn t1 completes a step without result_text; a notification turn comes first.
  await start($, 't1')
  await invoke($, 'mcp__track__mark_step', { id: 'plan:1', status: 'completed' })
  finish(fixture, 't1')
  await notify()
  expect(count(fixture.contexts, RESULT_LINE)).toBe(0)
  await start($, 't1n')
  finish(fixture, 't1n')
  await ask($)
  expect(count(fixture.contexts, RESULT_LINE)).toBe(1)
  // Turn t2 runs Bash only; again a notification turn comes first.
  await start($, 't2')
  await invoke($, 'Bash', { command: 'git status --porcelain' })
  finish(fixture, 't2')
  await notify()
  expect(count(fixture.contexts, BASH)).toBe(0)
  await start($, 't2n')
  finish(fixture, 't2n')
  await ask($, 'Continue the next part.')
  expect(count(fixture.contexts, BASH)).toBe(1)
  await ask($, 'Continue again.')
  expect(count(fixture.contexts, RESULT_LINE)).toBe(1)
  expect(count(fixture.contexts, BASH)).toBe(1)
})
