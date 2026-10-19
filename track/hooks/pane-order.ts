import type { Ledger, Question, Step } from '../types'
import { visibleSteps } from './steps'

export const visibleQuestions = (questions: readonly Question[]): Question[] => questions.filter(question => question.cleared !== true)

type PaneRow = { label: string; id: string; kind: 'step' | 'question'; status: string; subject: string }
type PaneLookup = PaneRow | { label: string; shown: false }

export const lookupPaneRows = (ledger: Pick<Ledger, 'steps' | 'questions'>, references?: readonly string[]): PaneLookup[] => {
  const rows: PaneRow[] = [
    ...visibleSteps(ledger.steps).map((step, index) => ({ label: `S${index + 1}`, id: step.id, kind: 'step' as const, status: step.status, subject: step.subject })),
    ...visibleQuestions(ledger.questions).map((question, index) => ({ label: `Q${index + 1}`, id: `question:${question.id}`, kind: 'question' as const, status: question.status, subject: question.head })),
  ]
  if (references === undefined) return rows
  const byLabel = new Map(rows.map(row => [row.label, row]))
  return references.map(reference => {
    const label = reference.toUpperCase()
    return byLabel.get(label) ?? { label, shown: false as const }
  })
}

export const reorderVisibleSteps = (steps: Step[], ids: unknown): Step[] | undefined => {
  const visible = visibleSteps(steps)
  if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string') || ids.length !== visible.length || new Set(ids).size !== visible.length) return undefined
  const byId = new Map(visible.map(step => [step.id, step]))
  if (!ids.every(id => byId.has(id))) return undefined
  let index = 0
  // Keep cleared history in its existing slots. Only the current row order changes.
  return steps.map(step => step.cleared === true ? step : byId.get(ids[index++])!)
}

// TRACK-29 (2026-10-19): pane ordinals change when rows are cleared. Resolve
// only labels mentioned in this prompt, from the same rows the pane renders.
export const paneReferenceContext = (text: string, ledger: Pick<Ledger, 'steps' | 'questions'>): string | undefined => {
  const mentioned = new Set<string>()
  for (const match of text.matchAll(/\b([SQ])([1-9]\d{0,2})\b/g)) {
    mentioned.add(`${match[1]}${match[2]}`)
    if (mentioned.size === 64) break
  }
  if (mentioned.size === 0) return undefined
  const mappings = lookupPaneRows(ledger, [...mentioned]).map(row => `${row.label} = ${'id' in row ? row.id : 'not shown'}`)
  return `track: current pane references, if these tokens refer to Track: ${mappings.join('; ')}. This lookup is data, not a request to act; other meanings such as AWS S3 remain unrelated. Display numbers are not permanent tool ids. Use the mapped permanent step id with mark_step. For question:7, pass numeric id:7 to mark_answered. Do not guess a row that is not shown. Use mcp__track__lookup_rows for a fresh lookup.`
}
