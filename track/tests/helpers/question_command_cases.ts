// FIXTURE: U2 preserves question decisions with explicit clock and identity values.
import assert from 'node:assert/strict'
import type { Ledger, Prompt, Question } from '../../types'

type Block = { id: number; text: string; hash: string }
type Mark = {
  status: 'answered' | 'deferred'; now: number; note?: string
  answerRequestId?: string; answeredBy?: string; answerKey?: string
  answerText?: string; answerTextHash?: string; answerTurnId?: string; answerOrder?: number
}
export type QuestionCommands = {
  questionAdmission: (ledger: Ledger, summary: string) => { existing?: Question; capacityExceeded: boolean }
  questionSource: (prompts: Prompt[], source: { trackedTurnId: string | null; sourceText?: string; sourceRequestId?: string; sourceRowKey?: string }) => Prompt | undefined
  mintQuestion: (ledger: Ledger, values: { summary: string; now: number; trackedOrder: number; trackedTurnId: string | null; source?: Prompt; toolUseId?: string; session?: string }) => { ledger: Ledger; minted: Question; capacityExceeded: boolean }
  withdrawQuestion: (ledger: Ledger, id: number, head: string) => Ledger
  mayMarkAnswer: (question: Question, id: number, status: 'answered' | 'deferred') => boolean
  markQuestion: (question: Question, values: Mark) => Question
  bindAnswerResponse: (ledger: Ledger, answer: { text: string; answerText: string; textHash: string; row: string; requestId: string; turnId: string | null; order: number }) => { ledger: Ledger; changed: boolean }
  markerForQuestion: (question: Question, completed: Block[], turnId: string, order: number, nativeKey?: string) => Block | undefined
  captureMarkerAnswer: (question: Question, values: { block: Block; now: number; requestId: string; answerKey: string; turnId: string; order: number }) => Question
}

const question = (id: number, extra: Partial<Question> = {}): Question => ({ id, head: `Question ${id}`, at: id, turnId: 't1', status: 'open', ...extra })
const ledger = (questions: Question[] = []): Ledger => ({ v: 1, nextQuestionId: 41, prompts: [], questions, steps: [] })
const fixed = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) fixed(child)
    Object.freeze(value)
  }
  return value
}

export const checkQuestionCommands = (commands: QuestionCommands): void => {
  const open = question(1, { head: '1. Explain this!' })
  const original = fixed(ledger([open]))
  const originalJson = JSON.stringify(original)
  assert.strictEqual(commands.questionAdmission(original, 'explain this').existing, open)
  assert.equal(commands.questionAdmission(ledger([{ ...open, status: 'answered' }]), 'explain this').existing, undefined)
  assert.equal(commands.questionAdmission(ledger([{ ...open, cleared: true }]), 'explain this').existing, undefined)
  const full = fixed({ ...ledger(Array.from({ length: 200 }, (_, index) => question(index + 1))), nextQuestionId: 201 })
  assert.equal(commands.questionAdmission(full, 'New').capacityExceeded, true)
  const spent = fixed({ ...ledger([question(1, { status: 'answered' }), ...full.questions.slice(1)]), nextQuestionId: 201 })
  assert.equal(commands.questionAdmission(spent, 'New').capacityExceeded, false)

  const source: Prompt = fixed({ rowKey: 'source-row', requestId: 'source-request', turnId: 't1', head: 'Exact source', at: 4 })
  const alternate: Prompt = { ...source, rowKey: 'alternate-row', requestId: 'alternate-request' }
  assert.strictEqual(commands.questionSource([source], { trackedTurnId: 't1', sourceText: 'Exact source\nbody' }), source)
  assert.equal(commands.questionSource([source], { trackedTurnId: 't1', sourceText: 'exact source' }), undefined)
  assert.equal(commands.questionSource([source, alternate], { trackedTurnId: 't1', sourceText: 'Exact source' }), undefined)
  assert.strictEqual(commands.questionSource([source, alternate], { trackedTurnId: 'other', sourceText: 'wrong', sourceRequestId: 'alternate-request', sourceRowKey: 'unused' }), alternate)
  assert.strictEqual(commands.questionSource([source], { trackedTurnId: 'other', sourceRequestId: 'old-request', sourceRowKey: 'source-row' }), source)
  assert.equal(commands.questionSource([source], { trackedTurnId: 't1', sourceText: 'Exact source', sourceRequestId: 'missing', sourceRowKey: 'missing' }), undefined, 'explicit source miss has no text fallback')

  const minted = commands.mintQuestion(original, { summary: 'New', now: 500, trackedOrder: 8, trackedTurnId: 't1', source, toolUseId: 'track-call', session: 'owner' })
  assert.deepEqual(minted.minted, { id: 41, head: 'New', at: 500, trackedOrder: 8, rowKey: 'source-row', askedRequestId: 'source-request', trackedBy: 'track-call', turnId: 't1', status: 'open' })
  assert.deepEqual(minted.ledger, { ...original, session_id: 'owner', nextQuestionId: 42, questions: [open, minted.minted] })
  assert.equal(minted.capacityExceeded, false)
  const refused = commands.mintQuestion(full, { summary: 'New', now: 501, trackedOrder: 9, trackedTurnId: null, toolUseId: 'full-call' })
  assert.strictEqual(refused.ledger, full)
  assert.equal(refused.capacityExceeded, true)
  assert.equal(refused.minted.at, 501)
  const evicted = commands.mintQuestion(spent, { summary: 'New', now: 502, trackedOrder: 9, trackedTurnId: null })
  assert.equal(evicted.ledger.questions.length, 200)
  assert.equal(evicted.ledger.questions.some(row => row.id === 1), false)
  assert.deepEqual(commands.withdrawQuestion(original, 1, 'Captured head'), { ...original, questions: [], withdrawn: [{ id: 1, head: 'Captured head' }] })
  assert.deepEqual(commands.withdrawQuestion(ledger(), 1, 'Captured head').withdrawn, [{ id: 1, head: 'Captured head' }], 'withdraw keeps the captured preflight head even if current row is absent')

  const known = question(1, { status: 'answered', answerText: 'Winner', answerKey: 'old-key', answerTextHash: 'old-hash', answerTurnId: 'old-turn', answerOrder: 2, answeredBy: 'old-by', answerRequestId: 'old-request', note: 'keep', answerMarker: { turnId: 'old-marker', order: 1 } })
  assert.equal(commands.mayMarkAnswer(known, 1, 'answered'), false)
  assert.equal(commands.mayMarkAnswer(open, 2, 'answered'), false)
  assert.equal(commands.mayMarkAnswer(known, 1, 'deferred'), true)
  assert.deepEqual(commands.markQuestion(known, { status: 'deferred', now: 600, answerRequestId: 'defer-call', answeredBy: 'defer-call' }), question(1, { status: 'deferred', answeredAt: 600, note: 'keep', answerMarker: { turnId: 'old-marker', order: 1 }, answerRequestId: 'defer-call', answeredBy: 'defer-call' }))
  const marked = commands.markQuestion(open, { status: 'answered', now: 601, answerText: '😀'.repeat(1001), answerTextHash: 'FULL-HASH', answerRequestId: 'mark-call', answeredBy: 'mark-call', answerKey: 'mark-call', answerTurnId: 't1', answerOrder: 8 })
  assert.deepEqual(marked, { ...open, status: 'answered', answeredAt: 601, answerRequestId: 'mark-call', answeredBy: 'mark-call', answerKey: 'mark-call', answerText: '😀'.repeat(999) + '…', answerTextHash: 'FULL-HASH', answerTurnId: 't1', answerOrder: 8 })

  const waiting = question(1, { status: 'answered', answerText: 'Bounded words', answerTextHash: 'FULL-HASH', answerTurnId: 't1', answerOrder: 2, answeredBy: 'mark-call' })
  const observation = { text: 'Full response words', answerText: 'Bounded words', textHash: 'FULL-HASH', row: 'native-row', requestId: 'native-request', turnId: 't1', order: 3 }
  const bound = commands.bindAnswerResponse(ledger([waiting]), observation)
  assert.equal(bound.changed, true)
  assert.deepEqual(bound.ledger.questions, [question(1, { status: 'answered', answerText: 'Bounded words', answerTextHash: 'FULL-HASH', answeredBy: 'mark-call', answerKey: 'native-row', answerRequestId: 'native-request' })])
  const ambiguous = ledger([waiting, { ...waiting, id: 2 }])
  assert.strictEqual(commands.bindAnswerResponse(ambiguous, observation).ledger, ambiguous)
  assert.equal(commands.bindAnswerResponse(ambiguous, observation).changed, false)
  const legacy = { ...waiting }
  delete legacy.answerTextHash
  const legacyBound = commands.bindAnswerResponse(ledger([legacy]), { ...observation, text: 'Bounded words' })
  assert.equal(legacyBound.changed, true)
  assert.equal(Object.hasOwn(legacyBound.ledger.questions[0]!, 'answerTextHash'), false, 'legacy rebind does not invent a hash')

  const block = { id: 1, text: 'Marker answer', hash: 'marker-hash' }
  const tracked = question(1, { trackedOrder: 8 })
  assert.equal(commands.markerForQuestion(tracked, [block], 't1', 8), undefined)
  assert.strictEqual(commands.markerForQuestion(tracked, [block, { ...block, text: 'Second' }], 't1', 9), block)
  assert.equal(commands.markerForQuestion({ ...tracked, cleared: true }, [block], 't1', 9), undefined)
  assert.equal(commands.markerForQuestion(known, [block], 't1', 9, 'different-key'), undefined)
  assert.equal(commands.markerForQuestion(known, [block], 't1', 9, 'old-key'), undefined, 'same-turn question without tracking order remains ineligible')
  assert.strictEqual(commands.markerForQuestion({ ...known, trackedOrder: 1 }, [block], 't1', 9, 'old-key'), block)
  assert.equal(commands.markerForQuestion({ ...known, answerMarker: { turnId: 't1', order: 10 } }, [block], 't1', 9, 'old-key'), undefined)
  const captured = commands.captureMarkerAnswer(known, { block, now: 700, requestId: 'new-request', answerKey: 'new-row:A1', turnId: 't1', order: 9 })
  assert.deepEqual(captured, { ...known, status: 'answered', answeredAt: 700, answerText: 'Marker answer', answerTextHash: 'marker-hash', answerRequestId: 'new-request', answerKey: 'new-row:A1', answerMarker: { turnId: 't1', order: 9 } })
  assert.equal(captured.answerTurnId, 'old-turn')
  assert.equal(captured.answerOrder, 2)
  assert.equal(JSON.stringify(original), originalJson, 'question command inputs remain unchanged')
}
