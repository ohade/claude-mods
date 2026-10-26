import type { Baseline, Ledger } from '../types'
import type { Checkpoint } from './checkpoint'

// TRACK-21 (2026-10-11): reload adopted a durable revision while retaining
// unrelated nonempty memory, making a later save silently overwrite newer rows.
export type { Baseline } from '../types'
export type SessionHead = { v: 1; session_id: string; generation: string; checkpoint: Checkpoint; closedAt?: number }
// TRACK-35 (2026-10-23): reload key order duplicated an unchanged ledger blob.
// Compare complete JSON content; code-unit order keeps distinct Unicode keys distinct.
const canonical = (value: unknown): string | undefined => JSON.stringify(value, (_, entry) =>
  entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : entry)
export const sameLedgerContent = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right)

export const assertLedgerOwner = (value: unknown, session: string): void => {
  const record = value as Record<string, unknown> | undefined
  const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : []
  const restores = rows(record?.restores)
  const owned = [value, ...rows(record?.prompts), ...rows(record?.questions), ...rows(record?.steps),
    ...rows(record?.withdrawn), ...restores,
    ...restores.flatMap(row => rows((row as Record<string, unknown> | null)?.questions))]
  if (owned.some(row => row !== null && typeof row === 'object' &&
      (row as Record<string, unknown>).session_id !== undefined && (row as Record<string, unknown>).session_id !== session)) throw new Error('ledger identity is ambiguous; original rows were kept')
}

export const identifyLedger = (value: Ledger, session: string): Ledger => {
  assertLedgerOwner(value, session)
  return {
  ...value,
  session_id: session,
  prompts: value.prompts.map(row => ({ ...row, session_id: session })),
  questions: value.questions.map(row => ({ ...row, session_id: session })),
  steps: value.steps.map(row => ({ ...row, session_id: session })),
  ...(value.withdrawn && { withdrawn: value.withdrawn.map(row => ({ ...row, session_id: session })) }),
  ...(value.restores && { restores: value.restores.map(row => ({ ...row, session_id: session,
    questions: row.questions.map(question => ({ ...question, session_id: session })) })) }),
  }
}

const mergeRows = <T>(base: T[] | undefined, durable: T[], local: T[], identity: (row: T) => string): T[] => {
  const original = new Map((base ?? []).map(row => [identity(row), row]))
  const left = new Map(durable.map(row => [identity(row), row]))
  const right = new Map(local.map(row => [identity(row), row]))
  if (left.size !== durable.length || right.size !== local.length) throw new Error('reconcile conflict: duplicate row identity')
  const merged: T[] = []
  for (const key of new Set([...left.keys(), ...right.keys(), ...original.keys()])) {
    const old = original.get(key), saved = left.get(key), current = right.get(key)
    let chosen: T | undefined
    if (sameLedgerContent(saved, current)) chosen = saved
    else if (base !== undefined && sameLedgerContent(current, old)) chosen = saved
    else if (base !== undefined && sameLedgerContent(saved, old)) chosen = current
    else if (!original.has(key) && !left.has(key)) chosen = current
    else if (!original.has(key) && !right.has(key)) chosen = saved
    else throw new Error(`reconcile conflict: ${key}; both versions were kept`)
    if (chosen !== undefined) merged.push(chosen)
  }
  return merged
}

// TRACK-29 (2026-10-19): a save finishing during a reorder discarded the
// local array order because mergeRows only compares individual row values.
// Treat a permutation as a three-way change, independently of row contents.
const mergeStepOrder = (base: Ledger['steps'] | undefined, durable: Ledger['steps'], local: Ledger['steps'], merged: Ledger['steps'], identity: (row: Ledger['steps'][number]) => string): Ledger['steps'] => {
  if (base === undefined) return merged
  const original = base.map(identity), saved = durable.map(identity), current = local.map(identity)
  const members = new Set(original)
  // Additions/deletions retain normal row-merge behavior. A reorder caller
  // verifies its exact visible permutation and refuses changed membership.
  if (saved.length !== original.length || current.length !== original.length || saved.some(id => !members.has(id)) || current.some(id => !members.has(id)) || sameLedgerContent(current, original)) return merged
  if (!sameLedgerContent(saved, original) && !sameLedgerContent(saved, current)) throw new Error('reconcile conflict: step order; both versions were kept')
  const byId = new Map(merged.map(row => [identity(row), row]))
  return current.map(id => byId.get(id)!)
}

// Phase 2 (2026-10-26): a stale source cache replaced an unrelated question.
// Visible rows own their display numbers; historical cache entries are only hints.
export const reconcileQuestionIdentity = (questions: Ledger['questions'], hints: Ledger['restoredIds'], restores: Ledger['restores']): Pick<Ledger, 'restoredIds' | 'restores'> => {
  const ids = new Map(Object.entries(hints ?? {}))
  const visible = new Map<string, number>()
  const used = new Set<number>()
  for (const row of questions.filter(question => question.cleared !== true)) {
    if (used.has(row.id) || row.sourceId !== undefined && visible.has(row.sourceId)) throw new Error('question identity is ambiguous; original rows were kept')
    used.add(row.id)
    if (row.sourceId !== undefined) {
      visible.set(row.sourceId, row.id)
      ids.set(row.sourceId, row.id)
    }
  }
  return {
    ...(ids.size > 0 && { restoredIds: Object.fromEntries(ids) }),
    ...(restores !== undefined && { restores: restores.map(restore => ({ ...restore,
      questions: restore.questions.map(row => {
        const sourceId = row.sourceId ?? `${restore.from}:Q${row.id}`
        const id = visible.get(sourceId)
        return id === undefined || id === row.id ? row : { ...row, id, sourceId }
      }),
    })) }),
  }
}

export const reconcileLedger = (base: Ledger | undefined, durable: Ledger, local: Ledger, session: string): Ledger => {
  const saved = identifyLedger(durable, session)
  const current = identifyLedger(local, session)
  const original = base === undefined ? undefined : identifyLedger(base, session)
  const questions = mergeRows(original?.questions, saved.questions, current.questions, row => row.sourceId ?? `${session}:Q${row.id}`)
  const stepIdentity = (row: Ledger['steps'][number]) => row.sourceId ?? `${session}:${row.id}`
  const steps = mergeStepOrder(original?.steps, saved.steps, current.steps, mergeRows(original?.steps, saved.steps, current.steps, stepIdentity), stepIdentity)
  // Different logical generations may reuse a local plan id. Tool calls and
  // pane keys require that local id to stay unique after a merge too.
  if (new Set(steps.map(row => row.id)).size !== steps.length) throw new Error('reconcile conflict: duplicate step id; both versions were kept')
  const prompts = mergeRows(original?.prompts, saved.prompts, current.prompts, row => row.rowKey)
  const restores = mergeRows(original?.restores, saved.restores ?? [], current.restores ?? [], row => row.by)
  const withdrawn = mergeRows(original?.withdrawn, saved.withdrawn ?? [], current.withdrawn ?? [], row => String(row.id))
  // Stable source identity is distinct from the local display number.
  const used = new Set(withdrawn.map(row => row.id))
  let next = Math.max(saved.nextQuestionId, current.nextQuestionId, ...questions.map(row => row.id + 1), ...withdrawn.map(row => row.id + 1))
  for (const row of questions) {
    if (used.has(row.id)) row.id = next++
    used.add(row.id)
  }
  return {
    ...saved, ...current, questions, steps, prompts,
    nextQuestionId: next,
    ...reconcileQuestionIdentity(questions, { ...saved.restoredIds, ...current.restoredIds },
      saved.restores !== undefined || current.restores !== undefined ? restores : undefined),
    ...(saved.withdrawn !== undefined || current.withdrawn !== undefined ? { withdrawn } : {}),
    ...(saved.compactedAt !== undefined || current.compactedAt !== undefined
      ? { compactedAt: Math.max(saved.compactedAt ?? 0, current.compactedAt ?? 0) } : {}),
  }
}
