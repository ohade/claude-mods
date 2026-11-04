// FIXTURE: literal row contracts and original c9daf9c parity, independent of native hosts.
import assert from 'node:assert/strict'
import type { Activity, Ledger, Question, Step } from '../../types'
import type { WorkState } from '../../hooks/work-appearance'
import { bannerLine } from '../../hooks/banner-layout'
import type { BannerCount, BannerParts, BannerRow } from '../../hooks/banner-layout'
import { AMBER_SHADES, GREY_SHADES, WAITING_BLUE, isDelegatedWork, workState } from '../../hooks/work-appearance'

export type BannerInput = { l: Ledger; now: Activity; phase: number; isUnsaved: boolean; unsavedReason: string; pendingCause: string | undefined; width: number; questions: Question[]; steps: Step[]; questionLabel: (id: number | string) => string }
type Reader = (input: BannerInput) => { work: WorkState; openRows: BannerRow[] }

const AMBER_GLYPH = ['inverseText', '#f2d49b', '#e8bc63', '#f2d49b'] as const

export const originalPaneBanner = (input: BannerInput) => {
  const { l, now, phase, isUnsaved, unsavedReason, width, questions, steps, questionLabel } = input
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
  const piece = (key: string, glyph: string, parts: BannerParts, background: string, glyphColor = 'inverseText'): BannerRow => {
    const line = bannerLine(glyph, parts, width)

    return { key, glyph: line.glyph, words: line.words, background, glyphColor, parts }
  }
  const stack = (): BannerRow[] => {
    const built: BannerRow[] = []
    if (isUnsaved) {
      // A pending outcome may have committed, so it never reads as unsaved.
      const pendingCause = input.pendingCause
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


const step = (status: Step['status'], extra: Partial<Step> = {}): Step => ({ id: 'step', source: 'plan', subject: 'Step', status, ...extra })
const question = (id: number, extra: Partial<Question> = {}): Question => ({ id, head: 'Question', at: 1, turnId: null, status: 'open', ...extra })
const input = (steps: Step[] = [], questions: Question[] = [], now: Partial<Activity> = {}, extra: Partial<BannerInput> = {}): BannerInput => ({
  l: { v: 1, nextQuestionId: 1, prompts: [], questions, steps }, questions, steps,
  now: { isWorking: false, agentCalls: [], askCalls: [], background: [], ...now },
  phase: 0, isUnsaved: false, unsavedReason: '', pendingCause: undefined, width: 80, questionLabel: id => `Q${id}`, ...extra,
})
const row = (key: string, label: string, background: string, glyph = '', steps: string[] = [], questions: string[] = [], counts: BannerCount[] = [], brief = label, glyphColor = 'inverseText'): BannerRow => {
  const parts = { label, brief, questions, steps, counts }
  return { key: `banner-${key}`, ...bannerLine(glyph, parts, 80), background, glyphColor, parts }
}
type Case = { name: string; value: BannerInput; work: WorkState; rows: BannerRow[] }
const idle = () => row('idle', 'Idle · Safe to close', 'success', '', [], [], [], 'Idle')
const agents = (steps: string[] = [], counts: BannerCount[] = []) => row('agents', 'Agents', '#7a5410', '⧗', steps, [], counts)
const working = (steps: string[] = []) => row('working', 'Working', '#5f6670', '◐', steps)
const you = (steps: string[] = [], questions: string[] = []) => row('you', 'Waiting on you', '#1a73e8', '◆', steps, questions, [], 'You')
const paused = () => row('paused', 'Paused', 'warning')
const unknown = () => row('unknown', 'Activity unknown', 'warning', '', [], [], [], 'Unknown')
const delegated = () => step('in_progress', { delegated: true })
const cases: Case[] = [
  { name: 'empty idle and absent tasks', value: input(), work: 'done', rows: [idle()] },
  { name: 'pending count', value: input([step('pending'), step('completed'), step('pending')]), work: 'paused', rows: [row('idle', 'Idle · 2 pending', 'success', '', [], [], [], 'Idle')] },
  { name: 'main working', value: input([step('in_progress')], [], { isWorking: true }), work: 'working', rows: [working(['S1'])] },
  { name: 'delegated-only mainRuns', value: input([delegated()], [], { isWorking: true }), work: 'agents', rows: [agents(['S1']), working()] },
  { name: 'concurrent main and delegated', value: input([delegated(), step('in_progress')], [], { isWorking: true }), work: 'working', rows: [agents(['S1']), working(['S2'])] },
  { name: 'tasks only', value: input([], [], { tasks: ['task'] }), work: 'tasks', rows: [row('agents', 'Tasks', '#7a5410', '⧗', [], [], [{ kind: 'tasks', n: 1 }])] },
  { name: 'background and task counts', value: input([], [], { background: ['a', 'b'], tasks: ['t', 'u', 'v'] }), work: 'agents', rows: [agents([], [{ kind: 'agents', n: 2 }, { kind: 'tasks', n: 3 }])] },
  { name: 'agent call', value: input([], [], { agentCalls: ['agent'] }), work: 'agents', rows: [agents()] },
  { name: 'unknown in-progress', value: input([step('in_progress')]), work: 'unknown', rows: [unknown()] },
  { name: 'ask suppresses unknown', value: input([step('in_progress')], [], { askCalls: ['ask'] }), work: 'unknown', rows: [you()] },
  { name: 'paused step', value: input([step('paused')]), work: 'paused', rows: [paused()] },
  { name: 'unfinished question pauses', value: input([], [question(1)]), work: 'paused', rows: [paused()] },
  { name: 'waiting steps', value: input([step('waiting')]), work: 'paused', rows: [you(['S1'])] },
  { name: 'unsaved empty reason', value: input([], [], {}, { isUnsaved: true }), work: 'done', rows: [row('unsaved', 'Unsaved', 'warning')] },
  { name: 'unsaved reason', value: input([], [], {}, { isUnsaved: true, unsavedReason: 'disk full' }), work: 'done', rows: [row('unsaved', 'Unsaved · disk full', 'warning')] },
  { name: 'pending save keeps cause', value: input([], [], {}, { isUnsaved: true, unsavedReason: 'save outcome pending: receipt lost', pendingCause: 'receipt lost' }), work: 'done', rows: [row('unsaved', 'Save outcome pending · receipt lost', 'warning')] },
  { name: 'mixed status ordinals', value: input([step('completed'), delegated(), step('waiting'), step('paused'), step('in_progress')], [], { isWorking: true }), work: 'working', rows: [agents(['S2']), working(['S5']), you(['S3'])] },
  { name: 'question request references', value: input([], [question(10, { askedRequestId: 'a' }), question(20, { trackedBy: 'b' }), question(30, { askedRequestId: 'a', status: 'answered' }), question(40, { trackedBy: 'b', status: 'deferred' }), question(50)], { askCalls: ['a', 'b'] }), work: 'paused', rows: [you([], ['Q10', 'Q20'])] },
  { name: 'unsaved priority with concurrent activity and ask', value: input([delegated(), step('waiting')], [], { agentCalls: ['agent'], askCalls: ['ask'] }, { isUnsaved: true, unsavedReason: 'save outcome pending: uncertain', pendingCause: 'uncertain' }), work: 'agents', rows: [row('unsaved', 'Save outcome pending · uncertain', 'warning'), agents(['S1']), you(['S2'])] },
  { name: 'paused plus waiting', value: input([step('paused'), step('waiting')]), work: 'paused', rows: [paused(), you(['S2'])] },
  { name: 'completed only', value: input([step('completed')]), work: 'done', rows: [idle()] },
]
const freeze = (value: unknown): void => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
}
export const checkPaneModels = (reader: Reader): void => {
  for (const test of cases) {
    for (const width of [1, 17, 18, 39, 40, 80]) {
      for (let phase = 0; phase < 12; phase++) {
        const value = { ...test.value, width, phase }
        const before = JSON.stringify(value)
        freeze(value)
        const result = reader(value)
        assert.deepEqual(result.openRows.map(row => row.key), test.rows.map(row => row.key), `${test.name}: expected banner keys and order`)
        if (test.name === 'pending save keeps cause') assert.equal(result.openRows[0]?.parts.label, 'Save outcome pending · receipt lost', 'pending save retains its cause and never reads as ordinary Unsaved')
        const rows = test.rows.map(expected => {
          const parts = expected.key === 'banner-unknown' ? { ...expected.parts, label: width < 18 ? 'Unknown' : 'Activity unknown' }
            : expected.key === 'banner-unsaved' ? { ...expected.parts, collapsedLabel: value.pendingCause !== undefined ? 'Save pending' : 'Unsaved' } : expected.parts
          return { ...expected, parts, ...bannerLine(expected.glyph, parts, width),
            glyphColor: expected.key === 'banner-agents' ? ['inverseText', '#f2d49b', '#e8bc63', '#f2d49b'][phase % 4] : expected.glyphColor }
        })
        assert.deepEqual(result, { work: test.work, openRows: rows }, `${test.name}: literal parts, glyph, colors, widths and work`)
        // The old full row stays byte-for-byte equivalent; only its explicit collapse label is new.
        const original = originalPaneBanner(value)
        for (const row of original.openRows) if (row.key === 'banner-unsaved') row.parts.collapsedLabel = value.pendingCause !== undefined ? 'Save pending' : 'Unsaved'
        assert.deepEqual(result, original, `${test.name}: original c9daf9c parity plus the corrected collapse label`)
        assert.equal(JSON.stringify(value), before, `${test.name}: input immutability`)
      }
    }
  }
}
