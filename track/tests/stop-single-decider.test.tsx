// TRACK-46 Phase 2 unit 3 step C: stop-gate.py, the command hook, is the only Stop decider.
// The test's own classic.Stop hook plays that command hook below the module: here it never
// blocks, except in the pass-through case. The module may republish the gate snapshot and nudge,
// but it returns no block of its own and starts no process. tests/helpers/test_stop_gate.py and
// its siblings cover the hook's decisions on the facts this snapshot carries.
import { expect, test } from 'claude-code/testing'
import type { Ledger, Pending, Step, Turn } from '../types'
import type { Engine, On } from './kit'
import { EMPTY, SESSION, atomStore, logs } from './kit'

const RUN_BLOCK = 'fixture: a stop-gate.py run blocked'

type Snapshot = { turn_id?: string | null; open?: Array<{ id: number }>; inputs?: Array<{ id: number }>; candidates?: Array<{ kind: string }> }

const prepare = (on: On, state: { steps?: Step[]; questions?: Ledger['questions']; inputs?: Pending['inputs']; turn?: Partial<Turn> }, below: { block?: string } = {}) => {
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, session_id: SESSION, steps: state.steps ?? [], questions: state.questions ?? [] })
  const turn = atomStore<Turn>(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, ...state.turn })
  const pending = atomStore<Pending>(on, 'pending', { inputs: state.inputs ?? [], nextId: (state.inputs?.length ?? 0) + 1 })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [], owners: {} })
  atomStore(on, 'scroll', { questions: null, steps: null })
  logs(on)
  const env = new Map([['CLAUDE_PLUGIN_ROOT', '/fixture/track'], ['CLAUDE_CONFIG_DIR', '/fixture/config']])
  const runs: string[][] = []
  on('session.id', () => ({ value: SESSION }))
  on('env.get', (_, e) => ({ value: env.get(e.name) }))
  on('env.set', (_, e) => { env.set(e.name, String(e.value)); return { value: {} } })
  on('classic.Stop', () => below)
  // Every process the module starts is recorded. A stop-gate.py run answers with a block, so a
  // module that still decides through the helper would return it.
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    const block = /\/hooks\/stop-gate\.py$/.test(String(e.argv[1] ?? ''))
    return { value: { exitCode: block ? 0 : 1, stdout: block ? JSON.stringify({ decision: 'block', reason: RUN_BLOCK }) : '', stderr: '',
      isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const snapshot = () => JSON.parse(env.get('TRACK_GATE_SNAPSHOT') ?? '{}') as Snapshot
  return { ledger, turn, pending, runs, snapshot }
}

const stop = ($: Engine, fields: Record<string, unknown> = {}) =>
  $.classic.Stop({ session_id: SESSION, stop_hook_active: false, background_tasks: [], ...fields } as never) as Promise<{ block?: string }>

const question = (id: number): Ledger['questions'][number] => ({ id, head: `question ${id}`, status: 'open', turnId: 'turn-1' } as Ledger['questions'][number])
const input = (id: number, turnId: string | null): Pending['inputs'][number] =>
  ({ id, head: `Why does case ${id} fail?`, excerpt: `Why does case ${id} fail?`, textHash: `input-${id}`, turnId })

test('an open question from this turn: the module returns no block, starts no process, and leaves gatedTurnId', async ($, on) => {
  const fixture = prepare(on, { questions: [question(4)] })

  const r = await stop($)

  expect(r.block).toBeUndefined()
  expect(fixture.runs).toEqual([])
  expect(fixture.turn.value.gatedTurnId).toBeNull()
  expect(fixture.snapshot().open?.map(row => row.id)).toEqual([4])
})

test('an uncovered typed input: the module returns no block, starts no process, and writes no held mark', async ($, on) => {
  const fixture = prepare(on, { inputs: [input(1, 'turn-1')] })

  const r = await stop($)

  expect(r.block).toBeUndefined()
  expect(fixture.runs).toEqual([])
  expect(fixture.pending.value.inputs[0]?.held).toBeUndefined()
  expect(fixture.snapshot().inputs?.map(row => row.id)).toEqual([1])
})

test('a freshness candidate that used to start a --claim run: the module returns no block and starts no process', async ($, on) => {
  const steps: Step[] = [{ id: 'task:7', source: 'task', subject: 'Finish the change', status: 'waiting', activeTurnId: 'turn-1' }]
  const fixture = prepare(on, { steps, turn: { freshness: {
    turnId: 'turn-1', edits: [], bash: [], steps: ['task:7'], completed: [], waiting: ['task:7'],
    response: { turn_id: 'turn-1', request_id: 'fixture-main', arrow_ids: [] }, held: [], nudged: [],
  } } })

  const r = await stop($)

  expect(r.block).toBeUndefined()
  expect(fixture.runs).toEqual([])
  expect(fixture.snapshot().candidates?.map(row => row.kind)).toEqual(['missing_waiting_request'])
})

test('a block from the command hook below reaches the host unchanged', async ($, on) => {
  const fixture = prepare(on, { questions: [question(4)], inputs: [input(1, 'turn-1')] }, { block: 'the command hook blocked' })

  const r = await stop($)

  expect(r.block).toBe('the command hook blocked')
  expect(fixture.runs).toEqual([])
  expect(fixture.turn.writes).toHaveLength(0)
  expect(fixture.pending.writes).toHaveLength(0)
})

test('the bookkeeping stays: an input with no turn is bound to the turn and the gate snapshot is republished', async ($, on) => {
  const fixture = prepare(on, { inputs: [input(1, null)] })

  const r = await stop($)

  expect(r.block).toBeUndefined()
  expect(fixture.runs).toEqual([])
  expect(fixture.pending.value.inputs[0]?.turnId).toBe('turn-1')
  expect(fixture.snapshot()).toMatchObject({ turn_id: 'turn-1', inputs: [{ id: 1 }] })
})
