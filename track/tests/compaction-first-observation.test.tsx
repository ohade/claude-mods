// FIXTURE: saved rows loaded before this process has observed the earlier transcript.
// A missing compact callback must not turn a compacted source into a rewind.
import { expect, mock, test } from 'claude-code/testing'
import type { PluginState, SessionMessage } from 'claude-code'
import type { Ledger } from '../types'
import type { On } from './kit'
import { checksumOf } from '../hooks/checkpoint'
import { identifyLedger } from '../hooks/reconcile'
import { savedLedger } from '../hooks/stored-codecs'
import { EMPTY, SESSION, atomStore, blobPool, logs, pluginStore, trackPrompt } from './kit'

const ANSWER = 'The earlier answer remains saved.'
const RESULT = 'The earlier result remains saved.'
const prepare = async (on: On, messages: SessionMessage[]) => {
  mock.clock(on, { now: 10000 })
  const raw: Ledger = {
    ...EMPTY, session_id: SESSION, nextQuestionId: 3,
    questions: [
      { id: 1, head: 'Keep the earlier question', at: 1000, turnId: 'before', status: 'open', trackedBy: 'earlier-question' },
      { id: 2, head: 'Keep the earlier answer', at: 1000, turnId: 'before', status: 'answered', answeredBy: 'earlier-answer',
        answeredAt: 1100, answerText: ANSWER, answerTextHash: await checksumOf(ANSWER) },
    ],
    steps: [{ id: 'plan:1', source: 'plan', subject: 'Keep the earlier result', status: 'completed',
      resultRequestId: 'earlier-result', resultAt: 1200, resultText: RESULT, resultTextHash: await checksumOf(RESULT) }],
  }
  // Match the memory shape a real resume loads, including optional fields and key order.
  // Otherwise the save's exact rewind-baseline comparison rejects this synthetic memory.
  const initial = identifyLedger(savedLedger({ v: 1, ledger: raw }, SESSION)!, SESSION)
  const memory = atomStore<Ledger>(on, 'ledger', initial)
  atomStore<PluginState['track']['durability']>(on, 'durability', { isUnsaved: false, reason: '' })
  const pool = blobPool(on)
  const store = pluginStore(on, { [`s:${SESSION}`]: { v: 1, session_id: SESSION, savedAt: 1, ledger: initial } })
  const reads = { messages: 0 }
  on('session.id', () => ({ value: SESSION }))
  on('session.messages', () => { reads.messages++; return { value: messages } })
  on('session.usage', () => ({ value: { startedAt: 1, context: { window: 200000 }, rateLimits: [] } }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('env.get', () => ({ value: undefined }))
  on('env.set', () => ({ value: {} }))
  const lines = logs(on)
  const rows = async () => {
    const saved = (await pool.logical(store, `s:${SESSION}`) as { ledger: Ledger }).ledger
    return [memory.value, saved].map(ledger => ({
      question: ledger.questions.find(q => q.id === 1)?.head,
      answer: ledger.questions.find(q => q.id === 2)?.answerText,
      result: ledger.steps[0]?.resultText,
    }))
  }
  return { rows, reads, lines }
}

for (const text of ['Earlier work was summarized.', 'The retained context describes the earlier work.']) {
  test(`first observation after callback-free compaction preserves saved rows: ${text}`, async ($, on) => {
    const fixture = await prepare(on, [{ role: 'user', text, toolUses: [] }])
    const kept = { question: 'Keep the earlier question', answer: ANSWER, result: RESULT }
    expect(await fixture.rows()).toEqual([kept, kept])
    // No prior prompt read, turn end or session.compact callback in this process.
    const submitted = await trackPrompt($, 'Continue the retained work')
    expect(fixture.reads.messages).toBeGreaterThan(0)
    expect(JSON.stringify(submitted)).not.toContain('Track did not record this prompt')
    expect(fixture.lines.some(line => line.startsWith('track: resume conflict:'))).toBe(false)
    expect(await fixture.rows(), JSON.stringify({ submitted, lines: fixture.lines })).toEqual([kept, kept])
  })
}

test('first observation after a real whole-conversation rewind still removes rewound provenance', async ($, on) => {
  const fixture = await prepare(on, [])
  const submitted = await trackPrompt($, 'Continue after the whole conversation was rewound')
  expect(fixture.reads.messages).toBeGreaterThan(0)
  expect(JSON.stringify(submitted)).not.toContain('Track did not record this prompt')
  expect(fixture.lines.some(line => line.startsWith('track: resume conflict:'))).toBe(false)
  const rewound = { question: undefined, answer: undefined, result: undefined }
  expect(await fixture.rows(), JSON.stringify({ submitted, lines: fixture.lines })).toEqual([rewound, rewound])
})
