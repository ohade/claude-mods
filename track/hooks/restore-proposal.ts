import type { Ledger, Question, Step } from '../types'
import { MAX_QUESTIONS, capRows, keepRestores } from './ledger-policy'
import { legacySourceId, questionHighWater, reconcileQuestionIdentity } from './reconcile'
import { asRestored } from './restore-records'

type RestoreOptions = {
  from: string
  steps: Step[]
  questions: Question[]
  replace: boolean
  beforeOwner: string | null | undefined
  destination: string | undefined
  mechanical: boolean
  toolUseId: string | undefined
  hasCheckpoint: boolean
  visibleStepCount: number
}

const wasRestored = (cur: Ledger, from: string, steps: Step[]) => (cur.restores ?? []).some(r => r.from === from) || cur.questions.some(q => q.restoredFrom === from) || (steps.length > 0 && steps.every(s => cur.steps.some(local => local.sourceId === s.sourceId)))
const refusalOf = (cur: Ledger, from: string, steps: Step[], replace: boolean): string | undefined =>
  replace
    ? undefined
    : steps.length > 0 && cur.steps.length > 0 && !wasRestored(cur, from, steps)
      ? `track: this session already has ${cur.steps.length} steps; nothing changed. Pass replace: true to replace them.`
      : undefined

export const proposeRestore = (cur: Ledger, options: RestoreOptions): { next: Ledger; refusal: string | undefined; restored: Question[] } => {
  const { from, steps, questions, replace, beforeOwner, destination, mechanical, toolUseId, hasCheckpoint, visibleStepCount } = options
  const original = cur
  // An explicit restore may adopt a truly empty ledger left by a session
  // transition. Foreign rows or archives remain a refusal, never relabeled.
  if ((cur.session_id ?? beforeOwner) !== undefined && (cur.session_id ?? beforeOwner) !== destination) {
    if (cur.prompts.length || cur.questions.length || cur.steps.length ||
        cur.withdrawn?.length || cur.restores?.length || Object.keys(cur.restoredIds ?? {}).length) {
      return { next: original, refusal: 'track: destination ledger belongs to another session; original rows were kept.', restored: [] }
    }
    cur = { ...cur, session_id: destination }
  }
  const refusal = refusalOf(cur, from, steps, replace)
  if (refusal !== undefined) {
    return { next: original, refusal, restored: [] }
  }
  const identity = reconcileQuestionIdentity(cur.questions, cur.restoredIds, cur.restores)
  let nextId = questionHighWater(cur)
  const occupied = new Set([...cur.questions.map(q => q.id), ...(cur.withdrawn ?? []).map(q => q.id)])
  const ids = new Map(Object.entries(identity.restoredIds ?? {}))
  for (const r of identity.restores ?? []) for (const q of r.questions) {
    const sourceId = legacySourceId(r.from, q)
    if (!ids.has(sourceId)) ids.set(sourceId, q.id)
  }
  const restored = questions.map(q => {
    const sourceId = legacySourceId(from, q)
    const local = cur.questions.find(one => one.sourceId === sourceId && one.cleared !== true)
      ?? cur.questions.find(one => one.sourceId === sourceId)
    const cached = ids.get(sourceId)
    // Unresolved legacy-only limit: a stale hint below nextQuestionId can name
    // an already withdrawn question's number after its transient record clears.
    const id = local?.id ?? (cached !== undefined && Number.isSafeInteger(cached) && cached > 0 && !occupied.has(cached) ? cached : nextId++)
    occupied.add(id)
    nextId = Math.max(nextId, id + 1)
    ids.set(sourceId, id)
    return !replace && local !== undefined ? local : asRestored(q, id, from, mechanical ? undefined : toolUseId)
  })
  const sources = new Set(restored.map(q => q.sourceId))
  const kept = cur.questions.filter(q => q.sourceId === undefined || !sources.has(q.sourceId))
  // A validated checkpoint must retain every source value. Only local spent
  // rows may make room; otherwise refuse before changing the ledger.
  const combined = !hasCheckpoint
    ? capRows([...kept, ...restored], MAX_QUESTIONS, q => q.status === 'answered')
    : [...capRows(kept, MAX_QUESTIONS - restored.length, q => q.status === 'answered'), ...restored]
  if (combined.length > MAX_QUESTIONS) {
    return { next: original, refusal: 'track: question capacity reached; unfinished work was kept.', restored: [] }
  }
  const by = toolUseId
  const restores = by !== undefined && !(mechanical && wasRestored(cur, from, steps))
    ? keepRestores([...(identity.restores ?? []), { by, from, steps: steps.length, visibleSteps: visibleStepCount, questions: restored }], combined)
    : identity.restores

  return {
    next: {
      ...cur,
      ...(destination !== undefined && { session_id: destination }),
      steps: steps.length > 0 && (replace || cur.steps.length === 0) ? steps : cur.steps,
      questions: combined,
      nextQuestionId: nextId,
      ...reconcileQuestionIdentity(combined, Object.fromEntries(ids), restores),
    },
    refusal: undefined,
    restored,
  }
}
