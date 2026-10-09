// FIXTURE: the question gate survives either order of prompt.submit and turn.start.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore } from './kit'

const blockFor = (excerpt: string) =>
  `track: this turn's prompt looks like a question ("${excerpt}") but no Track row was written. Call mcp__track__track_question (source_text = its first line), answer it, then mcp__track__mark_answered with the completed answer_text; for a request instead, use track_steps/mark_step. Then finish.`

const prepare = (on: Parameters<typeof atomStore>[0]) => {
  mock.clock(on)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 1 })
  const turn = atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  on('command.list', () => ({ value: [{ name: 'compact', description: 'compact', source: 'builtin' as const }] }))
  return { ledger, turn }
}

const ask = ($: { prompt: { submit: (e: never) => Promise<unknown> } }, text: string, origin?: { kind: string }) =>
  $.prompt.submit({ text, ...(origin !== undefined && { origin }) } as never)

const start = ($: { turn: { start: (e: never) => Promise<unknown> } }, turnId: string) =>
  $.turn.start({ text: 'next', turnId } as never)

const stop = ($: { classic: { Stop: (e: never) => Promise<{ block?: string }> } }) =>
  $.classic.Stop({ stop_hook_active: false } as never)

const trackAnswered = async (
  $: { tool: { call: (e: never) => Promise<unknown> } },
  ledger: { value: unknown },
) => {
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'ok, u on it?', tool_use_id: 'toolu_q' } as never)
  const id = (ledger.value as { questions: Array<{ id: number }> }).questions.at(-1)?.id
  await $.tool.call({ tool: 'mcp__track__mark_answered', id, status: 'answered', answer_text: 'On it.', tool_use_id: 'toolu_a' } as never)
}

test('prompt.submit then turn.start then Stop blocks once', async ($, on) => {
  const { turn } = prepare(on)
  await ask($, 'ok, u on it?', { kind: 'composer' })
  await start($, 'turn-2')
  const first = await stop($)
  const second = await stop($)
  expect(first.block).toBe(blockFor('ok, u on it?'))
  expect(turn.value.gatedTurnId).toBe('turn-2')
  expect(second.block).toBeUndefined()
})

test('turn.start then prompt.submit then Stop blocks once', async ($, on) => {
  const { turn } = prepare(on)
  await start($, 'turn-2')
  await ask($, 'ok, u on it?', { kind: 'composer' })
  const first = await stop($)
  const second = await stop($)
  expect(first.block).toBe(blockFor('ok, u on it?'))
  expect(turn.value.gatedTurnId).toBe('turn-2')
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
  expect((await stop($)).block).toBe(blockFor('ok, u on it?'))
  await start($, 'turn-2')
  expect((await stop($)).block).toBeUndefined()
})

test('a later doorbell prompt does not inherit the gated excerpt', async ($, on) => {
  prepare(on)
  await ask($, 'ok, u on it?', { kind: 'composer' })
  expect((await stop($)).block).toBe(blockFor('ok, u on it?'))
  await start($, 'turn-2')
  await ask($, ': AMQ doorbell run amq drain?', { kind: 'composer' })
  expect((await stop($)).block).toBeUndefined()
})
