import { MAX_QUESTIONS, capRows, capSteps, isDefined } from './ledger-policy'
import { savedQuestion, savedStep } from './stored-codecs'

export const restoreSource = (saved: { ledger?: { steps?: unknown; questions?: unknown } } | undefined, from: string) => {
  const rows = Array.isArray(saved?.ledger?.steps) ? (saved.ledger.steps as unknown[]) : []
  const steps = capSteps(rows
    .map(savedStep)
    .filter(isDefined)
    .map(({ taskId: _old, activeTurnId: _turn, resultRequestId: _result, resultTurnId: _resultTurn, ...s }) => ({ ...s, sourceId: s.sourceId ?? `${from}:${s.id}`, ...(s.source === 'task' && !s.id.startsWith('restored:') && { id: `restored:${s.id}` }) })))
  const questionRows = Array.isArray(saved?.ledger?.questions) ? (saved.ledger.questions as unknown[]) : []
  const questions = capRows(questionRows
    .map(savedQuestion)
    .filter(isDefined)
    .filter(q => q.cleared !== true), MAX_QUESTIONS, q => q.status === 'answered')
  return { steps, questions }
}
