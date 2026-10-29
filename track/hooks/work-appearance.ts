// Work state and the step marks drawn from it: pure values the native pane passes in.
import type { Activity, Ledger, Step } from '../types'
import { visibleSteps } from './steps'

// Banner state names; presentation is built by the pane's stack function.
export type WorkState = 'working' | 'agents' | 'tasks' | 'you' | 'paused' | 'unknown' | 'unsaved' | 'done'
// A spinner and grey shades while the main session works, an hourglass and amber shades while it
// waits on agents. The native pane advances the phase.
export const SPINNER = ['◐', '◓', '◑', '◒'] as const
export const GREY_SHADES = ['#5f6670', '#7a828c', '#979fa9', '#b4bcc6', '#979fa9', '#7a828c'] as const
export const AMBER_SHADES = ['#7a5410', '#9a6c16', '#bb861d', '#dba126', '#bb861d', '#9a6c16'] as const
// Ohad's waiting color, one value for the ◆ and the waiting row. Blue, not the permission token.
export const WAITING_BLUE = '#1a73e8'

// Ownership is retained when parked; only an uncleared in-progress row signals active work.
export const isDelegatedWork = (step: Step): boolean => step.cleared !== true && step.delegated === true && step.status === 'in_progress'

// Work activity is independent of whether another item needs the person's action.
// Incomplete work without current runtime activity is paused or unknown.
export const workState = (l: Ledger, now: Activity): WorkState => {
  const steps = visibleSteps(l.steps)
  const unfinished = l.questions.some(q => q.cleared !== true && q.status !== 'answered') || steps.some(s => s.status !== 'completed')
  if (now.agentCalls.length > 0) return 'agents'
  const mainWorks = now.isWorking && now.askCalls.length === 0
  const delegated = steps.some(isDelegatedWork)
  if (delegated && !(mainWorks && steps.some(s => s.status === 'in_progress' && s.delegated !== true))) return 'agents'
  if (mainWorks) return 'working'
  if (now.background.length > 0) return 'agents'
  if ((now.tasks ?? []).length > 0) return 'tasks'

  if (steps.some(s => s.status === 'in_progress')) return 'unknown'
  return unfinished ? 'paused' : 'done'
}

// A step row's glyph and colors, from its status, its lifecycle note, the work state and the
// pulse phase.
export const stepLook = (s: Step, lifecycle: string | undefined, work: WorkState, phase: number) => {
  const color = s.status === 'completed' ? 'success' : undefined
  // The step's mark is the row it sits on. A cancel or a shown refusal is ⊘, not the pause glyph.
  const onWorking = s.status === 'in_progress' && s.delegated !== true && work === 'working'
  return lifecycle === 'cancelled by you' || lifecycle === 'refused'
    ? { glyph: '⊘', glyphColor: 'subtle', textColor: 'subtle' }
    : isDelegatedWork(s)
      ? { glyph: '⧗', glyphColor: AMBER_SHADES[phase % AMBER_SHADES.length], textColor: AMBER_SHADES[phase % AMBER_SHADES.length] }
      : s.status === 'waiting'
        ? { glyph: '◆', glyphColor: WAITING_BLUE, textColor: undefined }
        : onWorking
          ? { glyph: SPINNER[phase % SPINNER.length], glyphColor: GREY_SHADES[phase % GREY_SHADES.length], textColor: GREY_SHADES[phase % GREY_SHADES.length] }
          : s.status === 'paused'
            ? { glyph: '⏸', glyphColor: 'subtle', textColor: 'subtle' }
            : s.status === 'completed'
              ? { glyph: '●', glyphColor: color, textColor: color }
              : s.status === 'pending'
                ? { glyph: '○', glyphColor: color, textColor: color }
                : { glyph: '◐', glyphColor: undefined, textColor: undefined }
}
