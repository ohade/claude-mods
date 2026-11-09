// FIXTURE: TRACK-46 S3 + C2. With the optional classifier on, a prompt that is
// not worded as a question and gets no clear label needs no question row, yet
// it stays pending. Fifty of them filled every slot, so a later real question
// was never recorded. Such settled rows must yield their slot; a question that
// still waits for a row, and a steps-covered prompt whose label is still
// coming, must keep theirs.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Pending } from '../types'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const QUESTION = 'Why does the retry fail?'

const prepare = (on: On, label: (text: string) => Promise<string>) => {
  const clock = mock.clock(on)
  mock.env(on, { CLAUDE_CONFIG_DIR: '/fixture/config' })
  pluginStore(on, { classifier: { isOn: true } })
  blobPool(on)
  on('session.id', () => ({ value: SESSION }))
  atomStore<Ledger>(on, 'ledger', { ...EMPTY, session_id: SESSION })
  const pending = atomStore<Pending>(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  const toasts: string[] = []
  on('ui.toast', (_, e) => { toasts.push(String((e as { text?: unknown }).text ?? e)); return { value: undefined } })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', async (_, e) => ({ value: { isAnswered: true, text: await label(String(e.prompt)), usage: USAGE } }) as never)
  return { clock, pending, toasts }
}
const submit = ($: Engine, text: string, turnId: string) => $.prompt.submit({ text, turnId, origin: { kind: 'composer' } } as never)
const settle = async (clock: { settle: () => Promise<void> }) => { await clock.settle(); await clock.settle() }

// Fifty prompts across turns, none worded as a question, each given a malformed label.
const fill = async ($: Engine, clock: { settle: () => Promise<void> }, count: number) => {
  for (let n = 1; n <= count; n++) {
    await submit($, `Continue the work, part ${n}.`, `t${n}`)
    await settle(clock)
  }
}

test('S3 settled no-question prompts at capacity yield a slot to a real question', async ($, on) => {
  const f = prepare(on, async text => text === QUESTION ? 'question' : 'maybe')
  await fill($, f.clock, 50)
  expect(f.pending.value.inputs.length, 'all fifty prompts are pending').toBe(50)
  expect(f.pending.value.inputs.every(i => i.label === 'unknown' && i.wording === false)).toBe(true)
  await submit($, QUESTION, 't51')
  await settle(f.clock)
  expect(f.pending.value.inputs.some(i => i.head === QUESTION), 'the real question is recorded').toBe(true)
  expect(f.toasts.some(text => text.includes('was not recorded')), 'no capacity refusal').toBe(false)
})

test('S3 control: fifty questions still waiting for rows keep their slots', async ($, on) => {
  const f = prepare(on, async () => 'question')
  for (let n = 1; n <= 50; n++) {
    await submit($, `Why does part ${n} fail?`, `t${n}`)
    await settle(f.clock)
  }
  await submit($, QUESTION, 't51')
  await settle(f.clock)
  expect(f.pending.value.inputs.some(i => i.head === QUESTION), 'a waiting question is never evicted').toBe(false)
  expect(f.pending.value.inputs.length).toBe(50)
})

test('C2 control: a steps-covered prompt whose label is still coming keeps its slot and can still be revoked', async ($, on) => {
  let release: ((label: string) => void) | undefined
  const late = 'Fix the build.'
  const f = prepare(on, text => text === late ? new Promise<string>(resolve => { release = resolve }) : Promise.resolve(text === QUESTION ? 'question' : 'maybe'))
  await fill($, f.clock, 49)
  await submit($, late, 't50')
  await settle(f.clock)
  const row = f.pending.value.inputs.find(i => i.head === late)!
  f.pending.value = { ...f.pending.value, inputs: f.pending.value.inputs.map(i => i.id === row.id ? { ...i, covered: 'steps' as const } : i) }
  await submit($, QUESTION, 't51')
  await settle(f.clock)
  expect(f.pending.value.inputs.some(i => i.head === QUESTION), 'the real question is recorded').toBe(true)
  expect(f.pending.value.inputs.some(i => i.id === row.id), 'the prompt with a label still coming keeps its slot').toBe(true)
  release?.('question')
  await settle(f.clock)
  const after = f.pending.value.inputs.find(i => i.id === row.id)
  expect(after?.label).toBe('question')
  expect(after?.covered, 'a late question label revokes steps coverage').toBeUndefined()
})
