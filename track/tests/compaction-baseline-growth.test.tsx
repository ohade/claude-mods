// FIXTURE, 2026-10-25: a transcript that only grew since the last read is not a compaction.
// Pins the blind refuter's high finding on the first baseline fix: growth there moved
// compactedAt forward, so a later multi-turn rewind kept the rewound rows.
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

// The same rows and transcript as compaction-missing-event.test.tsx, with a reader for the current transcript.
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
  const pool = blobPool(on)
  const store = pluginStore(on, { [`s:${SESSION}`]: { v: 1, session_id: SESSION, savedAt: 1, ledger: initial } })
  const calls: SessionMessage['toolUses'] = [
    { tool_use_id: 'old-question-call', tool: 'mcp__track__track_question', input: { summary: 'Keep the tracked question' } },
    { tool_use_id: 'old-answer-call', tool: 'mcp__track__mark_answered', input: { id: 2, status: 'answered' } },
    { tool_use_id: 'old-result-call', tool: 'mcp__track__mark_step', input: { id: 'plan:1', status: 'completed', result_text: RESULT } },
  ]
  let messages: SessionMessage[] = [...HEAD, { role: 'assistant', text: '', toolUses: calls }]
  on('session.id', () => ({ value: SESSION }))
  on('session.usage', () => ({ value: { startedAt: 1, context: { window: 200000 }, rateLimits: [] } }))
  on('session.messages', () => ({ value: messages }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'A compacted summary of earlier work.', toolUses: [] }] }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('env.get', () => ({ value: undefined }))
  on('env.set', () => ({ value: {} }))
  logs(on)
  await $.turn.start({ text: 'Earlier work', turnId: 'before-compact' })
  await $.turn.complete({ answer: 'Earlier work saved', reason: 'answer', turnId: 'before-compact', durationMs: 1, isAborted: false } as never)
  const saved = async () => (await pool.logical(store, `s:${SESSION}`) as { ledger: Ledger }).ledger
  return {
    memory, saved,
    current: () => messages,
    replaceTranscript: (next: SessionMessage[]) => { messages = next },
  }
}

test('growth since the last read is not a compaction: a later tail rewind still clears rewound provenance in both views', async ($, on) => {
  const fixture = await prepare($, on)
  await trackPrompt($, 'Observe the intact transcript')
  const next = 'Keep working on the next step'
  fixture.replaceTranscript([...fixture.current(),
    { role: 'user', text: next, toolUses: [] }, { role: 'assistant', text: 'Working on the next step.', toolUses: [] }])
  await trackPrompt($, next)
  const continuation = 'Continue after the real tail rewind'
  fixture.replaceTranscript([...HEAD, { role: 'user', text: continuation, toolUses: [] }])
  await trackPrompt($, continuation)
  const rewound = {
    questions: [{ session_id: SESSION, id: 2, head: 'Keep the saved answer', at: 900, turnId: 'before-compact', status: 'open' }],
    steps: [{ session_id: SESSION, id: 'plan:1', source: 'plan', subject: 'Keep the saved result', status: 'completed' }],
  }
  const views = [fixture.memory.value, await fixture.saved()].map(ledger => ({ questions: ledger.questions, steps: ledger.steps }))
  expect({ growthThenTailRewindRows: views }).toEqual({ growthThenTailRewindRows: [rewound, rewound] })
})

test('after a compaction with its callback, a turn end keeps the callback time: rewinding the next turn clears its new question in both views', async ($, on) => {
  const fixture = await prepare($, on)
  await trackPrompt($, 'Observe the intact transcript')
  const summary: SessionMessage = { role: 'user', text: 'A compacted summary of earlier work.', toolUses: [] }
  await $.session.compact({ trigger: 'manual', messages: [summary] } as never)
  const compactedAt = fixture.memory.value.compactedAt
  expect(typeof compactedAt).toBe('number')
  fixture.replaceTranscript([summary])
  const ask = 'Ask the next question'
  await trackPrompt($, ask)
  // The turn tracks a new question: its row and its tool call, newer than the compaction.
  fixture.memory.value = { ...fixture.memory.value, nextQuestionId: 4, questions: [...fixture.memory.value.questions,
    { id: 3, head: 'A question after the compaction', at: Date.now(), turnId: 'after-compact', status: 'open', trackedBy: 'new-question-call' }] }
  fixture.replaceTranscript([summary, { role: 'user', text: ask, toolUses: [] }, { role: 'assistant', text: '',
    toolUses: [{ tool_use_id: 'new-question-call', tool: 'mcp__track__track_question', input: { summary: 'A question after the compaction' } }] }])
  await $.turn.start({ text: ask, turnId: 'after-compact' })
  await $.turn.complete({ answer: 'Asked', reason: 'answer', turnId: 'after-compact', durationMs: 1, isAborted: false } as never)
  const continuation = 'Continue after rewinding that turn'
  fixture.replaceTranscript([summary, { role: 'user', text: continuation, toolUses: [] }])
  await trackPrompt($, continuation)
  const views = [fixture.memory.value, await fixture.saved()].map(ledger => ({
    newQuestion: ledger.questions.some(q => q.id === 3), compactedAt: ledger.compactedAt }))
  expect({ callbackCompactionThenRewind: views }).toEqual({ callbackCompactionThenRewind: [
    { newQuestion: false, compactedAt }, { newQuestion: false, compactedAt }] })
})

test('a baseline left from before all rows were cleared is not used: rewinding a later turn clears its new question in both views', async ($, on) => {
  const fixture = await prepare($, on)
  await trackPrompt($, 'Observe the intact transcript')
  // Clear all leaves no row with provenance, then the user rewinds to the head.
  fixture.memory.value = { ...fixture.memory.value, questions: [], steps: [] }
  const third = 'Start a new line of work'
  fixture.replaceTranscript([...HEAD, { role: 'user', text: third, toolUses: [] }])
  await trackPrompt($, third)
  fixture.memory.value = { ...fixture.memory.value, nextQuestionId: 4, questions: [
    { id: 3, head: 'A question after Clear all', at: Date.now(), turnId: 'third', status: 'open', trackedBy: 'third-question-call' }] }
  const turnThree: SessionMessage[] = [...HEAD, { role: 'user', text: third, toolUses: [] }, { role: 'assistant', text: '',
    toolUses: [{ tool_use_id: 'third-question-call', tool: 'mcp__track__track_question', input: { summary: 'A question after Clear all' } }] }]
  fixture.replaceTranscript(turnThree)
  await $.turn.start({ text: third, turnId: 'third' })
  await $.turn.complete({ answer: 'Asked', reason: 'answer', turnId: 'third', durationMs: 1, isAborted: false } as never)
  const fourth = 'Continue the new line of work'
  fixture.replaceTranscript([...turnThree, { role: 'user', text: fourth, toolUses: [] }])
  await trackPrompt($, fourth)
  const fifth = 'Continue after rewinding the third turn'
  fixture.replaceTranscript([...HEAD, { role: 'user', text: fifth, toolUses: [] }])
  await trackPrompt($, fifth)
  const views = [fixture.memory.value, await fixture.saved()].map(ledger => ({
    newQuestion: ledger.questions.some(q => q.id === 3), compactedAt: ledger.compactedAt }))
  expect({ staleBaselineThenRewind: views }).toEqual({ staleBaselineThenRewind: [
    { newQuestion: false, compactedAt: undefined }, { newQuestion: false, compactedAt: undefined }] })
})

test('a turn end does not replace the baseline: a compaction without its callback seen first at turn end still keeps every row', async ($, on) => {
  const fixture = await prepare($, on)
  await trackPrompt($, 'Observe the intact transcript')
  const summary: SessionMessage = { role: 'user', text: 'A compacted summary of earlier work.', toolUses: [] }
  fixture.replaceTranscript([summary])
  await $.turn.start({ text: 'Work that was compacted', turnId: 'compacted' })
  await $.turn.complete({ answer: 'Done', reason: 'answer', turnId: 'compacted', durationMs: 1, isAborted: false } as never)
  await trackPrompt($, 'Continue the retained work')
  const views = [fixture.memory.value, await fixture.saved()].map(ledger => ({
    questions: ledger.questions.map(q => q.id), answered: ledger.questions.find(q => q.id === 2)?.status,
    result: ledger.steps[0]?.resultText }))
  const kept = { questions: [1, 2], answered: 'answered', result: RESULT }
  expect({ turnEndKeepsBaseline: views }).toEqual({ turnEndKeepsBaseline: [kept, kept] })
})
