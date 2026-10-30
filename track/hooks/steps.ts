import type { Step } from '../types'

// CC-181, 2026-10-10: reminder/restore totals counted cleared history, while
// the pane and checkpoint counted only these current rows. Keep one predicate.
export const visibleSteps = (steps: Step[]): Step[] => steps.filter(s => s.cleared !== true)

// Model-facing data only: real tool ids, all open statuses, and the saved owner/blocker note.
export const openStepsOf = (steps: Step[]): Array<Pick<Step, 'id' | 'status' | 'subject' | 'note'>> =>
  visibleSteps(steps).filter(s => s.status !== 'completed')
    .map(({ id, status, subject, note }) => ({ id, status, subject, ...(note !== undefined && { note }) }))

export const openPlanSteps = (steps: Step[]): ReturnType<typeof openStepsOf> => openStepsOf(steps.filter(s => s.source === 'plan'))

export const sameResultOwner = (current: Step, saved: Step): boolean =>
  current.id === saved.id && current.source === saved.source && current.sourceId === saved.sourceId &&
  current.subject === saved.subject && current.taskId === saved.taskId
