import type { Activity, Step } from '../types'
import { norm } from './ledger-text'

const OWNER_CAP = 64
// The one in-progress step of the turn that started a background shell task.
export const launchOwner = (steps: Step[], currentId: string | null): string[] => {
  if (currentId === null) return []
  const candidates = steps.filter(s => s.cleared !== true && s.status === 'in_progress' && s.activeTurnId === currentId)
  return candidates.length === 1 && candidates[0] !== undefined ? [candidates[0].id] : []
}
// An Agent launch belongs to the one delegated step of this turn when there is one, even if a
// main step is also in progress. Otherwise it follows the shell rule.
export const agentLaunchOwner = (steps: Step[], currentId: string | null): string[] => {
  if (currentId === null) return []
  const inTurn = steps.filter(s => s.cleared !== true && s.status === 'in_progress' && s.activeTurnId === currentId)
  const delegated = inTurn.filter(s => s.delegated === true)
  if (delegated.length === 1 && delegated[0] !== undefined) return [delegated[0].id]
  return inTurn.length === 1 && inTurn[0] !== undefined ? [inTurn[0].id] : []
}
// A step a finished background task still flags: delegated, paused or in progress, and not
// completed, waiting or cleared. Its owner entries live exactly as long as this holds.
export const canFollowUp = (s: Step): boolean =>
  s.cleared !== true && s.status !== 'completed' && s.status !== 'waiting' && (s.delegated === true || s.status === 'paused' || s.status === 'in_progress')
export const ownersForLiveSteps = (owners: Record<string, string[]> | undefined, steps: Step[]): Record<string, string[]> => {
  const live = new Set(steps.filter(canFollowUp).map(s => s.id))
  const next: Record<string, string[]> = {}
  for (const [id, stepIds] of Object.entries(owners ?? {})) {
    const kept = stepIds.filter(stepId => live.has(stepId))
    if (kept.length > 0) next[id] = kept
  }
  return next
}
// Launch order, newest last, kept apart from the map because an object lists integer-like keys
// first. A relaunch moves its id to the end. Lost notifications cannot grow the map past the cap.
// `launchOwners` outlives the owner entry: a task whose step finished or reopened still has a
// known owner. A relaunch with an unknown owner drops the task, so it reads as unknown.
export const rememberOwner = (a: Activity, id: string, stepIds: string[], steps: Step[]): Pick<Activity, 'owners' | 'ownerOrder' | 'launchOwners'> => {
  const owners = { ...(a.owners ?? {}) }
  delete owners[id]
  if (stepIds.length > 0) owners[id] = stepIds
  const known = (a.ownerOrder ?? []).filter(k => k !== id && owners[k] !== undefined)
  const order = [...Object.keys(owners).filter(k => k !== id && !known.includes(k)), ...known, ...(stepIds.length > 0 ? [id] : [])]
  while (order.length > OWNER_CAP) {
    const oldest = order.shift()
    if (oldest !== undefined) delete owners[oldest]
  }
  const identities = steps.filter(row => stepIds.includes(row.id)).map(row => ({ id: row.id, subject: norm(row.subject) }))
  const launchOwners = [...(a.launchOwners ?? []).filter(row => row.task !== id), ...(identities.length > 0 ? [{ task: id, steps: identities }] : [])]
  while (launchOwners.length > OWNER_CAP) {
    const oldest = launchOwners.shift()
    // An evicted identity is unknown, not permission to use its legacy id map.
    if (oldest !== undefined) delete owners[oldest.task]
  }
  return { owners, ownerOrder: order.filter(task => owners[task] !== undefined), launchOwners }
}
// Phase 2 D7 (Q38, 2026-10-26): launches are numbered in order, so a Stop inventory published
// before a launch can never drop it. An id whose number was evicted has none and is never dropped.
export const rememberLaunch = (a: Activity, id: string): Pick<Activity, 'launchSeq' | 'launchNumbers'> => {
  const seq = (a.launchSeq ?? 0) + 1
  const launchNumbers = [...(a.launchNumbers ?? []).filter(row => row.task !== id), { task: id, seq }]
  while (launchNumbers.length > OWNER_CAP) launchNumbers.shift()
  return { launchSeq: seq, launchNumbers }
}
