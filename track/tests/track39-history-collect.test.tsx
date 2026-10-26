// FIXTURE: TRACK-39 A2 client rows (contract r2, c7d93fd6). After a successful flagged save the client
// calls history.py collect at most once an hour per module, with no write grant open, protecting its own
// session and any historyPending session; a collect failure changes nothing. The history.py model here
// answers bind, read, save and collect only.
import { expect, mock, test } from 'claude-code/testing'
import type { ProcessRunResult } from 'claude-code'
import type { Ledger } from '../types'
import { EMPTY, atomStore, blobPool, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'

const CONFIG = '/fixture/config'
const SESSION = '39393939-2222-4000-8000-000000000001'
const OTHER = '39393939-2222-4000-8000-000000000002'
const KEY = 'plugins--track_inline-a0b48c8b9db0'
const HOUR_MS = 60 * 60 * 1000
const DRIVE_MS = 10000

type Options = { enabled?: boolean; pending?: unknown; collect?: (request: Record<string, unknown>) => ProcessRunResult | 'throw' }
const reply = (response: Record<string, unknown>, exitCode = 0): ProcessRunResult =>
  ({ exitCode, stdout: `${JSON.stringify(response)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const emptyCollect = (request: Record<string, unknown>) => reply({ ok: true, protocol: 3, op: 'collect', dry_run: request.dry_run, trashed: [], purged_trash: [], purged_objects: [], kept: [], more: false })

const fixture = (on: On, options: Options = {}) => {
  const clock = mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', structuredClone(EMPTY))
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'pane', { isOpen: false, hidden: false, closedByPerson: false, autoOpenDone: true })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  const durability = atomStore(on, 'durability', { isUnsaved: false, reason: '' } as { isUnsaved: boolean; reason: string })
  atomStore(on, 'historyPending' as never, (options.pending ?? null) as never)
  const store = pluginStore(on, {})
  blobPool(on, { configDir: CONFIG })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('session.id', () => ({ value: SESSION }))
  on('env.get', { name: /^TRACK_HISTORY_V3$/ }, () => ({ value: options.enabled === false ? undefined : '1' }))
  const lines = logs(on)
  const model = { seq: 0, text: '', generation: '', checkpoint: undefined as unknown }
  const calls: Array<{ op: string; request: Record<string, unknown>; openGrants: string[] }> = []
  on('process.run', { argv: /\/hooks\/history\.py$/ }, async (_, event) => {
    const op = event.argv[2]!
    const request = JSON.parse(event.init!.stdin!) as Record<string, unknown>
    const open = new Set<string>()
    for (const entry of store.locks.timeline) {
      if (entry.startsWith('grant:')) open.add(entry.slice(6))
      if (entry.startsWith('close:')) open.delete(entry.slice(6))
    }
    store.locks.timeline.push(`run:history:${op}`)
    calls.push({ op, request, openGrants: [...open] })
    if (op === 'bind') return { value: reply({ ok: true, protocol: 3, op, store: KEY }) }
    if (op === 'read') return { value: reply(model.seq === 0 ? { ok: true, protocol: 3, op, state: 'absent' }
      : { ok: true, protocol: 3, op, state: 'valid', root: { seq: model.seq, generation: model.generation, checkpoint: model.checkpoint, savedAt: 1 }, root_sha256: 'a'.repeat(64), ledger_text: model.text }) }
    if (op === 'save') {
      model.seq += 1
      model.text = String(request.ledger_text)
      model.generation = String(request.generation)
      model.checkpoint = request.checkpoint
      return { value: reply({ ok: true, protocol: 3, op, request_id: request.request_id, seq: model.seq, root_sha256: 'a'.repeat(64) }) }
    }
    if (op === 'collect') {
      const answer = options.collect?.(request) ?? emptyCollect(request)
      if (answer === 'throw') throw new Error('fixture collect receipt lost')
      return { value: answer }
    }
    return { value: reply({ ok: false, protocol: 3, op, phase: 'precommit', reason: 'fixture op unsupported' }, 1) }
  })
  return { clock, ledger, durability, store, lines, calls }
}
type Fixture = ReturnType<typeof fixture>

const drive = async <T,>(f: Fixture, call: Promise<T>): Promise<T> => {
  let finished = false
  void call.then(() => { finished = true }, () => { finished = true })
  await f.clock.settle()
  if (!finished) await f.clock.advance(DRIVE_MS)
  return call
}
const trackSteps = (f: Fixture, $: Engine, steps: string[]) => drive(f, $.tool.call({ tool: 'mcp__track__track_steps', steps } as never))
const collects = (f: Fixture) => f.calls.filter(call => call.op === 'collect')

test('TRACK-39 V3 N1 a flagged save is followed by one collect with no grant open', async ($, on) => {
  const f = fixture(on)
  await trackSteps(f, $, ['A'])
  expect(f.calls.filter(call => call.op === 'save').length, 'N1: the save committed').toBe(1)
  expect(collects(f).length, 'N1: one collect follows the save').toBe(1)
  const [collect] = collects(f)
  expect(Object.keys(collect!.request).sort(), 'N1: exact collect request keys').toEqual(['dry_run', 'limit', 'op', 'protected', 'store', 'v'])
  expect(collect!.request, 'N1: collect applies with its own session protected').toMatchObject({ v: 3, op: 'collect', store: KEY, protected: [SESSION], dry_run: false })
  expect(collect!.openGrants, 'N1: no write grant is open during collect').toEqual([])
  const saveIndex = f.store.locks.timeline.indexOf('run:history:save')
  expect(f.store.locks.timeline.indexOf('run:history:collect') > saveIndex, 'N1: collect runs after the save').toBe(true)
})

test('TRACK-39 V3 N2 an unset flag makes no history call at all', async ($, on) => {
  const f = fixture(on, { enabled: false })
  await trackSteps(f, $, ['A'])
  expect(f.calls, 'N2: zero history calls, collect included').toEqual([])
})

test('TRACK-39 V3 N3 collect runs at most hourly and protects the pending session', async ($, on) => {
  const f = fixture(on, { pending: { session_id: OTHER, request_id: '39393939-2222-4000-8000-000000000003', expect: { absent: true } } })
  await trackSteps(f, $, ['A'])
  expect(collects(f).length, 'N3: the first save collects').toBe(1)
  expect(collects(f)[0]!.request.protected, 'N3: own and pending sessions are protected').toEqual([SESSION, OTHER])
  await trackSteps(f, $, ['B'])
  expect(collects(f).length, 'N3: a save within the hour does not collect again').toBe(1)
  await f.clock.advance(HOUR_MS)
  await trackSteps(f, $, ['C'])
  expect(collects(f).length, 'N3: a save an hour later collects again').toBe(2)
})

for (const fault of ['refusal', 'throw'] as const) {
  test(`TRACK-39 V3 N4 a collect ${fault} is logged and changes nothing`, async ($, on) => {
    const f = fixture(on, { collect: () => fault === 'throw' ? 'throw' : reply({ ok: false, protocol: 3, op: 'collect', phase: 'precommit', reason: 'v3 namespace has unknown entry: junk.txt' }, 1) })
    await trackSteps(f, $, ['A'])
    expect(collects(f).length, 'N4: collect was attempted').toBe(1)
    expect(f.durability.value, 'N4: the committed save stays acknowledged').toMatchObject({ isUnsaved: false, reason: '' })
    expect(f.ledger.value.steps.map(step => step.subject), 'N4: rows unchanged').toEqual(['A'])
    const after = f.store.locks.timeline.slice(f.store.locks.timeline.indexOf('run:history:collect'))
    expect(after.filter(entry => entry.startsWith('set:') || entry.startsWith('delete:')), 'N4: no engine-store change after collect').toEqual([])
    expect(f.lines.some(line => line.includes('collect')), 'N4: the collect failure is logged').toBe(true)
    expect(f.lines.filter(line => /unsaved/i.test(line)), 'N4: a collect failure never reads as unsaved').toEqual([])
  })
}
