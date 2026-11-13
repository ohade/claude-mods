// FIXTURE: the question gate survives either order of prompt.submit and turn.start.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, SESSION } from './kit'
import type { Engine, On } from './kit'

const blockFor = (excerpt: string) =>
  `track: a prompt looks like a question ("${excerpt}") but no Track row was written for it. Call mcp__track__track_question with source_text = its first line, Write the formatted answer once between standalone <!-- A{id}:start --> and <!-- A{id}:end --> lines, using its stable numeric id; Track captures it automatically. Do not also send answer_text. For a tool/file-only answer, call mcp__track__mark_answered with the completed answer_text; for a request instead, reuse a matching open step with mcp__track__mark_step, keeping its current status and the same source_text. For new work, call mcp__track__track_steps with the same source_text; use after when steps already exist so their rows and statuses are kept. Then finish.`

const prepare = (on: Parameters<typeof atomStore>[0]) => {
  mock.clock(on)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 1 })
  const turn = atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  watchGate(on)
  on('command.list', () => ({ value: [{ name: 'compact', description: 'compact', source: 'builtin' as const }] }))
  return { ledger, turn }
}

const ask = ($: { prompt: { submit: (e: never) => Promise<unknown> } }, text: string, origin?: { kind: string }) =>
  $.prompt.submit({ text, ...(origin !== undefined && { origin }) } as never)

const start = ($: { turn: { start: (e: never) => Promise<unknown> } }, turnId: string) =>
  $.turn.start({ text: 'next', turnId } as never)

const stop = ($: { classic: { Stop: (e: never) => Promise<{ block?: string }> } }) =>
  $.classic.Stop({ stop_hook_active: false } as never)
// TRACK-46 unit 3 step C: stop-gate.py, the command hook, is the only Stop decider. A case that
// pinned the module's own block now pins the input rows the module publishes for the hook, and
// that the module itself returns no block; tests/helpers/test_stop_inputs.py covers the hook's block.
const gates = new WeakMap<On, { text: string }>()
const watchGate = (on: On) => {
  const gate = { text: '{}' }
  gates.set(on, gate)
  // publishGate stamps the snapshot with the session id; this fixture had none.
  on('session.id', () => ({ value: SESSION }))
  on('env.set', { name: /^TRACK_GATE_SNAPSHOT$/ }, (_, e) => { gate.text = String(e.value); return { value: {} } })
}
const gateReasons = async ($: Engine, on: On, fields: Record<string, unknown> = {}) => {
  expect((await $.classic.Stop({ stop_hook_active: false, ...fields } as never)).block).toBeUndefined()
  return (JSON.parse(gates.get(on)?.text ?? '{}') as { inputs?: Array<{ reason: string }> }).inputs?.map(row => row.reason)
}

const trackAnswered = async (
  $: { tool: { call: (e: never) => Promise<unknown> } },
  ledger: { value: unknown },
) => {
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'ok, u on it?', tool_use_id: 'toolu_q' } as never)
  const id = (ledger.value as { questions: Array<{ id: number }> }).questions.at(-1)?.id
  await $.tool.call({ tool: 'mcp__track__mark_answered', id, status: 'answered', answer_text: 'On it.', tool_use_id: 'toolu_a' } as never)
}

test('prompt.submit then turn.start publishes the uncovered prompt as a gate reason and Stop does not block', async ($, on) => {
  prepare(on)
  await ask($, 'ok, u on it?', { kind: 'composer' })
  await start($, 'turn-2')
  expect(await gateReasons($, on)).toEqual([blockFor('ok, u on it?')])
  const second = await stop($)
  expect(second.block).toBeUndefined()
})

test('turn.start then prompt.submit publishes the uncovered prompt as a gate reason and Stop does not block', async ($, on) => {
  prepare(on)
  await start($, 'turn-2')
  await ask($, 'ok, u on it?', { kind: 'composer' })
  expect(await gateReasons($, on)).toEqual([blockFor('ok, u on it?')])
  const second = await stop($)
  expect(second.block).toBeUndefined()
})

test('prompt.submit then turn.start with track_question and mark_answered does not block', async ($, on) => {
  const { ledger } = prepare(on)
  await ask($, 'ok, u on it?', { kind: 'composer' })
  await start($, 'turn-2')
  await trackAnswered($, ledger)
  expect((await stop($)).block).toBeUndefined()
})

test('turn.start then prompt.submit with track_question and mark_answered does not block', async ($, on) => {
  const { ledger } = prepare(on)
  await start($, 'turn-2')
  await ask($, 'ok, u on it?', { kind: 'composer' })
  await trackAnswered($, ledger)
  expect((await stop($)).block).toBeUndefined()
})

test('a later turn with no prompt does not inherit the gated excerpt', async ($, on) => {
  prepare(on)
  await ask($, 'ok, u on it?', { kind: 'composer' })
  expect(await gateReasons($, on)).toEqual([blockFor('ok, u on it?')])
  await start($, 'turn-2')
  expect((await stop($)).block).toBeUndefined()
})

test('a later doorbell prompt does not inherit the gated excerpt', async ($, on) => {
  prepare(on)
  await ask($, 'ok, u on it?', { kind: 'composer' })
  expect(await gateReasons($, on)).toEqual([blockFor('ok, u on it?')])
  await start($, 'turn-2')
  await ask($, ': AMQ doorbell run amq drain?', { kind: 'composer' })
  expect((await stop($)).block).toBeUndefined()
})
