// FIXTURE: TRACK-46 S2 review (Codex, 2026-11-09). A hot reload keeps the same
// pending queue. Inputs admitted before the queue had an epoch keep their
// legacy claim name; only inputs admitted after it use the new epoch.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Pending, Turn } from '../types'

const OLD = 'Why is the task waiting?'
const NEW = 'How does the retry work?'
type Row = { id: number; legacy?: unknown }
type Snapshot = { inputs?: Row[]; input_epoch?: unknown }

const prepare = (on: On, pending: Pending) => {
  atomStore<Ledger>(on, 'ledger', { ...EMPTY, steps: [] })
  atomStore<Pending>(on, 'pending', pending)
  atomStore<Turn>(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on, { classifier: { isOn: false } })
  const env = new Map<string, string>([['CLAUDE_CONFIG_DIR', '/fixture/config'], ['CLAUDE_PLUGIN_ROOT', '/fixture/track']])
  on('session.id', () => ({ value: SESSION }))
  on('env.get', (_, e) => ({ value: env.get(e.name) }))
  on('env.set', (_, e) => { env.set(e.name, String(e.value)); return { value: {} } })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  return { snapshot: () => JSON.parse(env.get('TRACK_GATE_SNAPSHOT') ?? '{}') as Snapshot }
}

const ask = ($: Engine, text: string, turnId: string) => $.prompt.submit({ text, turnId, origin: { kind: 'composer' } } as never)
const start = ($: Engine, turnId: string) => $.turn.start({ text: 'Continue the requested work', turnId } as never)

test('S2 a held legacy input keeps its claim name when a new input gives the queue an epoch', async ($, on) => {
  // The queue the old version left: input 1 already held under input:1.
  const fixture = prepare(on, { inputs: [{ id: 1, head: OLD, excerpt: OLD, textHash: 'legacy-1', turnId: 'turn-0', held: true }], nextId: 2 })
  await ask($, NEW, 'turn-1')
  await start($, 'turn-1')
  const snapshot = fixture.snapshot()
  expect(typeof snapshot.input_epoch === 'string' && snapshot.input_epoch.length > 0, 'the new input gives the queue an epoch').toBe(true)
  expect(snapshot.inputs?.map(row => [row.id, row.legacy === true]), 'only the old input keeps its legacy claim name').toEqual([[1, true], [2, false]])
})
