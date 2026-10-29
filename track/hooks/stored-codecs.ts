import type { Ledger, Prompt, Question, Restore, Step } from '../types'
import { STEP_STATUSES, QUESTION_STATUSES, MAX_PROMPTS, MAX_QUESTIONS, capRows, capSteps, isDefined, keepRestores } from './ledger-policy'
import { HEAD_CHARS, ANSWER_CHARS, RESULT_CHARS, headOf, truncate } from './ledger-text'
import { assertLedgerOwner, questionHighWater } from './reconcile'

// `{ [key]: value }` when value is a string, else nothing: an optional text field of a saved row.
const textField = <K extends string>(key: K, value: unknown): Partial<Record<K, string>> =>
  typeof value === 'string' ? ({ [key]: value } as Record<K, string>) : {}

// A saved prompt or question as a fresh row, or undefined when the row is not one.
const savedPrompt = (row: unknown): Prompt | undefined => {
  if (typeof row !== 'object' || row === null) {
    return undefined
  }
  const r = row as Record<string, unknown>
  if (typeof r.rowKey !== 'string' || typeof r.head !== 'string' || typeof r.at !== 'number') {
    return undefined
  }

  return { rowKey: r.rowKey, head: headOf(r.head), at: r.at, turnId: typeof r.turnId === 'string' ? r.turnId : null, ...textField('requestId', r.requestId) }
}

// A saved native A-marker's provenance, kept so a reload compares equal in the three-way merge.
const savedMarker = (m: Record<string, unknown>): Pick<Question, 'answerMarker'> | undefined =>
  typeof m.turnId === 'string' && m.turnId !== '' && typeof m.order === 'number' && Number.isSafeInteger(m.order) && m.order >= 0
    ? { answerMarker: { turnId: m.turnId, order: m.order } }
    : undefined

export const savedQuestion = (row: unknown): Question | undefined => {
  if (typeof row !== 'object' || row === null) {
    return undefined
  }
  const r = row as Record<string, unknown>
  const status = QUESTION_STATUSES.find(one => one === r.status)
  if (typeof r.id !== 'number' || typeof r.head !== 'string' || typeof r.at !== 'number' || status === undefined) {
    return undefined
  }

  return {
    id: r.id,
    head: headOf(r.head),
    at: r.at,
    turnId: typeof r.turnId === 'string' ? r.turnId : null,
    status,
    ...textField('rowKey', r.rowKey),
    ...textField('askedRequestId', r.askedRequestId),
    ...textField('answerRequestId', r.answerRequestId),
    ...textField('answeredBy', r.answeredBy),
    ...textField('answerTurnId', r.answerTurnId),
    ...(typeof r.answerTextHash === 'string' && /^[0-9a-f]{64}$/.test(r.answerTextHash) && { answerTextHash: r.answerTextHash }),
    ...(typeof r.answerOrder === 'number' && Number.isSafeInteger(r.answerOrder) && r.answerOrder >= 0 && { answerOrder: r.answerOrder }),
    ...textField('answerKey', r.answerKey),
    ...(typeof r.answerMarker === 'object' && r.answerMarker !== null && savedMarker(r.answerMarker as Record<string, unknown>)),
    ...textField('trackedBy', r.trackedBy),
    ...(typeof r.trackedOrder === 'number' && Number.isSafeInteger(r.trackedOrder) && r.trackedOrder >= 0 && { trackedOrder: r.trackedOrder }),
    ...textField('restoredFrom', r.restoredFrom),
    ...textField('restoredBy', r.restoredBy),
    ...textField('sourceId', r.sourceId),
    ...(typeof r.note === 'string' && { note: r.note.slice(0, HEAD_CHARS) }),
    ...(typeof r.answerText === 'string' && { answerText: truncate(r.answerText, ANSWER_CHARS) }),
    ...(typeof r.answeredAt === 'number' && { answeredAt: r.answeredAt }),
    ...(r.cleared === true && { cleared: true as const }),
  }
}

// A saved restore row's record, or undefined when the row is not one.
const savedRestore = (row: unknown): Restore | undefined => {
  if (typeof row !== 'object' || row === null) {
    return undefined
  }
  const r = row as Record<string, unknown>
  if (typeof r.by !== 'string' || typeof r.from !== 'string' || typeof r.steps !== 'number' || !Array.isArray(r.questions)) {
    return undefined
  }

  return { by: r.by, from: r.from, steps: r.steps,
    ...(typeof r.visibleSteps === 'number' && Number.isSafeInteger(r.visibleSteps) && r.visibleSteps >= 0 && r.visibleSteps <= r.steps && { visibleSteps: r.visibleSteps }),
    questions: r.questions.map(savedQuestion).filter(isDefined).slice(-MAX_QUESTIONS), ...(r.display === 'user' && { display: 'user' as const }) }
}

// A saved step as a fresh Step, or undefined when the row is not one: restore_tracker reads rows
// another session saved, and copies only the fields a step has.
export const savedStep = (row: unknown): Step | undefined => {
  if (typeof row !== 'object' || row === null) {
    return undefined
  }
  const r = row as Record<string, unknown>
  const source = (['task', 'todo', 'plan'] as const).find(one => one === r.source)
  const status = STEP_STATUSES.find(one => one === r.status)
  if (typeof r.id !== 'string' || typeof r.subject !== 'string' || source === undefined || status === undefined) {
    return undefined
  }

  return {
    id: r.id,
    source,
    subject: headOf(r.subject),
    status,
    ...(typeof r.taskId === 'string' ? { taskId: r.taskId } : {}),
    ...(r.cleared === true ? { cleared: true as const } : {}),
    ...(r.delegated === true && status !== 'completed' && status !== 'waiting' && { delegated: true as const }),
    ...(status === 'in_progress' && typeof r.activeTurnId === 'string' && { activeTurnId: r.activeTurnId }),
    ...(typeof r.startedAt === 'number' ? { startedAt: r.startedAt } : {}),
    ...(typeof r.endedAt === 'number' ? { endedAt: r.endedAt } : {}),
    ...textField('sourceId', r.sourceId),
    ...(typeof r.note === 'string' && { note: r.note }),
    ...(r.followUp === true ? { followUp: true as const } : {}),
    ...(status === 'completed' && typeof r.resultText === 'string' && r.resultText.trim() !== '' && {
      resultText: r.resultText.slice(0, RESULT_CHARS),
      ...(typeof r.resultTextHash === 'string' && /^[0-9a-f]{64}$/.test(r.resultTextHash) && { resultTextHash: r.resultTextHash }),
      ...textField('resultRequestId', r.resultRequestId),
      ...textField('resultTurnId', r.resultTurnId),
      ...(typeof r.resultAt === 'number' && Number.isFinite(r.resultAt) && { resultAt: r.resultAt }),
    }),
  }
}

// A saved bucket's register, or undefined when it is not one of this version: a resume reads what
// an earlier version or a damaged store left. Only well-formed rows are kept, and the next
// question id stays above every id kept or withdrawn.
export const savedLedger = (raw: unknown, owner?: string): Ledger | undefined => {
  const bucket = raw as { v?: unknown; ledger?: Record<string, unknown> | null } | undefined
  const l = bucket?.ledger
  if (bucket?.v !== 1 || typeof l !== 'object' || l === null) {
    return undefined
  }
  if (owner !== undefined) assertLedgerOwner(l, owner)
  const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  const questions = capRows(rows(l.questions).map(savedQuestion).filter(isDefined), MAX_QUESTIONS, q => q.status === 'answered')
  const withdrawn = rows(l.withdrawn).filter(
    (w): w is { id: number; head: string } => typeof (w as { id?: unknown })?.id === 'number' && typeof (w as { head?: unknown })?.head === 'string',
  )
  const clearedSteps = rows(l.clearedSteps).filter(
    (c): c is { id: string; head: string } => typeof (c as { id?: unknown })?.id === 'string' && typeof (c as { head?: unknown })?.head === 'string',
  )
  const restores = keepRestores(rows(l.restores).map(savedRestore).filter(isDefined), questions)

  return {
    v: 1,
    nextQuestionId: questionHighWater({ nextQuestionId: Math.max(1, typeof l.nextQuestionId === 'number' ? l.nextQuestionId : 1), questions, withdrawn }),
    prompts: rows(l.prompts).map(savedPrompt).filter(isDefined).slice(-MAX_PROMPTS),
    questions,
    steps: capSteps(rows(l.steps).map(savedStep).filter(isDefined)),
    ...(withdrawn.length > 0 && { withdrawn }),
    ...(clearedSteps.length > 0 && { clearedSteps }),
    ...(typeof l.compactedAt === 'number' && { compactedAt: l.compactedAt }),
    ...(restores.length > 0 && { restores }),
    ...(typeof l.restoredIds === 'object' && l.restoredIds !== null && { restoredIds: Object.fromEntries(Object.entries(l.restoredIds).filter(([, id]) => Number.isSafeInteger(id) && Number(id) > 0)) as Record<string, number> }),
  }
}
