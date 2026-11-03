// FIXTURE: frozen original/candidate prompt delivery, admission and retry behavior.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Pending, PendingInput } from '../types'

const state = (extra: Partial<Ledger> = {}): Ledger => ({ ...EMPTY, session_id: SESSION, ...extra })
const input = (id: number): PendingInput => ({ id, head: `h${id}`, excerpt: `e${id}`, textHash: `hash${id}`, turnId: 't1' })
const notices = ['track: the user withdrew question:1 "Gone"; do not answer it.', 'track: the user cleared open steps plan:2 "Old"; it is no longer tracked.']
const prepare = (on: On, initial = state(), pending: Pending = { inputs: [], nextId: 1 }, classifier = false) => {
  const clock = mock.clock(on)
  mock.env(on, { CLAUDE_CONFIG_DIR: '/fixture/config' })
  pluginStore(on, { classifier: { isOn: classifier } })
  on('session.id', () => ({ value: SESSION }))
  on('command.list', () => ({ value: [{ name: 'compact', description: 'compact', source: 'builtin' as const }, { name: 'retro', description: 'retro', source: 'plugin' as const }] }))
  const ledger = atomStore(on, 'ledger', initial)
  const held = atomStore(on, 'pending', pending)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const delivered: Array<{ context: readonly string[]; withdrawn: unknown; cleared: unknown }> = []
  on('prompt.submit', (_, event) => {
    delivered.push({ context: [...(event.context ?? [])], withdrawn: ledger.value.withdrawn, cleared: ledger.value.clearedSteps })
    return { text: event.text }
  })
  return { clock, ledger, held, delivered }
}
const submit = ($: Engine, text: string) => $.prompt.submit({ text, turnId: 't1', origin: { kind: 'composer' }, context: ['prior'] } as never)
const noticeState = () => state({ withdrawn: [{ id: 1, head: 'Gone' }], clearedSteps: [{ id: 'plan:2', head: 'Old' }] })

test('U4 delivers both captured notices after ordered clears and consumes them once', async ($, on) => {
  const { ledger, delivered } = prepare(on, noticeState())
  await submit($, 'Continue.')
  expect(delivered[0]!.context[0]).toBe('prior')
  expect(delivered[0]!.context.slice(-2)).toEqual(notices)
  expect(delivered[0]!.withdrawn).toEqual([])
  expect(delivered[0]!.cleared).toEqual([])
  const withdrawnAt = ledger.writes.findIndex(row => row.withdrawn?.length === 0 && row.clearedSteps?.length === 1)
  const clearedAt = ledger.writes.findIndex(row => row.withdrawn?.length === 0 && row.clearedSteps?.length === 0)
  expect(withdrawnAt).toBeGreaterThanOrEqual(0)
  expect(clearedAt).toBeGreaterThan(withdrawnAt)
  await submit($, 'Continue.')
  expect(delivered[1]!.context.some(line => notices.includes(line))).toBe(false)
})

test('U4 builtin prompts preserve notices while a skill delivers the same captured text', async ($, on) => {
  const { ledger, delivered } = prepare(on, noticeState())
  await submit($, '/compact')
  expect(delivered[0]!.context).toEqual(['prior'])
  expect(ledger.value.withdrawn).toEqual([{ id: 1, head: 'Gone' }])
  expect(ledger.value.clearedSteps).toEqual([{ id: 'plan:2', head: 'Old' }])
  await submit($, '/retro')
  expect(delivered[1]!.context.slice(-2)).toEqual(notices)
  expect(delivered[1]!.withdrawn).toEqual([])
  expect(delivered[1]!.cleared).toEqual([])
})

test('U4 native admission evicts covered rows before negative labels and unresolved rows', async ($, on) => {
  const inputs = Array.from({ length: 50 }, (_, i) => input(i + 1))
  inputs[1] = { ...inputs[1]!, label: 'not_question' }
  inputs[2] = { ...inputs[2]!, covered: 'steps' }
  const { held } = prepare(on, state(), { inputs, nextId: 51 })
  await submit($, 'Why intake?')
  expect(held.value.inputs.map(row => row.id)).toEqual([1, 2, ...Array.from({ length: 47 }, (_, i) => i + 4), 51])
  expect(held.value.nextId).toBe(52)
  expect(held.value.inputs.at(-1)).toMatchObject({ id: 51, head: 'Why intake?', excerpt: 'Why intake?', turnId: 't1' })
  expect(Object.hasOwn(held.value.inputs.at(-1)!, 'wording')).toBe(false)
})

test('U4 a losing admission retries a competing duplicate without scheduling its classifier', async ($, on) => {
  let held: ReturnType<typeof atomStore<Pending>>
  let injected = false
  let winner: Pending | undefined
  on('state.set', { plugin: 'track', key: ['pending'] }, (_, event, next) => {
    const proposal = event.value as Pending
    if (!injected && proposal.inputs.some(row => row.id === 8)) {
      injected = true
      // Another admission of the same prompt wins this exact version first.
      winner = { inputs: [{ ...proposal.inputs.at(-1)! }], nextId: 9 }
      held.value = winner
      held.version++
    }
    return next(event)
  })
  const prepared = prepare(on, state(), { inputs: [], nextId: 8 }, true)
  held = prepared.held
  let modelCalls = 0
  on('model.complete', () => {
    modelCalls++
    return { value: { isAnswered: true, text: 'question', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  await submit($, 'Why retry intake?')
  await prepared.clock.advance(1)
  expect(injected).toBe(true)
  expect(held.value).toEqual(winner)
  expect(modelCalls).toBe(0)
})
