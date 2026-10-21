// FIXTURE, 2026-10-22: model a compacted main window without session.compact.
// This checks Track's data-loss path, not whether the native dispatcher skips it.
import { expect, mock, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import type { Ledger } from '../types'
import type { Engine, On } from './kit'
import { checksumOf } from '../hooks/checkpoint'
import { EMPTY, SESSION, atomStore, logs, pluginStore, trackPrompt } from './kit'

const ANSWER = 'The saved answer remains useful after compaction.'
const RESULT = 'The saved result remains verified after compaction.'
const HEAD: SessionMessage[] = [
  { role: 'user', text: 'Start the work.', toolUses: [] },
  { role: 'assistant', text: 'I will keep the questions and results.', toolUses: [] },
  { role: 'user', text: 'Record the next work.', toolUses: [] },
]
const SUMMARY: SessionMessage = { role: 'user', text: 'A compacted summary of earlier work.', toolUses: [] }

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
  let changed = false
  let messages: SessionMessage[] = [...HEAD, { role: 'assistant', text: '', toolUses: [
    { tool_use_id: 'old-question-call', tool: 'mcp__track__track_question', input: { summary: 'Keep the tracked question' } },
    { tool_use_id: 'old-answer-call', tool: 'mcp__track__mark_answered', input: { id: 2, status: 'answered' } },
    { tool_use_id: 'old-result-call', tool: 'mcp__track__mark_step', input: { id: 'plan:1', status: 'completed', result_text: RESULT } },
  ] }]
  on('session.id', () => ({ value: SESSION }))
  on('session.usage', () => ({ value: {
    startedAt: 1, context: { window: 200000, ...(!changed && { tokens: 20000, percent: 10 }) }, rateLimits: [],
  } }))
  on('session.messages', () => ({ value: messages }))
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
  return { memory, saved, replaceTranscript: (next: SessionMessage[]) => { messages = next; changed = true } }
}

for (const layout of ['replaced head', 'retained first three messages'] as const) {
  for (const subject of ['question', 'answer', 'result'] as const) {
    test(`compaction without its callback keeps the saved ${subject}: ${layout}`, async ($, on) => {
      const fixture = await prepare($, on)
      fixture.replaceTranscript(layout === 'replaced head' ? [SUMMARY] : [...HEAD, SUMMARY])
      // Deliberately do not invoke session.compact or classic.SessionStart.
      await trackPrompt($, 'Continue the retained work')
      // One assertion includes BOTH observations even when the memory value is wrong.
      const observed = [fixture.memory.value, fixture.saved()].map(ledger => {
        if (subject === 'question') return ledger.questions.find(q => q.id === 1)?.head
        if (subject === 'answer') {
          const question = ledger.questions.find(q => q.id === 2)
          return { status: question?.status, answerText: question?.answerText }
        }
        return ledger.steps[0]?.resultText
      })
      const expected = subject === 'question' ? 'Keep the tracked question'
        : subject === 'answer' ? { status: 'answered', answerText: ANSWER } : RESULT
      expect(observed).toEqual([expected, expected])
    })
  }
}

for (const extent of ['tail', 'whole conversation'] as const) {
  test(`a real rewind of the ${extent} removes only the rewound provenance from memory and storage`, async ($, on) => {
    const fixture = await prepare($, on)
    // The same absent token count as compaction must not disable actual rewind handling.
    fixture.replaceTranscript(extent === 'tail' ? [...HEAD] : [])
    await trackPrompt($, 'Continue after the rewind')
    const observed = [fixture.memory.value, fixture.saved()].map(ledger => ({
      removedQuestion: ledger.questions.find(q => q.id === 1),
      answerStatus: ledger.questions.find(q => q.id === 2)?.status,
      answerText: ledger.questions.find(q => q.id === 2)?.answerText,
      resultText: ledger.steps[0]?.resultText,
    }))
    const expected = { removedQuestion: undefined, answerStatus: 'open', answerText: undefined, resultText: undefined }
    expect(observed).toEqual([expected, expected])
  })
}

test('the compaction-loss fixture keeps acknowledged rows when the transcript is intact', async ($, on) => {
  const fixture = await prepare($, on)
  await trackPrompt($, 'Continue the retained work')
  expect(fixture.memory.value.questions).toHaveLength(2)
  expect(fixture.saved().questions[1]?.answerText).toBe(ANSWER)
  expect(fixture.saved().steps[0]?.resultText).toBe(RESULT)
})
