// FIXTURE: CC-179 step 1. Only an accepted Track row covers a question-like prompt.
// Codex's review (2026-10-10) found that a rejected or unrelated Track call counted as tracked.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore } from './kit'
import type { Engine } from './kit'

const blockFor = (excerpt: string) =>
  `track: a prompt looks like a question ("${excerpt}") but no Track row was written for it. Call mcp__track__track_question with source_text = its first line, answer it, then mcp__track__mark_answered with the completed answer_text; for a request instead, call mcp__track__track_steps with the same source_text. Then finish.`

const ASKED = 'how was 154 fixed?'

const prepare = (on: Parameters<typeof atomStore>[0], seed: Record<string, unknown> = {}) => {
  mock.clock(on)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 1, ...seed })
  const turn = atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('classic.Stop', () => ({}))
  on('command.list', () => ({ value: [{ name: 'compact', description: 'compact', source: 'builtin' as const }] }))
  return { ledger, turn }
}

type Ran = { deny?: string; result?: unknown }

const ask = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never) as Promise<Ran>
const stop = ($: Engine) => $.classic.Stop({ stop_hook_active: false } as never) as Promise<{ block?: string }>

test('a whitespace track_question is denied, writes no row, and Stop still blocks', async ($, on) => {
  const { ledger } = prepare(on)
  await ask($, ASKED)
  const ran = await call($, { tool: 'mcp__track__track_question', summary: '   ', tool_use_id: 'toolu_q' })
  expect(ran.deny).toBe('track: summary is required.')
  expect((ledger.value as { questions: unknown[] }).questions).toHaveLength(0)
  expect((await stop($)).block).toBe(blockFor(ASKED))
})

test('an unrelated successful mark_step does not cover a question', async ($, on) => {
  prepare(on, { steps: [{ id: 'plan:1', source: 'plan', subject: 'Earlier work', status: 'in_progress' }] })
  await ask($, ASKED)
  const ran = await call($, { tool: 'mcp__track__mark_step', id: 'plan:1', status: 'completed', tool_use_id: 'toolu_s' })
  expect(String(ran.result)).toContain('marked completed')
  expect((await stop($)).block).toBe(blockFor(ASKED))
})

test('mark_answered for an unknown id does not cover a question', async ($, on) => {
  prepare(on)
  await ask($, ASKED)
  const ran = await call($, { tool: 'mcp__track__mark_answered', id: 99, status: 'answered', answer_text: 'x', tool_use_id: 'toolu_a' })
  expect(String(ran.result)).toContain('No question with id 99')
  expect((await stop($)).block).toBe(blockFor(ASKED))
})

test('track_steps with no titles does not cover a question', async ($, on) => {
  prepare(on)
  await ask($, ASKED)
  const ran = await call($, { tool: 'mcp__track__track_steps', steps: ['  '], tool_use_id: 'toolu_t' })
  expect(String(ran.result)).toContain('No steps given')
  expect((await stop($)).block).toBe(blockFor(ASKED))
})

test('a question tracked for another prompt does not cover this one', async ($, on) => {
  const { ledger } = prepare(on, { prompts: [{ rowKey: 'aaaa-bbbb-cccc-dddd', head: 'what about cc-172?', turnId: 'turn-0', at: 1 }] })
  await ask($, ASKED)
  await call($, { tool: 'mcp__track__track_question', summary: 'CC-172 status', source_text: 'what about cc-172?', tool_use_id: 'toolu_q' })
  const id = (ledger.value as { questions: Array<{ id: number }> }).questions.at(-1)?.id
  await call($, { tool: 'mcp__track__mark_answered', id, status: 'answered', answer_text: 'Done.', tool_use_id: 'toolu_a' })
  expect((await stop($)).block).toBe(blockFor(ASKED))
})

test('a subagent track_question is denied and does not cover a question', async ($, on) => {
  prepare(on)
  await ask($, ASKED)
  const ran = await call($, { tool: 'mcp__track__track_question', summary: ASKED, agentId: 'agent-1', tool_use_id: 'toolu_q' })
  expect(ran.deny).toContain('subagent')
  expect((await stop($)).block).toBe(blockFor(ASKED))
})

test('reusing an open question for the same words covers the prompt', async ($, on) => {
  prepare(on, { nextQuestionId: 2, questions: [{ id: 1, head: ASKED, at: 1, turnId: 'turn-0', status: 'open' }] })
  await ask($, ASKED)
  const ran = await call($, { tool: 'mcp__track__track_question', summary: ASKED, tool_use_id: 'toolu_q' })
  expect(String(ran.result)).toContain('Already tracked as Q1')
  expect((await stop($)).block).toBeUndefined()
})

test('a question tracked with this prompt as its source covers it', async ($, on) => {
  const { ledger } = prepare(on)
  await ask($, ASKED)
  await call($, { tool: 'mcp__track__track_question', summary: 'How CC-154 was fixed', source_text: ASKED, tool_use_id: 'toolu_q' })
  const id = (ledger.value as { questions: Array<{ id: number }> }).questions.at(-1)?.id
  await call($, { tool: 'mcp__track__mark_answered', id, status: 'answered', answer_text: 'By a Stop gate.', tool_use_id: 'toolu_a' })
  expect((await stop($)).block).toBeUndefined()
})

test('new steps naming the prompt cover a question-like request', async ($, on) => {
  prepare(on)
  await ask($, 'can you fix the image-thumbs test?')
  await call($, { tool: 'mcp__track__track_steps', steps: ['Fix the image-thumbs test'], source_text: 'can you fix the image-thumbs test?', tool_use_id: 'toolu_t' })
  expect((await stop($)).block).toBeUndefined()
})
