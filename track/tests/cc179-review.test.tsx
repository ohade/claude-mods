// FIXTURE: CC-179 round 2, Codex's review of 12e11c8 (2026-10-10, AMQ thread cc179/review).
// Unrelated rows covered the oldest input, text prefixes stood in for identity, an unresolved
// input left at the next turn or at the cap, a late label could not undo step coverage, Stop never
// waited for a label already in flight, and the Stop message offered mark_step, which covers nothing.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore } from './kit'
import type { Engine, On } from './kit'

const TAIL = 'answer it, then mcp__track__mark_answered with the completed answer_text; for a request instead, call mcp__track__track_steps with the same source_text. Then finish.'
const blockFor = (excerpt: string) =>
  `track: a prompt looks like a question ("${excerpt}") but no Track row was written for it. Call mcp__track__track_question with source_text = its first line, ${TAIL}`
const blockForAll = (excerpts: string[]) =>
  `track: these prompts look like questions (${excerpts.map(x => `"${x}"`).join('; ')}) but no Track row was written for them. Call mcp__track__track_question for each with source_text = its first line, ${TAIL}`

const ASKED = 'how was 154 fixed?'
const OTHER = 'and what about cc-172?'
const HEBREW = 'מה קרה עם הכרטיס של 154'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const answers = (label: string) => ({ isAnswered: true, text: label, usage: USAGE })

type Input = { id: number; excerpt: string; covered?: true }

const prepare = (on: On, options: { classifier?: boolean; seed?: Record<string, unknown> } = {}) => {
  const clock = mock.clock(on)
  mock.store(on, options.classifier === true ? { classifier: { isOn: true } } : {})
  const ledger = atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 1, ...options.seed })
  const pending = atomStore(on, 'pending', { inputs: [] as Input[], nextId: 1 })
  atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  const context: string[][] = []
  on('prompt.submit', (_, e) => { context.push([...(e.context ?? [])]); return { text: e.text } })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('classic.Stop', () => ({}))
  on('command.list', () => ({ value: [{ name: 'compact', description: 'compact', source: 'builtin' as const }] }))
  return { clock, ledger, pending, context }
}

const ask = ($: Engine, text: string, turnId?: string) =>
  $.prompt.submit({ text, origin: { kind: 'composer' }, ...(turnId !== undefined && { turnId }) } as never)
const stop = ($: Engine) => $.classic.Stop({ stop_hook_active: false } as never) as Promise<{ block?: string }>
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never) as Promise<{ deny?: string; result?: unknown }>
const answerLast = async ($: Engine, ledger: { value: unknown }) => {
  const id = (ledger.value as { questions: Array<{ id: number }> }).questions.at(-1)?.id
  await call($, { tool: 'mcp__track__mark_answered', id, status: 'answered', answer_text: 'Answered.', tool_use_id: `toolu_a${id}` })
}

test('new steps for unrelated work do not cover a question', async ($, on) => {
  prepare(on)
  await ask($, ASKED)
  await call($, { tool: 'mcp__track__track_steps', steps: ['Send the file'], tool_use_id: 'toolu_t' })
  expect((await stop($)).block).toBe(blockFor(ASKED))
})

test('a question tracked with no source covers nothing while two prompts wait', async ($, on) => {
  const { ledger } = prepare(on)
  await ask($, ASKED)
  await ask($, OTHER, 'turn-1')
  await call($, { tool: 'mcp__track__track_question', summary: 'Unrelated work', tool_use_id: 'toolu_q' })
  await answerLast($, ledger)
  expect((await stop($)).block).toBe(blockForAll([ASKED, OTHER]))
})

test('two prompts sharing their first 80 characters stay two inputs', async ($, on) => {
  const { pending } = prepare(on)
  const shared = `please tell me ${'about the long running track gate work '.repeat(3)}`
  await ask($, `${shared} part one?`)
  await ask($, `${shared} part two?`, 'turn-1')
  expect(pending.value.inputs).toHaveLength(2)
})

test('an earlier prompt with the same first line does not cover the new one by request id', async ($, on) => {
  const { ledger } = prepare(on, { seed: { prompts: [{ rowKey: 'aaaa0000-bbbb-cccc-dddd', requestId: 'aaaa0000-bbbb-cccc-dddd-000000000000', head: ASKED, turnId: 'turn-0', at: 1 }] } })
  await ask($, ASKED)
  await call($, { tool: 'mcp__track__track_question', summary: 'Old 154 question', source_request_id: 'aaaa0000-bbbb-cccc-dddd-000000000000', tool_use_id: 'toolu_q' })
  await answerLast($, ledger)
  expect((await stop($)).block).toBe(blockFor(ASKED))
})

test('an unresolved prompt stays pending after its hold and is named on the next prompt', async ($, on) => {
  const { pending, context } = prepare(on)
  await ask($, ASKED)
  expect((await stop($)).block).toBeDefined()
  expect((await stop($)).block).toBeUndefined()
  await $.turn.start({ text: 'next', turnId: 'turn-2' } as never)
  await ask($, 'send it now')
  expect(pending.value.inputs.map(i => i.excerpt)).toEqual([ASKED])
  expect(context.at(-1)?.join('\n')).toContain(`track: still unregistered: "${ASKED}"`)
})

test('the cap never evicts an unresolved prompt', async ($, on) => {
  const { pending } = prepare(on)
  for (let n = 1; n <= 51; n++) await ask($, `question number ${n}?`, 'turn-1')
  expect(pending.value.inputs.some(i => i.excerpt === 'question number 1?')).toBe(true)
})

test('a late question label undoes coverage by new steps', async ($, on) => {
  const { clock } = prepare(on, { classifier: true })
  let release = (_: unknown) => {}
  on('model.complete', () => new Promise(resolve => { release = resolve }) as never)
  await ask($, HEBREW)
  await clock.advance(1)
  await call($, { tool: 'mcp__track__track_steps', steps: ['Look at 154'], source_text: HEBREW, tool_use_id: 'toolu_t' })
  release({ value: answers('question') })
  await clock.advance(1)
  expect((await stop($)).block).toBe(blockFor(HEBREW))
})

test('Stop waits briefly for a label already in flight', async ($, on) => {
  const { clock } = prepare(on, { classifier: true })
  // A real 50 ms delay: the mocked clock never moves on its own. The mod's types declare no timer.
  const later = (globalThis as unknown as { setTimeout: (run: () => void, ms: number) => void }).setTimeout
  on('model.complete', () => new Promise(resolve => { later(() => resolve({ value: answers('question') }), 50) }) as never)
  await ask($, HEBREW)
  await clock.advance(1)
  expect((await stop($)).block).toBe(blockFor(HEBREW))
})

test('the Stop message offers only repairs that cover, and following it covers the prompt', async ($, on) => {
  prepare(on)
  const request = 'can you fix the image-thumbs test?'
  await ask($, request)
  const held = (await stop($)).block ?? ''
  expect(held).not.toContain('mark_step')
  await ask($, 'go', 'turn-1')
  await call($, { tool: 'mcp__track__track_steps', steps: ['Fix the image-thumbs test'], source_text: request, tool_use_id: 'toolu_t' })
  await $.turn.start({ text: 'next', turnId: 'turn-2' } as never)
  await ask($, 'thanks')
  expect((await stop($)).block).toBeUndefined()
})
