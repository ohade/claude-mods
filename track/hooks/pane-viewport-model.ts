// Region fitting owns windows and banner collapse; native owns effects and callbacks.
import type { ScrollAt } from '../types'
import { collapseLine } from './banner-layout'
import type { BannerRow } from './banner-layout'
import { flowRows, lastStart, windowOf, HEADER_GAP, QUESTION_SHARE } from './pane-layout'
import type { PaneMetrics } from './pane-row-metrics'

type ViewportInput = { metrics: PaneMetrics; width: number; bodyRows: number; qRing: string; sRing: string; at: ScrollAt; openRows: BannerRow[]; questionCount: number; stepCount: number }
const hidden = (above: number, below: number): string =>
  [above > 0 ? `↑${above}` : '', below > 0 ? `↓${below}` : ''].filter(Boolean).join(' ')

export const paneViewport = ({ metrics, width, bodyRows, qRing, sRing, at, openRows, questionCount, stepCount }: ViewportInput) => {
  const { roomy, titleRows, bottomRows, qButtons, sButtons, qControlsRows, qLines, sLines, needQ, needS, atWork, revealOpen } = metrics
  let bannerRows = openRows
  const layoutFor = (bannerCount: number) => {
    const fit = (qArrows: string, sArrows: string) => {
      const qHead = flowRows(['Questions'.length, qRing.length, ...qButtons, qArrows.length], width, HEADER_GAP)
      const sHead = flowRows(['Steps'.length, sRing.length, ...sButtons, sArrows.length], width, HEADER_GAP)
      const room = Math.max(0, bodyRows - (titleRows + qHead + 1 + sHead + (roomy ? 1 : 0) + bottomRows + bannerCount))
      // A compact question needs a text line plus its Q/A controls even in a short pane.
      const minQRows = questionCount > 0 ? 1 + qControlsRows : 1
      let qRows = Math.min(needQ, room, Math.max(minQRows, Math.round(room * QUESTION_SHARE)))
      let sRows = Math.max(0, room - qRows)
      if (needS < sRows) {
        qRows = Math.min(needQ, qRows + sRows - needS)
        sRows = needS
      }
      // An open reveal needs one line of its own. Take it from the steps region,
      // and never from the last step row.
      const minSRows = stepCount > 0 ? 1 : 0
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
    const arrowsOf = (f: ReturnType<typeof fit>) => [hidden(f.qStart, questionCount - f.qEnd), hidden(f.sStart, stepCount - f.sEnd)] as const
    const first = fit('', '')
    const [qFirst, sFirst] = arrowsOf(first)

    return qFirst === '' && sFirst === '' ? first : fit(qFirst, sFirst)
  }
  // Collapse when the stacked rows would leave fewer than min(3, steps) whole steps in view; a
  // wrapped step takes several lines, so lines are not the measure.
  if (openRows.length > 1 && stepCount > 0) {
    const stacked = layoutFor(openRows.length)
    if (stacked.sEnd - stacked.sStart < Math.min(3, stepCount)) {
      bannerRows = [collapseLine(openRows, width)]
    }
  }
  const fitted = layoutFor(bannerRows.length)
  const { qHead, sHead, qRows, sRows, qLast, sLast, qStart, qEnd, sStart, sEnd } = fitted
  const [qHidden, sHidden] = [hidden(fitted.qStart, questionCount - fitted.qEnd), hidden(fitted.sStart, stepCount - fitted.sEnd)] as const
  return { bannerRows, qHead, sHead, qRows, sRows, qLast, sLast, qStart, qEnd, sStart, sEnd, qHidden, sHidden }
}
