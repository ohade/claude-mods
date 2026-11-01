// Banner row composition; viewport collapse and native effects stay in register.
import { bannerLine } from './banner-layout'
import type { BannerCount, BannerParts, BannerRow } from './banner-layout'
import { paneBannerState } from './pane-banner-state'
import type { BannerStateInput } from './pane-banner-state'
import { AMBER_SHADES, GREY_SHADES, WAITING_BLUE } from './work-appearance'

type BannerInput = BannerStateInput & { phase: number; isUnsaved: boolean; unsavedReason: string; pendingCause: string | undefined; width: number }
// The agents glyph pulses; the row keeps its amber background.
const AMBER_GLYPH = ['inverseText', '#f2d49b', '#e8bc63', '#f2d49b'] as const

export const paneBanner = (input: BannerInput) => {
  const { now, phase, isUnsaved, unsavedReason, pendingCause, width, steps } = input
  const { work, waitingSteps, agentSteps, mainSteps, pausedSteps, taskCount, agentActivity, questionRefs, unfinishedQuestion, askOpen, mainRow, unknownRow, running } = paneBannerState(input)
  const piece = (key: string, glyph: string, parts: BannerParts, background: string, glyphColor = 'inverseText'): BannerRow => {
    const line = bannerLine(glyph, parts, width)

    return { key, glyph: line.glyph, words: line.words, background, glyphColor, parts }
  }
  const stack = (): BannerRow[] => {
    const built: BannerRow[] = []
    if (isUnsaved) {
      // A pending outcome may have committed, so it never reads as unsaved.
      const label = pendingCause !== undefined ? `Save outcome pending · ${pendingCause}`
        : unsavedReason === '' ? 'Unsaved' : `Unsaved · ${unsavedReason}`
      built.push(piece('banner-unsaved', '', { label, brief: label, questions: [], steps: [], counts: [] }, 'warning'))
    }
    if (agentActivity) {
      const counts: BannerCount[] = []
      if (now.background.length > 0) counts.push({ kind: 'agents', n: now.background.length })
      if (taskCount > 0) counts.push({ kind: 'tasks', n: taskCount })
      const label = agentSteps.length > 0 || now.agentCalls.length > 0 || now.background.length > 0 ? 'Agents' : 'Tasks'
      built.push(piece('banner-agents', '⧗', {
        label,
        brief: label,
        questions: [],
        steps: agentSteps.map(row => `S${row.n}`),
        counts,
      }, AMBER_SHADES[0], AMBER_GLYPH[phase % AMBER_GLYPH.length]))
    }
    if (mainRow) {
      built.push(piece('banner-working', '◐', {
        label: 'Working',
        brief: 'Working',
        questions: [],
        steps: mainSteps.map(row => `S${row.n}`),
        counts: [],
      }, GREY_SHADES[0]))
    }
    if (unknownRow) {
      const label = width < 18 ? 'Unknown' : 'Activity unknown'
      built.push(piece('banner-unknown', '', { label, brief: 'Unknown', questions: [], steps: [], counts: [] }, 'warning'))
    } else if (!running && (pausedSteps.length > 0 || (work === 'paused' && waitingSteps.length === 0 && unfinishedQuestion))) {
      built.push(piece('banner-paused', '', { label: 'Paused', brief: 'Paused', questions: [], steps: [], counts: [] }, 'warning'))
    }
    if (waitingSteps.length > 0 || askOpen) {
      built.push(piece('banner-you', '◆', {
        label: 'Waiting on you',
        brief: 'You',
        questions: questionRefs,
        steps: waitingSteps.map(row => `S${row.n}`),
        counts: [],
      }, WAITING_BLUE))
    }
    if (built.length === 0) {
      // Nothing runs, so closing loses nothing; pending steps are still named as work left.
      const pendingCount = steps.filter(s => s.status === 'pending').length
      const label = pendingCount > 0 ? `Idle · ${pendingCount} pending` : 'Idle · Safe to close'
      built.push(piece('banner-idle', '', { label, brief: 'Idle', questions: [], steps: [], counts: [] }, 'success'))
    }

    return built
  }
  const openRows = stack()
  return { work, openRows }
}
