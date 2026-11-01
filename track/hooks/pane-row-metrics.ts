// Row geometry consumes render snapshots; clock formatting stays native.
import type { Question, Step } from '../types'
import { hasClock } from './ledger-policy'
import { buttonWidth, flowRows, HEADER_GAP, QUESTION_CHROME } from './pane-layout'
import { wrappedLines } from './terminal-text'

type RowInput = {
  width: number; bodyRows: number; compact: boolean; rowIndent: number
  clearWidths: number[]; hints: readonly { text: string }[]; hasQuestions: boolean; hasSteps: boolean
  allLabel: string; doneLabel: string; questions: Question[]; steps: Step[]
  opened: Readonly<Record<string, 'q' | 'a' | 'r' | undefined>>; resultReveals: ReadonlyMap<string, string>
  qEmpty: string; sEmpty: string; questionLabel: (id: number | string) => string; clockOf: (s: Step) => string
}

export const paneRowMetrics = (input: RowInput) => {
  const { width, bodyRows, compact, rowIndent, clearWidths, hints, hasQuestions, hasSteps, allLabel, doneLabel, questions, steps, opened, resultReveals, qEmpty, sEmpty, questionLabel, clockOf } = input
  const roomy = bodyRows >= 16
  const titleRows = roomy ? 2 : 1
  const bottomRows = flowRows([...clearWidths, ...hints.map(hint => hint.text.length)], width, HEADER_GAP)
  const qButtons = hasQuestions ? [buttonWidth('q', allLabel), buttonWidth('a', doneLabel)] : []
  const sButtons = hasSteps ? clearWidths : []
  const qWidth = Math.max(1, width - rowIndent - 2 - (compact ? 0 : QUESTION_CHROME))
  // Status owns two cells, including the paused/hourglass glyphs, then a gap.
  const sWidth = Math.max(1, width - rowIndent - 3)
  const qControlsRows = compact ? 1 : 0
  const revealedText = (q: Question): string | undefined => {
    const side = opened[String(q.id)]
    if (side === 'q' && q.head.trim() !== '') return q.head
    if (side === 'a' && q.answerKey === undefined && (q.answerText?.trim().length ?? 0) > 0) return q.answerText
    return undefined
  }
  const qLines = questions.map(q => {
    const extra = revealedText(q)
    return wrappedLines(`${questionLabel(q.id)}. ${q.head}`, qWidth) + qControlsRows + (extra === undefined ? 0 : wrappedLines(extra, qWidth))
  })
  const stepControlsRows = (s: Step) => compact && (hasClock(s) || s.status === 'completed') ? 1 : 0
  const stepWidth = (s: Step) => Math.max(1, sWidth - (compact || !hasClock(s) ? 0 : clockOf(s).length + 1))
  const stepSubjectWidth = (s: Step) => Math.max(1, stepWidth(s) - (!compact && s.status === 'completed' ? 7 : 0))
  const sLines = steps.map((s, i) => wrappedLines(`S${i + 1}. ${s.subject}`, stepSubjectWidth(s)) + stepControlsRows(s) +
    (resultReveals.has(s.id) ? wrappedLines(resultReveals.get(s.id)!, stepWidth(s)) : 0))
  const needQ = questions.length > 0 ? qLines.reduce((a, b) => a + b, 0) : wrappedLines(qEmpty, width)
  const needS = steps.length > 0 ? sLines.reduce((a, b) => a + b, 0) : wrappedLines(sEmpty, width)
  const atWork = steps.findIndex(s => s.status !== 'completed')
  const revealOpen = questions.some(q => revealedText(q) !== undefined)
  return { roomy, titleRows, bottomRows, qButtons, sButtons, qWidth, sWidth, qControlsRows, qLines, sLines, needQ, needS, atWork, revealOpen, stepControlsRows, stepWidth, stepSubjectWidth }
}
export type PaneMetrics = ReturnType<typeof paneRowMetrics>
