// FIXTURE: reference geometry and candidate parity. Written from 513ef7b's calculations; on
// 2026-11-09 (Ohad chose re-pointing with Codex review) it takes the number column, the narrow
// pane's number on the controls line, and rows folded to one line unless unfolded.
import assert from 'node:assert/strict'
import type { Question, ScrollAt, Step } from '../../types'
import type { BannerRow } from '../../hooks/banner-layout'
import { paneBanner } from '../../hooks/pane-banner-model'
import { clockText, questionLabels } from '../../hooks/pane-layout'

export type ViewportCaseInput = {
  width: number; bodyRows: number; compact: boolean; rowIndent: number
  clearWidths: number[]; hints: readonly { text: string }[]; hasQuestions: boolean; hasSteps: boolean
  allLabel: string; doneLabel: string; questions: Question[]; steps: Step[]
  opened: Readonly<Record<string, 'q' | 'a' | undefined>>; resultReveals: ReadonlyMap<string, string>
  expanded: Readonly<Record<string, true | undefined>>
  qEmpty: string; sEmpty: string; questionLabel: (id: number | string) => string; clockOf: (s: Step) => string
  qRing: string; sRing: string; at: ScrollAt; openRows: BannerRow[]
}
type MetricProjection = { qLabelWidth: number; sLabelWidth: number; qToggle: (q: Question) => boolean; qTextWidth: (q: Question) => number; qOpen: (q: Question) => boolean; stepToggle: (s: Step) => boolean; stepOpen: (s: Step) => boolean; roomy: boolean; titleRows: number; bottomRows: number; qButtons: number[]; sButtons: number[]; qWidth: number; sWidth: number; qControlsRows: number; qLines: number[]; sLines: number[]; needQ: number; needS: number; atWork: number; revealOpen: boolean; stepControlsRows: (s: Step) => number; stepWidth: (s: Step) => number; stepSubjectWidth: (s: Step) => number }
type ViewProjection = { bannerRows: BannerRow[]; qHead: number; sHead: number; qRows: number; sRows: number; qLast: number; sLast: number; qStart: number; qEnd: number; sStart: number; sEnd: number; qHidden: string; sHidden: string }
export const project = (metrics: MetricProjection, viewport: ViewProjection, steps: Step[], questions: Question[]) => {
  const { stepControlsRows, stepWidth, stepSubjectWidth, stepToggle, stepOpen, qToggle, qTextWidth, qOpen, ...values } = metrics
  return {
    metrics: values,
    stepGeometry: steps.map(s => [stepControlsRows(s), stepWidth(s), stepSubjectWidth(s), stepToggle(s), stepOpen(s)]),
    questionGeometry: questions.map(q => [qToggle(q), qTextWidth(q), qOpen(q)]),
    viewport,
  }
}
type Reader = (input: ViewportCaseInput) => ReturnType<typeof project>

import { flowRows, buttonWidth, lastStart, windowOf } from '../../hooks/pane-layout'
import { wrappedLines } from '../../hooks/terminal-text'
import { hasClock } from '../../hooks/ledger-policy'
import { collapseLine } from '../../hooks/banner-layout'

// The pane's layout: the title pinned at the top, the banner and footer pinned at the bottom,
// and between them Questions and Steps, each a fixed region that scrolls alone. Questions get
// about a third of the room; room one side does not need goes to the other. `regions` is where the last drawing put each region, for routing a wheel tick.
const QUESTION_SHARE = 0.35
// Columns a question row spends on its dot, its [ Q ] [ A ] buttons and ✕.
const QUESTION_CHROME = 18
// Columns between the items of a header or bar; a narrow pane wraps between items, never inside one.
const HEADER_GAP = 2
// A wide row's number cell: the label padded to at least three columns, a space, the rule, a gap.
const NUMBER_EXTRA = 3
const MIN_LABEL = 3
// The fold control and its gap, after the text of a row that needs more than one line.
const FOLD = 2

const hidden = (above: number, below: number): string =>
  [above > 0 ? `↑${above}` : '', below > 0 ? `↓${below}` : ''].filter(Boolean).join(' ')
export const referenceViewport = (input: ViewportCaseInput) => {
  const { width, bodyRows, compact, rowIndent, clearWidths, hints, hasQuestions, hasSteps, allLabel, doneLabel, questions, steps, opened, resultReveals, expanded, qEmpty, sEmpty, questionLabel, clockOf, qRing, sRing, at, openRows } = input
  const l = { questions: hasQuestions ? [true] : [], steps: hasSteps ? [true] : [] }
  let bannerRows = openRows
  const roomy = bodyRows >= 16
  const titleRows = roomy ? 2 : 1
  const bottomRows = flowRows([...clearWidths, ...hints.map(hint => hint.text.length)], width, HEADER_GAP)
  const qButtons = l.questions.length > 0 ? [buttonWidth('q', allLabel), buttonWidth('a', doneLabel)] : []
  const sButtons = l.steps.length > 0 ? clearWidths : []
  const qLabelWidth = Math.max(MIN_LABEL, ...questions.map(q => questionLabel(q.id).length))
  const sLabelWidth = Math.max(MIN_LABEL, `S${steps.length}`.length)
  // A narrow pane draws the number and the fold control on the controls line instead.
  const qWidth = Math.max(1, width - rowIndent - 2 - (compact ? 0 : qLabelWidth + NUMBER_EXTRA + QUESTION_CHROME))
  // Status owns two cells, including the paused/hourglass glyphs, then a gap, then the number.
  const sWidth = Math.max(1, width - rowIndent - 3 - (compact ? 0 : sLabelWidth + NUMBER_EXTRA))
  const qControlsRows = compact ? 1 : 0
  // Ohad 2026-11-09: a folded row may take two lines; the control appears only past two.
  const FOLDED = 2
  const qToggle = (q: Question) => wrappedLines(q.head, qWidth) > FOLDED
  const qTextWidth = (q: Question) => Math.max(1, qWidth - (!compact && qToggle(q) ? FOLD : 0))
  const qOpen = (q: Question) => expanded[`q:${q.id}`] === true
  const revealedText = (q: Question): string | undefined => {
    const side = opened[String(q.id)]
    if (side === 'q' && q.head.trim() !== '') return q.head
    if (side === 'a' && q.answerKey === undefined && (q.answerText?.trim().length ?? 0) > 0) return q.answerText
    return undefined
  }
  const qLines = questions.map(q => {
    const extra = revealedText(q)
    const head = qOpen(q) ? wrappedLines(q.head, qTextWidth(q)) : Math.min(FOLDED, wrappedLines(q.head, qTextWidth(q)))
    return head + qControlsRows + (extra === undefined ? 0 : wrappedLines(extra, qTextWidth(q)))
  })
  // A narrow step always has a controls line: its number lives there.
  const stepControlsRows = (_s: Step) => compact ? 1 : 0
  const clockColumns = (s: Step) => compact || !hasClock(s) ? 0 : clockOf(s).length + 1
  const resultColumns = (s: Step) => !compact && s.status === 'completed' ? 7 : 0
  const stepToggle = (s: Step) => wrappedLines(s.subject, Math.max(1, Math.max(1, sWidth - clockColumns(s)) - resultColumns(s))) > FOLDED
  const foldColumns = (s: Step) => !compact && stepToggle(s) ? FOLD : 0
  const stepWidth = (s: Step) => Math.max(1, Math.max(1, sWidth - clockColumns(s)) - foldColumns(s))
  const stepSubjectWidth = (s: Step) => Math.max(1, Math.max(1, Math.max(1, sWidth - clockColumns(s)) - resultColumns(s)) - foldColumns(s))
  const stepOpen = (s: Step) => expanded[`s:${s.sourceId ?? s.id}`] === true
  const sLines = steps.map(s => (stepOpen(s) ? wrappedLines(s.subject, stepSubjectWidth(s)) : Math.min(FOLDED, wrappedLines(s.subject, stepSubjectWidth(s)))) + stepControlsRows(s) +
    (resultReveals.has(s.id) ? wrappedLines(resultReveals.get(s.id)!, stepWidth(s)) : 0))
  const needQ = questions.length > 0 ? qLines.reduce((a, b) => a + b, 0) : wrappedLines(qEmpty, width)
  const needS = steps.length > 0 ? sLines.reduce((a, b) => a + b, 0) : wrappedLines(sEmpty, width)
  const atWork = steps.findIndex(s => s.status !== 'completed')
  const layoutFor = (bannerCount: number) => {
    const fit = (qArrows: string, sArrows: string) => {
      const qHead = flowRows(['Questions'.length, qRing.length, ...qButtons, qArrows.length], width, HEADER_GAP)
      const sHead = flowRows(['Steps'.length, sRing.length, ...sButtons, sArrows.length], width, HEADER_GAP)
      const room = Math.max(0, bodyRows - (titleRows + qHead + 1 + sHead + (roomy ? 1 : 0) + bottomRows + bannerCount))
      // A compact question needs a text line plus its Q/A controls even in a short pane.
      const minQRows = questions.length > 0 ? 1 + qControlsRows : 1
      let qRows = Math.min(needQ, room, Math.max(minQRows, Math.round(room * QUESTION_SHARE)))
      let sRows = Math.max(0, room - qRows)
      if (needS < sRows) {
        qRows = Math.min(needQ, qRows + sRows - needS)
        sRows = needS
      }
      // An open reveal needs one line of its own. Take it from the steps region,
      // and never from the last step row.
      const revealOpen = questions.some(q => revealedText(q) !== undefined)
      const minSRows = steps.length > 0 ? 1 : 0
      if (revealOpen && qRows < minQRows + 1 && sRows > minSRows) {
        const give = Math.min(minQRows + 1 - qRows, sRows - minSRows)
        qRows += give
        sRows -= give
      }
      // Where each region starts: the newest questions, the step at work with one done row above.
      const qLast = lastStart(qLines, qRows)
      const sLast = lastStart(sLines, sRows)
      const [qStart, qEnd] = windowOf(qLines, qRows, Math.min(at.questions ?? qLast, qLast))
      const [sStart, sEnd] = windowOf(sLines, sRows, Math.min(at.steps ?? (atWork < 0 ? sLast : Math.max(0, atWork - 1)), sLast))

      return { qHead, sHead, qRows, sRows, qLast, sLast, qStart, qEnd, sStart, sEnd }
    }
    // The rows out of view, as arrows in each header. The arrows can wrap the header onto one more
    // row, which takes a row from the regions, so the layout is fitted again with them.
    const arrowsOf = (f: ReturnType<typeof fit>) => [hidden(f.qStart, questions.length - f.qEnd), hidden(f.sStart, steps.length - f.sEnd)] as const
    const first = fit('', '')
    const [qFirst, sFirst] = arrowsOf(first)

    return qFirst === '' && sFirst === '' ? first : fit(qFirst, sFirst)
  }
  // Collapse when the stacked rows would leave fewer than min(3, steps) whole steps in view; a
  // wrapped step takes several lines, so lines are not the measure.
  if (openRows.length > 1 && steps.length > 0) {
    const stacked = layoutFor(openRows.length)
    if (stacked.sEnd - stacked.sStart < Math.min(3, steps.length)) {
      bannerRows = [collapseLine(openRows, width)]
    }
  }
  const fitted = layoutFor(bannerRows.length)
  const { qHead, sHead, qRows, sRows, qLast, sLast, qStart, qEnd, sStart, sEnd } = fitted
  const [qHidden, sHidden] = [hidden(fitted.qStart, questions.length - fitted.qEnd), hidden(fitted.sStart, steps.length - fitted.sEnd)] as const
  const revealOpen = questions.some(q => revealedText(q) !== undefined)
  return project({ qLabelWidth, sLabelWidth, roomy, titleRows, bottomRows, qButtons, sButtons, qWidth, sWidth, qControlsRows, qLines, sLines, needQ, needS, atWork, revealOpen, stepControlsRows, stepWidth, stepSubjectWidth, qToggle, qTextWidth, qOpen, stepToggle, stepOpen }, { bannerRows, qHead, sHead, qRows, sRows, qLast, sLast, qStart, qEnd, sStart, sEnd, qHidden, sHidden }, steps, questions)
}


const step = (subject = 'Step', status: Step['status'] = 'pending', extra: Partial<Step> = {}): Step => ({ id: subject, source: 'plan', subject, status, ...extra })
const question = (id: number, extra: Partial<Question> = {}): Question => ({ id, head: 'Hello', at: 1, turnId: null, status: 'open', ...extra })
// Native ring/count-label behavior captured from513ef7b, outside the extracted span.
const ring = (done: number, total: number): string => {
  if (total === 0) return '○ —'
  const pct = Math.round((100 * done) / total)
  const glyph = pct >= 100 ? '●' : pct >= 75 ? '◕' : pct >= 50 ? '◑' : pct >= 25 ? '◔' : '○'
  return `${glyph} ${done} of ${total} · ${pct}%`
}
const fixture = (width: number, bodyRows: number, questions: Question[] = [], steps: Step[] = [], extra: Partial<ViewportCaseInput> = {}): ViewportCaseInput => {
  const compact = width < 40
  const allLabel = compact ? 'all' : 'clear all'
  const doneLabel = compact ? 'done' : 'clear completed'
  const countLabel = (done: number, total: number) => {
    const full = ring(done, total)
    return compact && total > 0 ? `${full.split(' ')[0]} ${done}/${total}` : full
  }
  const openRows = paneBanner({ l: { v: 1, nextQuestionId: 1, prompts: [], questions, steps }, now: { isWorking: false, agentCalls: [], askCalls: [], background: [] }, questions, steps, phase: 0, isUnsaved: false, unsavedReason: '', pendingCause: undefined, width, questionLabel: questionLabels(questions) }).openRows
  return { width, bodyRows: Math.max(8, bodyRows), compact, rowIndent: compact ? 0 : 2,
    clearWidths: [steps.length > 0 ? buttonWidth('s', allLabel) : 0, buttonWidth('c', doneLabel)],
    hints: compact ? [{ text: '/track hide' }, { text: 'ctrl+x x close' }] : [{ text: '/track hides · ctrl+x x closes for good' }],
    hasQuestions: questions.length > 0, hasSteps: steps.length > 0, allLabel, doneLabel, questions, steps,
    opened: {}, resultReveals: new Map(), expanded: {}, qEmpty: '  None yet.', sEmpty: '  None yet.',
    questionLabel: questionLabels(questions), clockOf: s => s.startedAt === undefined ? '' : clockText((s.endedAt ?? Math.max(120_000, s.startedAt)) - s.startedAt),
    qRing: countLabel(questions.filter(q => q.status === 'answered').length, questions.length),
    sRing: countLabel(steps.filter(s => s.status === 'completed').length, steps.length), at: { questions: null, steps: null }, openRows, ...extra }
}
// The two long steps are unfolded, so they wrap as this literal needs.
const whole = fixture(40, 13, [], [step('a'.repeat(32)), step('b'.repeat(32)), step('c')], { expanded: { [`s:${'a'.repeat(32)}`]: true, [`s:${'b'.repeat(32)}`]: true } })
whole.openRows = paneBanner({ l: { v: 1, nextQuestionId: 1, prompts: [], questions: [], steps: whole.steps }, now: { isWorking: true, agentCalls: [], askCalls: [], background: [] }, questions: [], steps: whole.steps, phase: 0, isUnsaved: true, unsavedReason: 'disk', pendingCause: undefined, width: 40, questionLabel: whole.questionLabel }).openRows
const reveal = fixture(80, 9, [question(1)], [step('one'), step('two')], { opened: { '1': 'q' } })
const shortReveal = { ...reveal, bodyRows: 8 }
const arrows = fixture(33, 10, [question(1), question(2), question(3)])
export const confirmLiterals = (reader: Reader): void => {
  const a = reader(whole)
  assert.deepEqual(a.metrics.sLines, [2, 2, 1], 'whole-step literal: wrapped step lines')
  assert.deepEqual([a.viewport.bannerRows.length, a.viewport.sRows, a.viewport.sStart, a.viewport.sEnd, a.viewport.sHidden], [1, 4, 0, 2, '↓1'], 'whole-step collapse uses count of complete visible steps')
  const b = reader(reveal)
  assert.deepEqual([b.metrics.qLines, b.metrics.sLines, b.viewport.qRows, b.viewport.sRows], [[2], [1, 1], 2, 1], 'reveal borrows one row while preserving final step')
  const c = reader(shortReveal)
  assert.deepEqual([c.viewport.qRows, c.viewport.sRows], [1, 1], 'reveal reserve preserves the final step row at minimum height')
  const d = reader(arrows)
  assert.deepEqual(d.metrics.qLines, [2, 2, 2], 'arrow literal: compact question lines')
  assert.deepEqual([d.viewport.qHead, d.viewport.qRows, d.viewport.sRows, d.viewport.qStart, d.viewport.qEnd, d.viewport.qHidden], [2, 2, 0, 2, 3, '↑2'], 'arrow header second fit reduces region room')
  console.log('literal whole-step/reveal/reserve/arrow assertions pass (FIXTURE)')
}
const snapshot = (value: unknown) => JSON.stringify(value, (_, entry) => entry instanceof Map ? [...entry.entries()] : entry)
const freeze = (value: unknown): void => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
}
export const checkViewport = (reader: Reader): void => {
  confirmLiterals(reader)
  const questions = [question(9), question(20, { head: '界👨‍👩‍👧‍👦'.repeat(12) }), question(30, { answerText: 'Saved answer '.repeat(8), status: 'answered' })]
  const steps = [step('Long subject '.repeat(9), 'in_progress', { startedAt: 0 }), step('Done', 'completed', { startedAt: 0, endedAt: 60_000 }), step('界'.repeat(25)), step('pending')]
  const cases = [whole, reveal, shortReveal, arrows]
  for (const width of [1, 17, 18, 33, 39, 40, 80]) for (const height of [0, 8, 9, 10, 13, 15, 16, 30]) {
    cases.push(fixture(width, height), fixture(width, height, [], [], { hasQuestions: true, hasSteps: true, qEmpty: '  all cleared', sEmpty: '  all cleared' }))
    for (const at of [{ questions: null, steps: null }, { questions: 0, steps: 0 }, { questions: 999, steps: 999 }]) {
      cases.push(fixture(width, height, questions, steps, { at }), fixture(width, height, questions, steps, { at, opened: { '9': 'q', '30': 'a' }, resultReveals: new Map([['Done', 'result '.repeat(16)]]) }))
      cases.push(fixture(width, height, questions, steps, { at, expanded: { 'q:20': true, 'q:30': true, [`s:${'Long subject '.repeat(9)}`]: true, [`s:${'界'.repeat(25)}`]: true } }))
    }
  }
  cases.push(fixture(80, 16, [question(1, { answerText: 'native answer', answerKey: 'native' })], steps, { opened: { '1': 'a' } }))
  for (const value of cases) {
    const before = snapshot(value)
    freeze(value)
    assert.deepEqual(reader(value), referenceViewport(value), `reference viewport parity width=${value.width} height=${value.bodyRows}`)
    assert.equal(snapshot(value), before, 'viewport leaves all input rows/maps/scroll positions unchanged')
  }
}
