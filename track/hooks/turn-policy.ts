import type { Activity, FreshnessCandidate, Ledger, PendingInput, Step, Turn } from '../types'
import { distinctIds } from './ledger-policy'
import { norm } from './ledger-text'
import { visibleSteps } from './steps'

const QUESTION_FIRST = /^(why|how|what|who|whom|whose|when|where|which|is|are|was|were|can|could|do|does|did|should|would|will|u)$/i

// A main prompt the gate may judge, trimmed, or absent for a slash command, a doorbell, terminal
// input, a notification or a peer's message. A subagent hand-back comes in under the peer origin
// and is model output, not the person's question; recordPrompt skips it for the same reason.
export const gateable = (text: string, originKind: string | undefined): string | undefined => {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.startsWith('/') || trimmed.startsWith(': AMQ doorbell')) return undefined
  if (trimmed.startsWith('<bash-') || trimmed.startsWith('<local-command') || trimmed.startsWith('<task-notification')) return undefined
  if (originKind === 'task-notification' || originKind === 'peer') return undefined
  return trimmed
}
// The CC-154 wording check: a question mark, or a question word first. It misses Hebrew and
// "explain X", and takes "can you send it?" for a question.
export const looksLikeQuestion = (trimmed: string): boolean =>
  trimmed.includes('?') || QUESTION_FIRST.test(trimmed.split(/\s+/)[0] ?? '')

// Whether an input needs a question row: Haiku's label when it gave one, else the wording check.
export const needsQuestion = (i: PendingInput): boolean =>
  i.label === 'question' || (i.label !== 'not_question' && i.wording !== false)

// The inputs of the turn: bound to it, or not yet bound to any turn.
export const ofTurn = (inputs: PendingInput[], currentId: string): PendingInput[] =>
  inputs.filter(i => i.turnId === currentId || i.turnId === null)

// TRACK-27 refuter 6: a reused id can name different work. Launch identity is
// authoritative when present; only tasks without a launch row use the legacy id map.
export const ownerTasksForStep = (a: Activity, step: Step): string[] => {
  const launches = new Map((a.launchOwners ?? []).map(row => [row.task, row.steps] as const))
  const subject = norm(step.subject)
  return [...new Set([...Object.keys(a.owners ?? {}), ...launches.keys()])].filter(task => {
    const identities = launches.get(task)
    return identities === undefined ? a.owners?.[task]?.includes(step.id) === true
      : identities.some(row => row.id === step.id && row.subject === subject)
  })
}

// Full stored responses, not the capped pane preview, supply waiting requests.
// TRACK-44: with `visible` (the rows the pane shows), a request may also name the step by its
// title or a unique prefix of it; permanent ids keep working, and the two-argument call is unchanged.
export const waitingArrowIds = (text: string, stepIds: ReadonlySet<string>, visible?: ReadonlyArray<Pick<Step, 'id' | 'subject'>>): string[] => {
  const ids: string[] = []
  let fence: { char: string; size: number } | undefined
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence !== undefined) {
      if (boundary?.[1]?.[0] === fence.char && boundary[1].length >= fence.size && boundary[2]?.trim() === '') fence = undefined
    } else if (boundary !== null && !(boundary[1]![0] === '`' && boundary[2]!.includes('`'))) {
      fence = { char: boundary[1]![0]!, size: boundary[1]!.length }
    } else {
      // The id runs to the first ": ", so `todo:ship it` and `restored:task:7` both parse;
      // only an id that names a visible step counts.
      const arrow = /^ {0,3}👉[ \t]+(\S.*?):[ \t]+(\S.*)$/.exec(line)
      if (arrow !== null && stepIds.has(arrow[1]!)) ids.push(arrow[1]!)
      else if (arrow !== null && visible !== undefined) {
        const id = titledPointer(line.replace(/^ {0,3}👉[ \t]+/, ''), visible)
        if (id !== undefined) ids.push(id)
      }
    }
  }
  return distinctIds(ids)
}

// TRACK-44: the step a "<title>: <request>" pointer names. Each ": " stays a boundary, so a request colon
// cannot join a title. Exact beats prefix; the longest pointer that matches decides, and two rows name none.
const key = (text: string): string => text.split(/:[ \t]+/).map(norm).join(':')
const titledPointer = (rest: string, visible: ReadonlyArray<Pick<Step, 'id' | 'subject'>>): string | undefined => {
  const titles = visible.map(step => ({ id: step.id, title: key(step.subject) }))
  const pointers = [...rest.matchAll(/:[ \t]+(?=\S)/g)].map(split => key(rest.slice(0, split.index))).filter(pointer => pointer !== '').reverse()
  const decide = (match: (title: string, pointer: string) => boolean): string | null | undefined => {
    const hits = pointers.map(pointer => titles.filter(row => match(row.title, pointer))).find(rows => rows.length > 0)
    return hits === undefined ? undefined : hits.length === 1 ? hits[0]!.id : null
  }
  const exact = decide((title, pointer) => title === pointer)
  return (exact === undefined ? decide((title, pointer) => title.startsWith(pointer)) : exact) ?? undefined
}

export const freshnessCandidates = (t: Turn, l: Ledger, a: Activity, withSubjects = true): FreshnessCandidate[] => {
  const fresh = t.freshness?.turnId === t.currentId ? t.freshness : undefined
  const visible = visibleSteps(l.steps)
  const completed: FreshnessCandidate[] = (fresh?.completed ?? []).filter(row => visible.some(step => step.id === row.id && step.status === 'completed') && (row.owner_task_ids === undefined || row.owner_task_ids.length > 0))
    .map(row => ({ kind: 'premature_completion', ...row }))
  const stale: FreshnessCandidate[] = typeof t.currentId !== 'string' ? [] : visible.filter(step => step.status === 'in_progress' && step.activeTurnId === t.currentId && step.delegated !== true)
    .map(step => ({ kind: 'stale_in_progress', id: step.id, owner_task_ids: ownerTasksForStep(a, step) }))
  // Follow-up can mark one finished owner while another still runs; the gate checks liveness.
  const finished: FreshnessCandidate[] = visible.filter(step => step.status === 'in_progress' && step.delegated === true && step.followUp === true)
    .map(step => ({ kind: 'finished_delegation', id: step.id, owner_task_ids: ownerTasksForStep(a, step), ...(typeof step.external_owner === 'boolean' && { external_owner: step.external_owner }) }))
  const waiting: FreshnessCandidate[] = visible.filter(step => step.status === 'waiting' && fresh?.waiting.includes(step.id) && !fresh.response?.arrow_ids.includes(step.id))
    .map(step => ({ kind: 'missing_waiting_request', id: step.id, ...(withSubjects && { subject: step.subject }) }))
  // Held kinds stay listed; `held` travels beside them and both Stop paths skip it.
  return [...completed, ...stale, ...finished, ...waiting, ...(fresh !== undefined && fresh.edits.length > 0 && fresh.steps.length === 0 ? [{ kind: 'untracked_edit' as const }] : [])]
}
