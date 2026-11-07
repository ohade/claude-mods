import type { Ledger, Prompt, Question } from '../types'
import { capRows, MAX_QUESTIONS } from './ledger-policy'
import { ANSWER_CHARS, headOf, norm, truncate } from './ledger-text'

type Source = { trackedTurnId: string | null; sourceText?: string; sourceRequestId?: string; sourceRowKey?: string }
type Mint = { summary: string; now: number; trackedOrder: number; trackedTurnId: string | null; source?: Prompt; toolUseId?: string; session?: string }
type Mark = {
  status: 'answered' | 'deferred'; now: number; note?: string
  answerRequestId?: string; answeredBy?: string; answerKey?: string
  answerText?: string; answerTextHash?: string; answerTurnId?: string; answerOrder?: number
}
type Answer = { text: string; answerText: string; textHash: string; row: string; requestId: string; turnId: string | null; order: number }
type Block = { id: number; text: string; hash: string }
type Marker = { block: Block; now: number; requestId: string; answerKey: string; turnId: string; order: number }

export const questionAdmission = (ledger: Ledger, summary: string): { existing?: Question; capacityExceeded: boolean } => ({
  existing: ledger.questions.find(q => q.cleared !== true && q.status !== 'answered' && norm(q.head) === norm(summary)),
  capacityExceeded: capRows([...ledger.questions, { id: -1, head: summary, at: 0, turnId: null, status: 'open' as const }], MAX_QUESTIONS, q => q.status === 'answered').length > MAX_QUESTIONS,
})

export const questionSource = (prompts: Prompt[], source: Source): Prompt | undefined => {
  if (source.sourceRequestId !== undefined || source.sourceRowKey !== undefined) {
    return prompts.find(p => (source.sourceRequestId !== undefined && p.requestId === source.sourceRequestId) || (source.sourceRowKey !== undefined && p.rowKey === source.sourceRowKey))
  }
  const matches = source.sourceText !== undefined ? prompts.filter(p => p.turnId === source.trackedTurnId && p.head === headOf(source.sourceText!)) : []
  return matches.length === 1 ? matches[0] : undefined
}

export const mintQuestion = (ledger: Ledger, values: Mint): { ledger: Ledger; minted: Question; capacityExceeded: boolean } => {
  const { summary, now, trackedOrder, trackedTurnId, source, toolUseId, session } = values
  const minted: Question = {
    id: ledger.nextQuestionId, head: summary, at: now, trackedOrder,
    ...(source?.rowKey !== undefined && { rowKey: source.rowKey }),
    ...((source?.requestId ?? toolUseId) !== undefined && { askedRequestId: source?.requestId ?? toolUseId }),
    ...(toolUseId !== undefined && { trackedBy: toolUseId }),
    turnId: trackedTurnId, status: 'open',
  }
  const questions = capRows([...ledger.questions, minted], MAX_QUESTIONS, q => q.status === 'answered')
  const capacityExceeded = questions.length > MAX_QUESTIONS
  return { ledger: capacityExceeded ? ledger : { ...ledger, session_id: ledger.session_id ?? session, nextQuestionId: ledger.nextQuestionId + 1, questions }, minted, capacityExceeded }
}

export const withdrawQuestion = (ledger: Ledger, id: number, head: string): Ledger => ({
  ...ledger, questions: ledger.questions.filter(q => q.id !== id), withdrawn: [...(ledger.withdrawn ?? []), { id, head }],
})

export const clearQuestionRows = (ledger: Ledger): Ledger => ({
  ...ledger, questions: [],
  withdrawn: [...(ledger.withdrawn ?? []), ...ledger.questions.filter(q => q.status !== 'answered').map(q => ({ id: q.id, head: q.head }))],
})

export const hideAnsweredQuestions = (ledger: Ledger): Ledger => ({
  ...ledger, questions: ledger.questions.map(q => (q.status === 'answered' ? { ...q, cleared: true as const } : q)),
})

export const mayMarkAnswer = (question: Question, id: number, status: Mark['status']): boolean =>
  question.id === id && !(status === 'answered' && question.answerText !== undefined)

export const markQuestion = (question: Question, values: Mark): Question => {
  const { answerKey: _old, answerInstance: _instance, answerInstanceSession: _drawnIn, answerText: _oldText, answerTextHash: _hash, answerTurnId: _turn, answerOrder: _order, answeredBy: _by, answerRequestId: _request, ...rest } = question
  const { status, now, note, answerRequestId, answeredBy, answerKey, answerText, answerTextHash, answerTurnId, answerOrder } = values
  return {
    ...rest, status, answeredAt: now,
    ...(note !== undefined && { note }),
    ...(answerRequestId !== undefined && { answerRequestId }),
    ...(answeredBy !== undefined && { answeredBy }),
    ...(answerKey !== undefined && { answerKey }),
    ...(answerText !== undefined && { answerText: truncate(answerText, ANSWER_CHARS) }),
    ...(answerTextHash !== undefined && { answerTextHash }),
    ...(answerTurnId !== undefined && { answerTurnId }),
    ...(answerOrder !== undefined && { answerOrder }),
  }
}

export const bindAnswerResponse = (ledger: Ledger, answer: Answer): { ledger: Ledger; changed: boolean } => {
  const pending = ledger.questions.filter(q => q.status === 'answered' && q.answerText !== undefined &&
    (q.answerTextHash !== undefined ? q.answerTextHash === answer.textHash : q.answerText === answer.text) &&
    q.answerTurnId === answer.turnId && q.answerOrder !== undefined && answer.order > q.answerOrder)
  if (pending.length !== 1) return { ledger, changed: false }
  let changed = false
  const questions = ledger.questions.map(q => {
    if (q.id !== pending[0]!.id) return q
    const { answerTurnId: _turn, answerOrder: _order, ...rest } = withoutStaleInstance(q, answer.row)
    changed = true
    return { ...rest, answerText: answer.answerText, answerKey: answer.row, answerRequestId: answer.requestId }
  })
  return { ledger: changed ? { ...ledger, questions } : ledger, changed }
}

export const markerForQuestion = (question: Question, completed: Block[], turnId: string, order: number, nativeKey?: string): Block | undefined => {
  const block = completed.find(one => one.id === question.id)
  if (block === undefined || question.cleared === true || (question.turnId === turnId && (question.trackedOrder === undefined || order <= question.trackedOrder))) return undefined
  const native = question.answerRequestId !== undefined && nativeKey !== undefined && question.answerKey === nativeKey && question.answerTextHash !== undefined
  const correcting = question.status === 'answered' && native && question.answerTextHash !== block.hash
  if ((question.status === 'answered' || question.answerText !== undefined) && !correcting) return undefined
  if (question.answerMarker?.turnId === turnId && question.answerMarker.order >= order) return undefined
  return block
}

// A drawn instance belongs to the reply it was drawn in: a new answer source drops it until drawn.
const withoutStaleInstance = (question: Question, answerKey: string | undefined): Question => {
  if (question.answerKey === answerKey) return question
  const { answerInstance: _instance, answerInstanceSession: _drawnIn, ...rest } = question
  return rest
}

export const captureMarkerAnswer = (question: Question, values: Marker): Question => ({
  ...withoutStaleInstance(question, values.answerKey), status: 'answered', answeredAt: values.now, answerText: truncate(values.block.text, ANSWER_CHARS),
  answerTextHash: values.block.hash, answerRequestId: values.requestId, answerKey: values.answerKey,
  answerMarker: { turnId: values.turnId, order: values.order },
})
