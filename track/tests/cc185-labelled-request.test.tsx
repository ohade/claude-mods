// FIXTURE: CC-185, 2026-10-11. Haiku labelled requests such as "ask codex to ..." as questions.
// Steps never cover a labelled question (CC-179), yet Stop told the model to call track_steps, so
// the check kept firing on work already tracked as steps. Stub replies only.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine } from './kit'

const REQUEST = 'ask codex to think of the best way to fix it, see if you agree and present it to me'
const WORDED = 'how was 154 fixed?'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const wordedBlock = (excerpt: string) =>
  `track: a prompt looks like a question ("${excerpt}") but no Track row was written for it. Call mcp__track__track_question with source_text = its first line, answer it, then mcp__track__mark_answered with the completed answer_text; for a request instead, call mcp__track__track_steps with the same source_text. Then finish.`
const labelledBlock = (excerpt: string) =>
  `track: the classifier labelled a prompt a question ("${excerpt}") and no question row covers it; steps never cover a labelled question. Call mcp__track__track_question with source_text = its first line, answer it, then mcp__track__mark_answered with the completed answer_text. If it is a request already tracked as steps, mark that question deferred with a note naming the step. Then finish.`

const prepare = (on: Parameters<typeof atomStore>[0], isOn: boolean) => {
  const clock = mock.clock(on)
  pluginStore(on, { classifier: { isOn } })
  on('session.id', () => ({ value: SESSION }))
  const ledger = atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 1 })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  on('command.list', () => ({ value: [{ name: 'compact', description: 'compact', source: 'builtin' as const }] }))
  on('model.complete', async () => ({ value: { isAnswered: true, text: 'question', usage: USAGE } }) as never)
  return { clock, ledger }
}

const ask = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never) as Promise<{ deny?: string; result?: unknown }>
const stop = ($: Engine) => $.classic.Stop({ stop_hook_active: false } as never) as Promise<{ block?: string }>

test('a request Haiku labelled a question is not told to use track_steps, which cannot cover it', async ($, on) => {
  const { clock } = prepare(on, true)
  await ask($, REQUEST)
  await clock.advance(1)
  await call($, { tool: 'mcp__track__track_steps', steps: ['Codex proposes the fix'], source_text: REQUEST, tool_use_id: 'toolu_t' })
  const block = (await stop($)).block
  expect(block).toBe(labelledBlock(REQUEST.slice(0, 80)))
  expect(block).not.toContain('mcp__track__track_steps')
})

test('following the labelled message clears Stop: a deferred question row names the step', async ($, on) => {
  const { clock, ledger } = prepare(on, true)
  await ask($, REQUEST)
  await clock.advance(1)
  await call($, { tool: 'mcp__track__track_steps', steps: ['Codex proposes the fix'], source_text: REQUEST, tool_use_id: 'toolu_t' })
  await call($, { tool: 'mcp__track__track_question', summary: 'Codex proposes the fix', source_text: REQUEST, tool_use_id: 'toolu_q' })
  const id = (ledger.value as { questions: Array<{ id: number }> }).questions.at(-1)?.id
  await call($, { tool: 'mcp__track__mark_answered', id, status: 'deferred', note: 'Tracked as step plan:1', tool_use_id: 'toolu_d' })
  expect((await stop($)).block).toBeUndefined()
})

test('a question found only by wording keeps the track_steps advice, and steps still cover it', async ($, on) => {
  prepare(on, false)
  await ask($, WORDED)
  expect((await stop($)).block).toBe(wordedBlock(WORDED))
  await call($, { tool: 'mcp__track__track_steps', steps: ['Look at 154'], source_text: WORDED, tool_use_id: 'toolu_t' })
  expect((await stop($)).block).toBeUndefined()
})
