import type { Baseline, Ledger } from '../types'
import type { Checkpoint } from './checkpoint'

// TRACK-21 (2026-10-11): reload adopted a durable revision while retaining
// unrelated nonempty memory, making a later save silently overwrite newer rows.
export type { Baseline } from '../types'
export type SessionHead = { v: 1; session_id: string; generation: string; checkpoint: Checkpoint; closedAt?: number }
const canonical = (value: unknown): string | undefined => JSON.stringify(value, (_, entry) =>
  entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))) : entry)
const equal = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right)

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
    if (equal(saved, current)) chosen = saved
    else if (base !== undefined && equal(current, old)) chosen = saved
    else if (base !== undefined && equal(saved, old)) chosen = current
    else if (!original.has(key) && !left.has(key)) chosen = current
    else if (!original.has(key) && !right.has(key)) chosen = saved
    else throw new Error(`reconcile conflict: ${key}; both versions were kept`)
    if (chosen !== undefined) merged.push(chosen)
  }
  return merged
}

export const reconcileLedger = (base: Ledger | undefined, durable: Ledger, local: Ledger, session: string): Ledger => {
  const saved = identifyLedger(durable, session)
  const current = identifyLedger(local, session)
  const original = base === undefined ? undefined : identifyLedger(base, session)
  const questions = mergeRows(original?.questions, saved.questions, current.questions, row => row.sourceId ?? `${session}:Q${row.id}`)
  const steps = mergeRows(original?.steps, saved.steps, current.steps, row => row.sourceId ?? `${session}:${row.id}`)
  // Different logical generations may reuse a local plan id. Tool calls and
  // pane keys require that local id to stay unique after a merge too.
  if (new Set(steps.map(row => row.id)).size !== steps.length) throw new Error('reconcile conflict: duplicate step id; both versions were kept')
  const prompts = mergeRows(original?.prompts, saved.prompts, current.prompts, row => row.rowKey)
  const restores = mergeRows(original?.restores, saved.restores ?? [], current.restores ?? [], row => row.by)
  const withdrawn = mergeRows(original?.withdrawn, saved.withdrawn ?? [], current.withdrawn ?? [], row => String(row.id))
  const restoredIds = { ...saved.restoredIds, ...current.restoredIds }
  for (const [key, id] of Object.entries(saved.restoredIds ?? {})) {
    if (current.restoredIds?.[key] !== undefined && current.restoredIds[key] !== id) throw new Error(`reconcile conflict: restored identity ${key}`)
  }
  // Stable source identity is distinct from the local display number.
  const used = new Set<number>()
  let next = Math.max(saved.nextQuestionId, current.nextQuestionId, ...questions.map(row => row.id + 1))
  for (const row of questions) {
    if (used.has(row.id)) row.id = next++
    used.add(row.id)
  }
  return {
    ...saved, ...current, questions, steps, prompts,
    nextQuestionId: Math.max(next, ...withdrawn.map(row => row.id + 1)),
    ...(saved.restores !== undefined || current.restores !== undefined ? { restores } : {}),
    ...(saved.withdrawn !== undefined || current.withdrawn !== undefined ? { withdrawn } : {}),
    ...(Object.keys(restoredIds).length && { restoredIds }),
    ...(saved.compactedAt !== undefined || current.compactedAt !== undefined
      ? { compactedAt: Math.max(saved.compactedAt ?? 0, current.compactedAt ?? 0) } : {}),
  }
}
