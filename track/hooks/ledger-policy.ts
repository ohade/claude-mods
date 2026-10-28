import type { Ledger, Step } from '../types'

export const MAX_STEPS = 300
// Reasons the pane shows only while a step stays paused. Leaving paused drops them.
const LIFECYCLE_NOTES = new Set(['cancelled by you', 'refused', 'interrupted'])

export const isLifecycleNote = (note: string): boolean => LIFECYCLE_NOTES.has(note)

// The newest `max` rows. Room is made from the oldest rows already cleared, then the oldest done
// ones. Unfinished work is never removed to make room.
export const capRows = <T extends { cleared?: true }>(rows: T[], max: number, isDone: (row: T) => boolean): T[] => {
  let excess = rows.length - max
  if (excess <= 0) return rows
  const dropped = new Set<T>()
  for (const isSpent of [(row: T) => row.cleared === true, isDone]) {
    for (const row of rows) {
      if (excess > 0 && !dropped.has(row) && isSpent(row)) {
        dropped.add(row)
        excess--
      }
    }
  }
  return rows.filter(row => !dropped.has(row))
}

export const capSteps = (steps: Step[]): Step[] => capRows(steps, MAX_STEPS, s => s.status === 'completed')

export const withoutStepResult = (step: Step): Step => {
  const { resultText: _text, resultTextHash: _hash, resultRequestId: _request, resultAt: _at, resultTurnId: _turn, ...rest } = step
  return rest
}

// A step at a new status. Its clock starts the first time it goes in progress and stops when it
// is done; a done step that is opened again runs on from its first start. Any status write drops
// a finished-work flag. A cancel, refusal, or interruption note stays only while the step is paused.
export const withStatus = (s: Step, status: Step['status'], now: number, turnId?: string | null): Step => {
  const { endedAt: _ended, delegated, activeTurnId: _turn, followUp: _follow, note, ...rest } = status === 'completed' ? s : withoutStepResult(s)
  const startedAt = s.startedAt ?? (status === 'in_progress' ? now : undefined)
  const endedAt = status !== 'completed' || startedAt === undefined ? undefined : s.status === 'completed' && s.endedAt !== undefined ? s.endedAt : now
  const keepNote = !(s.status === 'paused' && status !== 'paused' && note !== undefined && isLifecycleNote(note))

  return { ...rest, ...(keepNote && note !== undefined && { note }), status, ...(status === 'in_progress' && typeof turnId === 'string' && { activeTurnId: turnId }), ...(delegated === true && status !== 'completed' && status !== 'waiting' && { delegated: true as const }), ...(startedAt !== undefined && { startedAt }), ...(endedAt !== undefined && { endedAt }) }
}

// A retained start time is not current activity (pending-step clock defect, 2026-10-08).
// Parked work has no clock; completed work needs a known end to show a fixed duration.
export const hasClock = (s: Step): boolean => s.startedAt !== undefined && (
  s.status === 'in_progress' && s.endedAt === undefined ||
  s.status === 'completed' && s.endedAt !== undefined
)

export const runningClocks = (l: Ledger): Step[] => l.steps.filter(s => s.cleared !== true && s.status === 'in_progress' && hasClock(s))
