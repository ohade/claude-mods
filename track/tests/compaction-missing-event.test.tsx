// FIXTURE, 2026-10-22: model a compacted main window without session.compact.
// This checks Track's data-loss path, not whether the native dispatcher skips it.
import { expect, mock, test } from 'claude-code/testing'
import type { Ledger } from '../types'
import type { Engine, On } from './kit'
import { checksumOf } from '../hooks/checkpoint'
import { EMPTY, SESSION, atomStore, logs, pluginStore, trackPrompt } from './kit'

const ANSWER = 'The saved answer remains useful after compaction.'
const RESULT = 'The saved result remains verified after compaction.'

const prepare = async ($: Engine, on: On) => {
  mock.clock(on)
  const initial: Ledger = {
    ...EMPTY, session_id: SESSION, nextQuestionId: 3,
    questions: [
      { id: 1, head: 'Keep the tracked question', at: 1000, turnId: 'before-compact', status: 'open', trackedBy: 'old-question-call' },
      { id: 2, head: 'Keep the saved answer', at: 900, turnId: 'before-compact', status: 'answered',
        answeredBy: 'old-answer-call', answeredAt: 1100, answerText: ANSWER, answerTextHash: await checksumOf(ANSWER) },
    ],
    steps: [{ id: 'plan:1', source: 'plan', subject: 'Keep the saved result', status: 'completed',
      resultRequestId: 'old-result-call', resultAt: 1200, resultText: RESULT, resultTextHash: await checksumOf(RESULT) }],
  }
  const memory = atomStore<Ledger>(on, 'ledger', initial)
  const store = pluginStore(on, { [`s:${SESSION}`]: { v: 1, session_id: SESSION, savedAt: 1, ledger: initial } })
  let compacted = false
  on('session.id', () => ({ value: SESSION }))
  on('session.usage', () => ({ value: {
    startedAt: 1, context: { window: 200000, ...(!compacted && { tokens: 20000, percent: 10 }) }, rateLimits: [],
  } }))
  on('session.messages', () => ({ value: compacted
    ? [{ role: 'user' as const, text: 'A compacted summary of earlier work.', toolUses: [] }]
    : [{ role: 'assistant' as const, text: '', toolUses: [
      { tool_use_id: 'old-question-call', tool: 'mcp__track__track_question', input: { summary: 'Keep the tracked question' } },
      { tool_use_id: 'old-answer-call', tool: 'mcp__track__mark_answered', input: { id: 2, status: 'answered' } },
      { tool_use_id: 'old-result-call', tool: 'mcp__track__mark_step', input: { id: 'plan:1', status: 'completed', result_text: RESULT } },
    ] }] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('env.get', () => ({ value: undefined }))
  on('env.set', () => ({ value: {} }))
  logs(on)
  await $.turn.start({ text: 'Earlier work', turnId: 'before-compact' })
  await $.turn.complete({ answer: 'Earlier work saved', reason: 'answer', turnId: 'before-compact', durationMs: 1, isAborted: false } as never)
  const saved = () => (store.held.get(`s:${SESSION}`) as { ledger: Ledger }).ledger
  // A failed initial save is not a reproduction of compaction loss.
  expect(saved().questions).toHaveLength(2)
  expect(saved().questions[1]?.answerText).toBe(ANSWER)
  expect(saved().steps[0]?.resultText).toBe(RESULT)
  return { memory, saved, compact: () => { compacted = true } }
}

for (const subject of ['question', 'answer', 'result'] as const) {
  test(`compaction without its callback keeps the saved ${subject}`, async ($, on) => {
    const fixture = await prepare($, on)
    fixture.compact()
    // Deliberately do not invoke session.compact or classic.SessionStart.
    await trackPrompt($, 'Continue the retained work')
    for (const ledger of [fixture.memory.value, fixture.saved()]) {
      if (subject === 'question') expect(ledger.questions.find(q => q.id === 1)?.head).toBe('Keep the tracked question')
      if (subject === 'answer') {
        expect(ledger.questions.find(q => q.id === 2)?.status).toBe('answered')
        expect(ledger.questions.find(q => q.id === 2)?.answerText).toBe(ANSWER)
      }
      if (subject === 'result') expect(ledger.steps[0]?.resultText).toBe(RESULT)
    }
  })
}

test('the compaction-loss fixture keeps acknowledged rows when the transcript is intact', async ($, on) => {
  const fixture = await prepare($, on)
  await trackPrompt($, 'Continue the retained work')
  expect(fixture.memory.value.questions).toHaveLength(2)
  expect(fixture.saved().questions[1]?.answerText).toBe(ANSWER)
  expect(fixture.saved().steps[0]?.resultText).toBe(RESULT)
})
