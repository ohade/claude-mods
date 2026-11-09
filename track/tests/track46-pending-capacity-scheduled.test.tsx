// FIXTURE: TRACK-46 C2 review (Codex, 2026-11-09). A prompt's classifier is
// scheduled on a zero-delay timer, so for a while its label is coming although
// no model request runs yet. At capacity that row must keep its slot, covered by
// steps or not, so its late question label can still take effect.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Pending } from '../types'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const LATE = 'Fix the build.'
const NEXT = 'Why does the retry fail?'

const prepare = (on: On) => {
  const clock = mock.clock(on)
  mock.env(on, { CLAUDE_CONFIG_DIR: '/fixture/config' })
  pluginStore(on, { classifier: { isOn: true } })
  blobPool(on)
  on('session.id', () => ({ value: SESSION }))
  atomStore<Ledger>(on, 'ledger', { ...EMPTY, session_id: SESSION })
  const pending = atomStore<Pending>(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'turn', { currentId: 't50', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', async () => ({ value: { isAnswered: true, text: 'question', usage: USAGE } }) as never)
  return { clock, pending }
}
const submit = ($: Engine, text: string, turnId: string) => $.prompt.submit({ text, turnId, origin: { kind: 'composer' } } as never)

// Forty-nine questions, each labelled a question and still waiting for its row.
const waiting = async ($: Engine, clock: { settle: () => Promise<void> }) => {
  for (let n = 1; n <= 49; n++) {
    await submit($, `Why does part ${n} fail?`, `t${n}`)
    await clock.settle()
  }
}

for (const covered of [true, false]) {
  test(`C2 a row whose classifier is only scheduled keeps its slot (${covered ? 'steps-covered' : 'uncovered'})`, async ($, on) => {
    const f = prepare(on)
    await waiting($, f.clock)
    // Input 50: its classifier timer is scheduled, not yet run.
    await submit($, LATE, 't50')
    if (covered) await $.tool.call({ tool: 'mcp__track__track_steps', tool_use_id: 'steps-50', steps: ['Fix the build'], source_text: LATE } as never)
    const row = f.pending.value.inputs.find(i => i.head === LATE)
    expect(row?.label, 'the label is still coming').toBeUndefined()
    if (covered) expect(row?.covered).toBe('steps')
    await submit($, NEXT, 't51')
    expect(f.pending.value.inputs.some(i => i.id === row?.id), 'the scheduled row keeps its slot').toBe(true)
    await f.clock.settle()
    const after = f.pending.value.inputs.find(i => i.id === row?.id)
    expect(after?.label, 'the late label lands').toBe('question')
    expect(after?.covered, 'a question label removes steps coverage').toBeUndefined()
  })
}
