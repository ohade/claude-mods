import type { Ledger, Step } from '../types'
import { capSteps, withoutStepResult, withStatus } from './ledger-policy'
import { openPlanSteps } from './steps'

export const planInsertion = (ledger: Ledger, after: string, count: number): { anchor?: string; ids: string[] } => {
  const plans = ledger.steps.filter(s => s.source === 'plan')
  const anchor = after === 'last' ? plans[plans.length - 1]?.id : after
  // Require the end of the ID, not just a numeric prefix.
  const top = anchor === undefined ? 0 : Math.max(0, ...ledger.steps.map(s => Number(/^plan:(\d+)(?![\s\S])/.exec(s.id)?.[1] ?? 0)))
  return { anchor, ids: Array.from({ length: count }, (_, k) => `plan:${top + k + 1}`) }
}

export const insertPlan = (ledger: Ledger, rows: Step[], anchor: string | undefined, session?: string): Ledger => {
  const i = ledger.steps.findIndex(s => s.id === anchor)
  const steps = i < 0 ? [...ledger.steps, ...rows] : [...ledger.steps.slice(0, i + 1), ...rows, ...ledger.steps.slice(i + 1)]
  return { ...ledger, session_id: ledger.session_id ?? session, steps: capSteps(steps) }
}

export const replacePlan = (ledger: Ledger, rows: Step[], replace: boolean, session?: string): { ledger: Ledger; unfinished: ReturnType<typeof openPlanSteps> } => {
  const unfinished = replace ? [] : openPlanSteps(ledger.steps)
  if (unfinished.length > 0) return { ledger, unfinished }
  return { ledger: { ...ledger, session_id: ledger.session_id ?? session, steps: capSteps([...ledger.steps.filter(s => s.source !== 'plan'), ...rows]) }, unfinished }
}

type Result = { resultText: string; resultTextHash: string; resultAt: number; resultRequestId?: string; resultTurnId?: string }

export const markStep = (ledger: Ledger, values: { id: string; status: Step['status']; now: number; currentId: string | null; note?: string; delegated?: boolean; result?: Result }): { ledger: Ledger; reusableStep?: Step } => {
  const { id, status, now, currentId, note, delegated, result } = values
  let reusableStep: Step | undefined
  const steps = ledger.steps.map(s => {
    if (s.id !== id) return s
    if (s.cleared !== true && (s.status !== 'completed' || status !== 'completed')) reusableStep = s
    const { followUp: _followUp, delegated: _delegated, ...changed } = withStatus(result === undefined ? s : withoutStepResult(s), status, now, currentId)
    return { ...changed, ...((delegated ?? s.delegated) === true && status !== 'completed' && status !== 'waiting' && { delegated: true as const }), ...(note !== undefined && { note }), ...result }
  })
  return { ledger: { ...ledger, steps }, reusableStep }
}
