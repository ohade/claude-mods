// Banner activity projection; all runtime activity arrives as values.
import type { Activity, Ledger, Question, Step } from '../types'
import { isDelegatedWork, workState } from './work-appearance'

export type BannerStateInput = { l: Ledger; now: Activity; questions: Question[]; steps: Step[]; questionLabel: (id: number | string) => string }

export const paneBannerState = ({ l, now, questions, steps, questionLabel }: BannerStateInput) => {
  const work = workState(l, now)
  const numbered = steps.map((s, i) => ({ step: s, n: i + 1 }))
  const waitingSteps = numbered.filter(row => row.step.status === 'waiting')
  const agentSteps = numbered.filter(row => isDelegatedWork(row.step))
  const mainSteps = numbered.filter(row => row.step.status === 'in_progress' && row.step.delegated !== true && work === 'working')
  const pausedSteps = numbered.filter(row => row.step.status === 'paused')
  const taskCount = (now.tasks ?? []).length
  const agentActivity = agentSteps.length > 0 || now.agentCalls.length > 0 || now.background.length > 0 || taskCount > 0
  const askIds = new Set(now.askCalls)
  const questionRefs = questions
    .filter(q => q.status !== 'answered' && q.status !== 'deferred' && (askIds.has(q.askedRequestId ?? '') || askIds.has(q.trackedBy ?? '')))
    .map(q => questionLabel(q.id))
  const unfinishedQuestion = questions.some(q => q.status !== 'answered' && q.status !== 'deferred')
  const askOpen = now.askCalls.length > 0
  // The main turn runs with no main step of its own (only delegated steps): still a Working row.
  const mainRuns = now.isWorking && !askOpen && !numbered.some(row => row.step.status === 'in_progress' && row.step.delegated !== true)
  const mainRow = work === 'working' || mainRuns
  // An ask dialog in the middle of a step is the person's turn, not unknown activity.
  const unknownRow = work === 'unknown' && !askOpen
  const running = agentActivity || mainRow || unknownRow || askOpen
  return { work, waitingSteps, agentSteps, mainSteps, pausedSteps, taskCount, agentActivity, questionRefs, unfinishedQuestion, askOpen, mainRow, unknownRow, running }
}
