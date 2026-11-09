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

// Ohad 2026-11-10: a row shows its whole text on up to three lines, with no expand control; only
// text needing a fourth line is cut. Titles over 90 characters are refused, so new rows fit two.
export const ROW_LINES = 3

// A number cell drawn as "S1  │": the padded label, a space and the rule, then the row's gap.
export const labelColumn = (labelWidth: number): number => labelWidth + 3

export const labelCell = (label: string, labelWidth: number): string => `${label.padEnd(labelWidth)} │`

export const paneRowMetrics = (input: RowInput) => {
  const { width, bodyRows, compact, rowIndent, clearWidths, hints, hasQuestions, hasSteps, allLabel, doneLabel, questions, steps, opened, resultReveals, qEmpty, sEmpty, questionLabel, clockOf } = input
  const roomy = bodyRows >= 16
  const titleRows = roomy ? 2 : 1
  const bottomRows = flowRows([...clearWidths, ...hints.map(hint => hint.text.length)], width, HEADER_GAP)
  const qButtons = hasQuestions ? [buttonWidth('q', allLabel), buttonWidth('a', doneLabel)] : []
  const sButtons = hasSteps ? clearWidths : []
  // The number column keeps room for two digits so rows stay aligned as a list grows past nine.
  const qLabelWidth = Math.max(3, ...questions.map(q => questionLabel(q.id).length))
  const sLabelWidth = Math.max(3, `S${steps.length}`.length)
  // A narrow pane draws the number on the controls line instead, so the text keeps its width.
  const qWidth = Math.max(1, width - rowIndent - 2 - (compact ? 0 : labelColumn(qLabelWidth) + QUESTION_CHROME))
  // Status owns two cells, including the paused/hourglass glyphs, then a gap, then the number column.
  const sWidth = Math.max(1, width - rowIndent - 3 - (compact ? 0 : labelColumn(sLabelWidth)))
  const qControlsRows = compact ? 1 : 0
  const qTextWidth = (_q: Question) => qWidth
  const qHeadLines = (q: Question) => Math.min(ROW_LINES, wrappedLines(q.head, qTextWidth(q)))
  const revealedText = (q: Question): string | undefined => {
    const side = opened[String(q.id)]
    if (side === 'q' && q.head.trim() !== '') return q.head
    if (side === 'a' && q.answerKey === undefined && (q.answerText?.trim().length ?? 0) > 0) return q.answerText
    return undefined
  }
  const qLines = questions.map(q => {
    const extra = revealedText(q)
    return qHeadLines(q) + qControlsRows + (extra === undefined ? 0 : wrappedLines(extra, qTextWidth(q)))
  })
  const stepControlsRows = (_s: Step) => compact ? 1 : 0
  const fullStepWidth = (s: Step) => Math.max(1, sWidth - (compact || !hasClock(s) ? 0 : clockOf(s).length + 1))
  const fullSubjectWidth = (s: Step) => Math.max(1, fullStepWidth(s) - (!compact && s.status === 'completed' ? 7 : 0))
  const stepWidth = (s: Step) => fullStepWidth(s)
  const stepSubjectWidth = (s: Step) => fullSubjectWidth(s)
  const sHeadLines = (s: Step) => Math.min(ROW_LINES, wrappedLines(s.subject, stepSubjectWidth(s)))
  const sLines = steps.map(s => sHeadLines(s) + stepControlsRows(s) +
    (resultReveals.has(s.id) ? wrappedLines(resultReveals.get(s.id)!, stepSubjectWidth(s)) : 0))
  const needQ = questions.length > 0 ? qLines.reduce((a, b) => a + b, 0) : wrappedLines(qEmpty, width)
  const needS = steps.length > 0 ? sLines.reduce((a, b) => a + b, 0) : wrappedLines(sEmpty, width)
  const atWork = steps.findIndex(s => s.status !== 'completed')
  const revealOpen = questions.some(q => revealedText(q) !== undefined)
  return { qLabelWidth, sLabelWidth, roomy, titleRows, bottomRows, qButtons, sButtons, qWidth, sWidth, qControlsRows, qLines, sLines, needQ, needS, atWork, revealOpen, stepControlsRows, stepWidth, stepSubjectWidth, qTextWidth }
}
export type PaneMetrics = ReturnType<typeof paneRowMetrics>
