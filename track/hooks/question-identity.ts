import type { Ledger } from '../types'

export const questionHighWater = (ledger: Pick<Ledger, 'nextQuestionId' | 'questions' | 'withdrawn'>): number =>
  Math.max(ledger.nextQuestionId, ...ledger.questions.map(row => row.id + 1), ...(ledger.withdrawn ?? []).map(row => row.id + 1))

export const legacySourceId = (from: string, row: Pick<Ledger['questions'][number], 'id' | 'sourceId'>): string =>
  row.sourceId ?? `${from}:Q${row.id}`

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
        const sourceId = legacySourceId(restore.from, row)
        const id = visible.get(sourceId)
        return id === undefined || id === row.id ? row : { ...row, id, sourceId }
      }),
    })) }),
  }
}
