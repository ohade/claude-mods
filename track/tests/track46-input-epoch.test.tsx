// FIXTURE: TRACK-46 S2. A new process restarts pending input numbering at 1,
// while the helper's input claims are permanent per session. The module must
// publish a runtime epoch so a fresh input never names an older runtime's claim.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Pending, Turn } from '../types'

const FIRST = 'Why is the task waiting?'
const SECOND = 'How does the retry work?'
const THIRD = 'Where is the retry configured?'
type Snapshot = { inputs?: Array<{ id: number }>; input_epoch?: unknown }

const prepare = (on: On) => {
  atomStore<Ledger>(on, 'ledger', { ...EMPTY, steps: [] })
  const pending = atomStore<Pending>(on, 'pending', { inputs: [], nextId: 1 })
  atomStore<Turn>(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on, { classifier: { isOn: false } })
  const env = new Map<string, string>([['CLAUDE_CONFIG_DIR', '/fixture/config'], ['CLAUDE_PLUGIN_ROOT', '/fixture/track']])
  const claimed: Snapshot[] = []
  on('session.id', () => ({ value: SESSION }))
  on('env.get', (_, e) => ({ value: env.get(e.name) }))
  on('env.set', (_, e) => { env.set(e.name, String(e.value)); return { value: {} } })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  on('process.run', { argv: /^\/.*\/hooks\/stop-gate\.py$/ }, (_, e) => {
    claimed.push(JSON.parse(e.init?.env?.TRACK_GATE_SNAPSHOT ?? '{}'))
    return { value: { exitCode: 0, stdout: JSON.stringify({ decision: 'block', reason: 'track: fixture receipt' }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { pending, claimed, snapshot: () => JSON.parse(env.get('TRACK_GATE_SNAPSHOT') ?? '{}') as Snapshot }
}

const ask = ($: Engine, text: string, turnId: string) => $.prompt.submit({ text, turnId, origin: { kind: 'composer' } } as never)
const start = ($: Engine, turnId: string) => $.turn.start({ text: 'Continue the requested work', turnId } as never)
const stop = ($: Engine) => $.classic.Stop({ session_id: SESSION, stop_hook_active: false, background_tasks: [] } as never)

test('S2 a restarted runtime publishes a new input epoch, stable within one runtime', async ($, on) => {
  const fixture = prepare(on)
  await ask($, FIRST, 'turn-1')
  await start($, 'turn-1')
  const first = fixture.snapshot().input_epoch
  expect(typeof first === 'string' && first.length > 0, 'the snapshot names its input epoch').toBe(true)
  expect((await stop($)).block, 'TRACK-46 unit 3 step C: stop-gate.py decides; the module returns no block').toBeUndefined()
  expect(fixture.claimed, 'the module starts no claim helper').toEqual([])
  expect(fixture.snapshot().input_epoch, 'the Stop republishes the same epoch for the command hook').toBe(first)

  // A new process starts the pending atom fresh: numbering restarts at 1.
  fixture.pending.value = { inputs: [], nextId: 1 }
  await ask($, SECOND, 'turn-2')
  await start($, 'turn-2')
  const second = fixture.snapshot()
  expect(second.inputs?.map(i => i.id)).toEqual([1])
  expect(typeof second.input_epoch === 'string' && second.input_epoch.length > 0).toBe(true)
  expect(second.input_epoch, 'input 1 of the new runtime must not reuse the old claim identity').not.toBe(first)

  await ask($, THIRD, 'turn-3')
  await start($, 'turn-3')
  expect(fixture.snapshot().input_epoch, 'one runtime keeps one epoch').toBe(second.input_epoch)
})
