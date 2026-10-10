// FIXTURE: CC-179 step 2. Each question-like prompt of a turn stays pending until a Track row
// covers it. Codex's review (2026-10-10): one excerpt was kept, every later prompt (a
// notification too) overwrote it, and Track stepped aside after another Stop hook continued.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore } from './kit'
import type { Engine } from './kit'

const TAIL = 'answer it, then mcp__track__mark_answered with the completed answer_text; for a request instead, call mcp__track__track_steps with the same source_text. Then finish.'
const blockFor = (excerpt: string) =>
  `track: a prompt looks like a question ("${excerpt}") but no Track row was written for it. Call mcp__track__track_question with source_text = its first line, ${TAIL}`
const blockForAll = (excerpts: string[]) =>
  `track: these prompts look like questions (${excerpts.map(x => `"${x}"`).join('; ')}) but no Track row was written for them. Call mcp__track__track_question for each with source_text = its first line, ${TAIL}`

const FIRST = 'how was 154 fixed?'
const SECOND = 'and what about cc-172?'

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


const ask = ($: Engine, text: string, extra: Record<string, unknown> = {}) =>
  $.prompt.submit({ text, origin: { kind: 'composer' }, ...extra } as never)
// A prompt typed while turn-1 runs carries that turn's id.
const askMidTurn = ($: Engine, text: string) => ask($, text, { turnId: 'turn-1' })
const stop = ($: Engine, extra: Record<string, unknown> = {}) =>
  $.classic.Stop({ stop_hook_active: false, ...extra } as never) as Promise<{ block?: string }>

const trackAndAnswer = async ($: Engine, ledger: { value: unknown }, sourceText: string) => {
  await $.tool.call({ tool: 'mcp__track__track_question', summary: sourceText, source_text: sourceText, tool_use_id: `toolu_q_${sourceText.length}` } as never)
  const id = (ledger.value as { questions: Array<{ id: number }> }).questions.at(-1)?.id
  await $.tool.call({ tool: 'mcp__track__mark_answered', id, status: 'answered', answer_text: 'Answered.', tool_use_id: `toolu_a_${sourceText.length}` } as never)
}

test('two question prompts in one turn with one covered still block for the other', async ($, on) => {
  const { ledger } = prepare(on)
  await ask($, FIRST)
  await askMidTurn($, SECOND)
  await trackAndAnswer($, ledger, SECOND)
  expect((await stop($)).block).toBe(blockFor(FIRST))
})

test('two uncovered question prompts are named in one block, then Stop passes', async ($, on) => {
  prepare(on)
  await ask($, FIRST)
  await askMidTurn($, SECOND)
  expect((await stop($)).block).toBe(blockForAll([FIRST, SECOND]))
  expect((await stop($)).block).toBeUndefined()
})

test('a task notification neither erases nor adds a pending question', async ($, on) => {
  prepare(on)
  await ask($, FIRST)
  await ask($, '<task-notification><task-id>ag1</task-id></task-notification> why?', { origin: { kind: 'task-notification' }, turnId: 'turn-1' })
  expect((await stop($)).block).toBe(blockFor(FIRST))
})

test('an AMQ doorbell in the same turn does not erase a pending question', async ($, on) => {
  prepare(on)
  await ask($, FIRST)
  await askMidTurn($, ': AMQ doorbell run amq drain --include-body then act on it')
  expect((await stop($)).block).toBe(blockFor(FIRST))
})

test('Track still blocks once for an uncovered prompt after another Stop hook continued the turn', async ($, on) => {
  prepare(on)
  await ask($, FIRST)
  expect((await stop($, { stop_hook_active: true })).block).toBe(blockFor(FIRST))
  expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
})

test('the same words typed twice in one turn need one Track row', async ($, on) => {
  const { ledger } = prepare(on)
  await ask($, FIRST)
  await askMidTurn($, FIRST)
  await trackAndAnswer($, ledger, FIRST)
  expect((await stop($)).block).toBeUndefined()
})

test('both prompts covered in one turn do not block', async ($, on) => {
  const { ledger } = prepare(on)
  await ask($, FIRST)
  await askMidTurn($, SECOND)
  await trackAndAnswer($, ledger, FIRST)
  await trackAndAnswer($, ledger, SECOND)
  expect((await stop($)).block).toBeUndefined()
})

test('a prompt typed during turn-1 is not carried into turn-2', async ($, on) => {
  prepare(on)
  await askMidTurn($, FIRST)
  expect((await stop($)).block).toBe(blockFor(FIRST))
  await $.turn.start({ text: 'next', turnId: 'turn-2' } as never)
  await ask($, 'send it now')
  expect((await stop($)).block).toBeUndefined()
})
