import type { Ledger } from '../types'

// Called with the current ledger on every native compare-and-set attempt.
export const planStepClear = (ledger: Ledger, armed: boolean): { ledger: Ledger; arming: boolean } => {
  const removed = ledger.steps.filter(s => s.status !== 'completed').map(s => ({ id: s.id, head: s.subject }))
  const arming = removed.length > 0 && !armed
  return {
    ledger: arming ? ledger : { ...ledger, steps: [], ...(removed.length > 0 && { clearedSteps: [...(ledger.clearedSteps ?? []), ...removed] }) },
    arming,
  }
}

export const hideCompletedSteps = (ledger: Ledger): Ledger => ({
  ...ledger, steps: ledger.steps.map(s => (s.status === 'completed' ? { ...s, cleared: true as const } : s)),
})
