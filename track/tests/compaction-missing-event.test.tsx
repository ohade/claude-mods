// FIXTURE, 2026-10-22: model a compacted main window without session.compact.
// This checks Track's data-loss path, not whether the native dispatcher skips it.
import { expect, mock, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import type { Ledger } from '../types'
import type { Engine, On } from './kit'
import { checksumOf } from '../hooks/checkpoint'
import { EMPTY, SESSION, atomStore, blobPool, logs, pluginStore, trackPrompt } from './kit'

const ANSWER = 'The saved answer remains useful after compaction.'
const RESULT = 'The saved result remains verified after compaction.'
const HEAD: SessionMessage[] = [
  { role: 'user', text: 'Start the work.', toolUses: [] },
  { role: 'assistant', text: 'I will keep the questions and results.', toolUses: [] },
  { role: 'user', text: 'Record the next work.', toolUses: [] },
]
const SUMMARY: SessionMessage = { role: 'user', text: 'A compacted summary of earlier work.', toolUses: [] }

const prepare = async ($: Engine, on: On, options: { questionInPrefix?: boolean; compactedAt?: number } = {}) => {
  mock.clock(on)
  const initial: Ledger = {
    ...EMPTY, session_id: SESSION, nextQuestionId: 3,
    ...(options.compactedAt !== undefined && { compactedAt: options.compactedAt }),
    questions: [
      { id: 1, head: 'Keep the tracked question', at: 1000, turnId: 'before-compact', status: 'open', trackedBy: 'old-question-call' },
      { id: 2, head: 'Keep the saved answer', at: 900, turnId: 'before-compact', status: 'answered',
        answeredBy: 'old-answer-call', answeredAt: 1100, answerText: ANSWER, answerTextHash: await checksumOf(ANSWER) },
    ],
    steps: [{ id: 'plan:1', source: 'plan', subject: 'Keep the saved result', status: 'completed',
      resultRequestId: 'old-result-call', resultAt: 1200, resultText: RESULT, resultTextHash: await checksumOf(RESULT) }],
  }
  const memory = atomStore<Ledger>(on, 'ledger', initial)
  const pool = blobPool(on)
  const store = pluginStore(on, { [`s:${SESSION}`]: { v: 1, session_id: SESSION, savedAt: 1, ledger: initial } })
  let changed = false
  const calls: SessionMessage['toolUses'] = [
    { tool_use_id: 'old-question-call', tool: 'mcp__track__track_question', input: { summary: 'Keep the tracked question' } },
    { tool_use_id: 'old-answer-call', tool: 'mcp__track__mark_answered', input: { id: 2, status: 'answered' } },
    { tool_use_id: 'old-result-call', tool: 'mcp__track__mark_step', input: { id: 'plan:1', status: 'completed', result_text: RESULT } },
  ]
  const prefix = HEAD.map(message => options.questionInPrefix && message.role === 'assistant'
    ? { ...message, toolUses: [calls[0]!] } : message)
  let messages: SessionMessage[] = [...prefix, { role: 'assistant', text: '', toolUses: options.questionInPrefix ? calls.slice(1) : calls }]
  const reads = { fail: false, denied: 0 }
  on('session.id', () => ({ value: SESSION }))
  on('session.usage', () => ({ value: {
    startedAt: 1, context: { window: 200000, ...(!changed && { tokens: 20000, percent: 10 }) }, rateLimits: [],
  } }))
  on('session.messages', () => {
    if (reads.fail) {
      reads.denied++
      return { deny: 'fixture transcript read temporarily unavailable' }
    }
    return { value: messages }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('env.get', () => ({ value: undefined }))
  on('env.set', () => ({ value: {} }))
  logs(on)
  await $.turn.start({ text: 'Earlier work', turnId: 'before-compact' })
  await $.turn.complete({ answer: 'Earlier work saved', reason: 'answer', turnId: 'before-compact', durationMs: 1, isAborted: false } as never)
  // Read the durable logical rows through the v2 pointer, never from Track's memory.
  const saved = async () => (await pool.logical(store, `s:${SESSION}`) as { ledger: Ledger }).ledger
  // A failed initial save is not a reproduction of compaction loss.
  const initialRows = [memory.value, await saved()].map(ledger => ({
    questionCount: ledger.questions.length, answerText: ledger.questions[1]?.answerText, resultText: ledger.steps[0]?.resultText,
  }))
  const expectedInitial = { questionCount: 2, answerText: ANSWER, resultText: RESULT }
  expect(initialRows).toEqual([expectedInitial, expectedInitial])
  return { memory, saved, prefix, reads, replaceTranscript: (next: SessionMessage[]) => { messages = next; changed = true } }
}

for (const layout of ['replaced head', 'retained first three messages'] as const) {
  for (const subject of ['question', 'answer', 'result'] as const) {
    test(`compaction without its callback keeps the saved ${subject}: ${layout}`, async ($, on) => {
      const fixture = await prepare($, on)
      fixture.replaceTranscript(layout === 'replaced head' ? [SUMMARY] : [...HEAD, SUMMARY])
      // Deliberately do not invoke session.compact or classic.SessionStart.
      await trackPrompt($, 'Continue the retained work')
      // One assertion includes BOTH observations even when the memory value is wrong.
      const observed = [fixture.memory.value, await fixture.saved()].map(ledger => {
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
    const observed = [fixture.memory.value, await fixture.saved()].map(ledger => ({
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
  const expected = {
    questions: [KEPT_QUESTION, { ...KEPT_ANSWER, answerTextHash: await checksumOf(ANSWER) }],
    steps: [{ ...KEPT_RESULT, resultTextHash: await checksumOf(RESULT) }],
  }
  expect(await pairedRows(fixture)).toEqual([expected, expected])
})

// Full row observations include saved provenance and hashes, with both views in one assertion.
const pairedRows = async (fixture: Awaited<ReturnType<typeof prepare>>, includeCompactedAt = false) =>
  [fixture.memory.value, await fixture.saved()].map(ledger => ({
    questions: ledger.questions, steps: ledger.steps,
    ...(includeCompactedAt && { compactedAt: ledger.compactedAt }),
  }))

const KEPT_QUESTION = {
  session_id: SESSION, id: 1, head: 'Keep the tracked question', at: 1000,
  turnId: 'before-compact', status: 'open', trackedBy: 'old-question-call',
}
const KEPT_ANSWER = {
  session_id: SESSION, id: 2, head: 'Keep the saved answer', at: 900,
  turnId: 'before-compact', status: 'answered', answeredBy: 'old-answer-call', answeredAt: 1100, answerText: ANSWER,
}
const KEPT_RESULT = {
  session_id: SESSION, id: 'plan:1', source: 'plan', subject: 'Keep the saved result', status: 'completed',
  resultRequestId: 'old-result-call', resultAt: 1200, resultText: RESULT,
}

test('a real tail rewind with the submitted prompt appended clears only rewound provenance in both views', async ($, on) => {
  const fixture = await prepare($, on)
  await trackPrompt($, 'Observe the intact transcript')
  const continuation = 'Continue after the real tail rewind'
  fixture.replaceTranscript([...HEAD, { role: 'user', text: continuation, toolUses: [] }])
  await trackPrompt($, continuation)
  const expected = {
    questions: [{ session_id: SESSION, id: 2, head: 'Keep the saved answer', at: 900, turnId: 'before-compact', status: 'open' }],
    steps: [{ session_id: SESSION, id: 'plan:1', source: 'plan', subject: 'Keep the saved result', status: 'completed' }],
  }
  expect(await pairedRows(fixture)).toEqual([expected, expected])
})

test('a partial rewind keeps the tracked question in the retained prefix and clears only tail provenance in both views', async ($, on) => {
  const fixture = await prepare($, on, { questionInPrefix: true })
  await trackPrompt($, 'Observe the intact provenance-bearing prefix')
  const continuation = 'Continue after the partial rewind'
  fixture.replaceTranscript([...fixture.prefix.slice(0, 2), { role: 'user', text: continuation, toolUses: [] }])
  await trackPrompt($, continuation)
  const expected = {
    questions: [KEPT_QUESTION, { session_id: SESSION, id: 2, head: 'Keep the saved answer', at: 900, turnId: 'before-compact', status: 'open' }],
    steps: [{ session_id: SESSION, id: 'plan:1', source: 'plan', subject: 'Keep the saved result', status: 'completed' }],
  }
  expect(await pairedRows(fixture)).toEqual([expected, expected])
})

const RECAPS: SessionMessage[] = [
  { role: 'user', text: 'Recap: keep the pending question, completed answer, and verified work result.', toolUses: [] },
  { role: 'assistant', text: 'Earlier progress: the tracked items remain recorded while work continues.', toolUses: [] },
]

for (const recap of RECAPS) {
  for (const layout of ['replaced head', 'retained first three messages'] as const) {
    test(`a ${recap.role} recap without a compact callback keeps all acknowledged rows in both views: ${layout}`, async ($, on) => {
      const fixture = await prepare($, on)
      await trackPrompt($, 'Observe the intact transcript')
      fixture.replaceTranscript(layout === 'replaced head' ? [recap] : [...HEAD, recap])
      await trackPrompt($, 'Continue the retained work')
      const expected = {
        questions: [KEPT_QUESTION, { ...KEPT_ANSWER, answerTextHash: await checksumOf(ANSWER) }],
        steps: [{ ...KEPT_RESULT, resultTextHash: await checksumOf(RESULT) }],
      }
      expect(await pairedRows(fixture)).toEqual([expected, expected])
    })
  }
}

test('a replacement without a compact callback keeps rows newer than an existing compactedAt in both views', async ($, on) => {
  const fixture = await prepare($, on, { compactedAt: 950 })
  await trackPrompt($, 'Observe rows newer than the prior compaction')
  fixture.replaceTranscript([{ role: 'assistant', text: 'The next phase continues from the saved questions and finished work.', toolUses: [] }])
  await trackPrompt($, 'Continue after the later replacement')
  const expected = {
    questions: [KEPT_QUESTION, { ...KEPT_ANSWER, answerTextHash: await checksumOf(ANSWER) }],
    steps: [{ ...KEPT_RESULT, resultTextHash: await checksumOf(RESULT) }],
  }
  expect(await pairedRows(fixture)).toEqual([expected, expected])
})

test('two consecutive non-prefix replacements each keep all acknowledged rows in both views', async ($, on) => {
  const fixture = await prepare($, on)
  await trackPrompt($, 'Observe the intact transcript')
  const expected = {
    questions: [KEPT_QUESTION, { ...KEPT_ANSWER, answerTextHash: await checksumOf(ANSWER) }],
    steps: [{ ...KEPT_RESULT, resultTextHash: await checksumOf(RESULT) }],
  }
  fixture.replaceTranscript([RECAPS[0]!])
  await trackPrompt($, 'Continue after the first replacement')
  expect(await pairedRows(fixture)).toEqual([expected, expected])
  fixture.replaceTranscript([RECAPS[1]!])
  await trackPrompt($, 'Continue after the second replacement')
  expect(await pairedRows(fixture)).toEqual([expected, expected])
})

test('a denied transcript read preserves acknowledged rows and the baseline for a later real rewind in both views', async ($, on) => {
  const fixture = await prepare($, on, { compactedAt: 950 })
  await trackPrompt($, 'Observe the intact transcript before the read failure')
  fixture.reads.fail = true
  const [submission] = await Promise.allSettled([trackPrompt($, 'Continue while the transcript is unavailable')])
  // A future caller may handle the denial; any rejection must be this injected fault.
  if (submission?.status === 'rejected') expect(String(submission.reason)).toContain('fixture transcript read temporarily unavailable')
  expect(fixture.reads.denied).toBeGreaterThan(0)
  const expected = {
    questions: [KEPT_QUESTION, { ...KEPT_ANSWER, answerTextHash: await checksumOf(ANSWER) }],
    steps: [{ ...KEPT_RESULT, resultTextHash: await checksumOf(RESULT) }],
    compactedAt: 950,
  }
  expect(await pairedRows(fixture, true)).toEqual([expected, expected])
  fixture.reads.fail = false
  const continuation = 'Continue after reads recover and the tail is rewound'
  fixture.replaceTranscript([...HEAD, { role: 'user', text: continuation, toolUses: [] }])
  await trackPrompt($, continuation)
  const rewound = {
    questions: [{ session_id: SESSION, id: 2, head: 'Keep the saved answer', at: 900, turnId: 'before-compact', status: 'open' }],
    steps: [{ session_id: SESSION, id: 'plan:1', source: 'plan', subject: 'Keep the saved result', status: 'completed' }],
  }
  expect(await pairedRows(fixture)).toEqual([rewound, rewound])
})
