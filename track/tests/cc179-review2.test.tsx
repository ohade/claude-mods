// FIXTURE: CC-179 round 3, Codex's re-review of 07f0229 (2026-10-10, AMQ thread cc179/review).
// A source-free unrelated question covered a lone prompt, reuse of an open row covered a second
// prompt with the same first line, a row linked to an old request covered a new prompt by its
// text, negative labels filled the cap so a new question went unrecorded, and an input covered by
// steps left at turn.start before its label came.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine, On } from './kit'

const TAIL = 'answer it, then mcp__track__mark_answered with the completed answer_text; for a request instead, call mcp__track__track_steps with the same source_text. Then finish.'
const blockFor = (excerpt: string) =>
  `track: a prompt looks like a question ("${excerpt}") but no Track row was written for it. Call mcp__track__track_question with source_text = its first line, ${TAIL}`
// CC-185: steps never cover a labelled question, so its message offers no track_steps repair.
const labelledFor = (excerpt: string) =>
  `track: the classifier labelled a prompt a question ("${excerpt}") and no question row covers it; steps never cover a labelled question. Call mcp__track__track_question with source_text = its first line, answer it, then mcp__track__mark_answered with the completed answer_text. If it is a request already tracked as steps, mark that question deferred with a note naming the step. Then finish.`

const ASKED = 'how was 154 fixed?'
const HEBREW = 'מה קרה עם הכרטיס של 154'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const answers = (label: string) => ({ isAnswered: true, text: label, usage: USAGE })

type Input = { id: number; excerpt: string }

const prepare = (on: On, options: { classifier?: boolean; seed?: Record<string, unknown> } = {}) => {
  const clock = mock.clock(on)
  pluginStore(on, options.classifier === true ? { classifier: { isOn: true } } : {})
  on('session.id', () => ({ value: SESSION }))
  const ledger = atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 1, ...options.seed })
  const pending = atomStore(on, 'pending', { inputs: [] as Input[], nextId: 1 })
  atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  on('command.list', () => ({ value: [{ name: 'compact', description: 'compact', source: 'builtin' as const }] }))
  return { clock, ledger, pending }
}

const ask = ($: Engine, text: string, turnId?: string) =>
  $.prompt.submit({ text, origin: { kind: 'composer' }, ...(turnId !== undefined && { turnId }) } as never)
const stop = ($: Engine) => $.classic.Stop({ stop_hook_active: false } as never) as Promise<{ block?: string }>
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never) as Promise<{ deny?: string; result?: unknown }>
const answerLast = async ($: Engine, ledger: { value: unknown }) => {
  const id = (ledger.value as { questions: Array<{ id: number }> }).questions.at(-1)?.id
  await call($, { tool: 'mcp__track__mark_answered', id, status: 'answered', answer_text: 'Answered.', tool_use_id: `toolu_a${id}` })
}

test('an unrelated question with no source does not cover the only waiting prompt', async ($, on) => {
  const { ledger } = prepare(on)
  await ask($, ASKED)
  await call($, { tool: 'mcp__track__track_question', summary: 'What about release 176?', tool_use_id: 'toolu_q' })
  await answerLast($, ledger)
  expect((await stop($)).block).toBe(blockFor(ASKED))
})

test('reusing one open row does not cover a second prompt with the same first line', async ($, on) => {
  const { ledger } = prepare(on)
  const first = 'what happened?\nwith CC-154'
  const second = 'what happened?\nwith CC-176'
  await ask($, first)
  await ask($, second, 'turn-1')
  await call($, { tool: 'mcp__track__track_question', summary: 'What happened with 154', source_text: 'what happened?', tool_use_id: 'toolu_q1' })
  await call($, { tool: 'mcp__track__track_question', summary: 'What happened with 154', source_text: 'what happened?', tool_use_id: 'toolu_q2' })
  await answerLast($, ledger)
  expect((await stop($)).block).toBe(blockFor(second))
})

test('a row linked to an old request does not cover a new prompt by its text', async ($, on) => {
  const { ledger } = prepare(on, { seed: { prompts: [{ rowKey: 'aaaa0000-bbbb-cccc-dddd', requestId: 'aaaa0000-bbbb-cccc-dddd-000000000000', head: 'old question?', turnId: 'turn-0', at: 1 }] } })
  await ask($, ASKED)
  await call($, { tool: 'mcp__track__track_question', summary: 'Old question', source_request_id: 'aaaa0000-bbbb-cccc-dddd-000000000000', source_text: ASKED, tool_use_id: 'toolu_q' })
  await answerLast($, ledger)
  expect((await stop($)).block).toBe(blockFor(ASKED))
})

test('50 prompts Haiku called not_question do not stop a new question from being recorded', async ($, on) => {
  const { clock, pending } = prepare(on, { classifier: true })
  on('model.complete', (_, e) => ({ value: answers(e.prompt === ASKED ? 'question' : 'not_question') }) as never)
  for (let n = 1; n <= 50; n++) await ask($, `status update number ${n}`, 'turn-1')
  await clock.advance(1)
  await ask($, ASKED, 'turn-1')
  await clock.advance(1)
  expect(pending.value.inputs.some(i => i.excerpt === ASKED)).toBe(true)
  expect((await stop($)).block).toBe(labelledFor(ASKED))
})

test('an input covered by steps waits for its label across turn.start', async ($, on) => {
  const { clock } = prepare(on, { classifier: true })
  let release = (_: unknown) => {}
  on('model.complete', () => new Promise(resolve => { release = resolve }) as never)
  await ask($, HEBREW, 'turn-1')
  await clock.advance(1)
  await call($, { tool: 'mcp__track__track_steps', steps: ['Look at 154'], source_text: HEBREW, tool_use_id: 'toolu_t' })
  expect((await stop($)).block).toBeUndefined()
  await $.turn.start({ text: 'next', turnId: 'turn-2' } as never)
  release({ value: answers('question') })
  await clock.advance(1)
  expect((await stop($)).block).toBe(labelledFor(HEBREW))
})
