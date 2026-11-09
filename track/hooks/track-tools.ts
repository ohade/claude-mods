import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginState, MatchedHook } from 'claude-code'
import type { Ledger, Question, ScrollAt, Step, Turn } from '../types'
import { appliedChecksum, checkpointFailure, checksumOf, describeCheckpoint, matchesCheckpoint } from './checkpoint'
import type { Checkpoint } from './checkpoint'
import { visibleSteps, openStepsOf, openPlanSteps } from './steps'
import { ownersForLiveSteps } from './task-ownership'
import { MAX_STEPS, STEP_STATUSES, MAX_QUESTIONS, keepRestores } from './ledger-policy'
import { HEAD_CHARS, RESULT_CHARS, truncate, headOf } from './ledger-text'
import { savedLedger } from './stored-codecs'
import { lookupPaneRows } from './pane-order'
import { sameRecord as sameValue } from './durable-record'
import { questionAdmission, questionSource, mintQuestion, mayMarkAnswer, markQuestion } from './question-commands'
import { planInsertion, insertPlan, replacePlan, markStep, delegationError } from './step-commands'
import { counted, restoreStepCount, restoreNotice } from './restore-records'
import { restoreSource } from './restore-source'
import { proposeRestore } from './restore-proposal'
import { TRACK_QUESTION, MARK_ANSWERED, MARK_STEP, TRACK_STEPS, RESTORE_TRACKER, CHECKPOINT, LOOKUP_ROWS, REORDER_STEPS, SESSION_ID, MAX_PLAN_STEPS, ANSWER, EMPTY_LEDGER, IDLE, rowKey, textOf, reason, persistence, OwnerChanged, assertOwner, updateOwnedLedger } from './track-state'
import type { OwnerToken } from './track-state'
import { readBodySnapshot, saveLedger, historyEnabled, historySnapshot } from './ledger-store'
import { ownerChangedResult, restoreOwnerChangedResult } from './session-owner'
import { coverInput } from './prompt-flow'
import { reorderTrackedSteps } from './pane-actions'

// Atom copies: identical to their register.tsx declarations (tests/helpers/architecture.ts).
const ledger = atom({ plugin: 'track', key: 'ledger' } as const, EMPTY_LEDGER)
const turn = atom({ plugin: 'track', key: 'turn' } as const, { currentId: null, gatedTurnId: null } as Turn)
const activity = atom({ plugin: 'track', key: 'activity' } as const, IDLE)
const reveal = atom({ plugin: 'track', key: 'reveal' } as const, {} as Record<string, 'q' | 'a' | 'r' | undefined>)
const scrollAt = atom({ plugin: 'track', key: 'scroll' } as const, { questions: null, steps: null } as ScrollAt)
const durability = atom({ plugin: 'track', key: 'durability' } as const, { isUnsaved: false, reason: '' } as PluginState['track']['durability'])


export const refusePlanReplacement = (steps: ReturnType<typeof openPlanSteps>) => {
  const rows = steps.map(s => `${s.id} ${JSON.stringify(s.subject)} (${s.status})`).join('; ')
  return { result: `Cannot replace unfinished plan steps: ${rows}. Reuse them or insert with after; pass replace: true only for an intentional replacement.` }
}

// A replacement plan reuses plan:1, even when its title is unchanged. Give
// each new row its own logical identity; sourceId already survives restore.
export const newPlanStep = (id: string, subject: string): Step => ({
  id, source: 'plan', subject, status: 'pending', sourceId: `plan:${crypto.randomUUID()}`,
})
// TODO(CC-179): one label per message cannot count two questions inside it; that needs span
// extraction (Codex's plan, out of scope here).
export async function dropFinishedOwners($: EngineInterface, token?: OwnerToken): Promise<void> {
  const steps = (await read($, ledger)).steps
  await update($, activity, a => {
    assertOwner(token)
    if (a.owners === undefined) return a
    const owners = ownersForLiveSteps(a.owners, steps)
    return JSON.stringify(owners) === JSON.stringify(a.owners) ? a : { ...a, owners }
  })
}

// 'tool.call' { tool: CHECKPOINT }: the registration stays in register.tsx.
type CheckpointCallHook = MatchedHook<'tool.call', { tool: typeof CHECKPOINT }>
export async function checkpointCall($: Parameters<CheckpointCallHook>[0], e: Parameters<CheckpointCallHook>[1]): Promise<Awaited<ReturnType<CheckpointCallHook>>> {
  const session = await $.session.id()
  const failure = (text: string) => ({ result: JSON.stringify(checkpointFailure(session, text)) })
  if (e.agentId !== undefined) return failure('a subagent cannot checkpoint the main ledger')
  if (e.expected_session !== session) return failure('expected session does not match the current session')
  if (!(await saveLedger($))) return failure(persistence.failure)
  let bucket: { checkpoint?: Checkpoint; ledger?: Ledger } | undefined | 'legacy' = 'legacy'
  if (await historyEnabled($)) {
    try { bucket = await historySnapshot($, session) }
    catch (error) { return failure(reason(error)) }
  }
  if (bucket === 'legacy') {
    // As before v3, a failed store read throws rather than becoming a receipt.
    const stored = await $.store.get(`s:${session}`)
    try { bucket = await readBodySnapshot($, `s:${session}`, stored) as { checkpoint?: Checkpoint; ledger?: Ledger } | undefined }
    catch (error) { return failure(reason(error)) }
  }
  if (bucket?.checkpoint === undefined || bucket.ledger === undefined) return failure('saved checkpoint is missing')
  // Inventory and checksum come from the same acknowledged saved snapshot,
  // never a later atom read that could already contain a different blocker.
  return { result: JSON.stringify({ ...bucket.checkpoint, open_steps: openStepsOf(bucket.ledger.steps) }) }
}

// 'tool.call' { tool: LOOKUP_ROWS }: the registration stays in register.tsx.
type LookupRowsCallHook = MatchedHook<'tool.call', { tool: typeof LOOKUP_ROWS }>
export async function lookupRowsCall($: Parameters<LookupRowsCallHook>[0], e: Parameters<LookupRowsCallHook>[1]): Promise<Awaited<ReturnType<LookupRowsCallHook>>> {
  if (e.references !== undefined && (!Array.isArray(e.references) || e.references.length > 64 || !e.references.every(reference => typeof reference === 'string' && /^[SQ]\d+$/i.test(reference)))) {
    return { result: JSON.stringify({ ok: false, reason: 'references must contain at most 64 S/Q labels' }) }
  }
  return { result: JSON.stringify({ ok: true, rows: lookupPaneRows(await read($, ledger), e.references as string[] | undefined) }) }
}

// 'tool.call' { tool: REORDER_STEPS }: the registration stays in register.tsx.
type ReorderStepsCallHook = MatchedHook<'tool.call', { tool: typeof REORDER_STEPS }>
export async function reorderStepsCall($: Parameters<ReorderStepsCallHook>[0], e: Parameters<ReorderStepsCallHook>[1], ownedCalls: Map<string, OwnerToken>): Promise<Awaited<ReturnType<ReorderStepsCallHook>>> {
  if (e.agentId !== undefined) return { deny: 'track: a subagent cannot reorder the session steps.' }
  try {
    return await reorderTrackedSteps($, e.ids, ownedCalls.get(e.tool_use_id))
  } catch (error) {
    if (!(error instanceof OwnerChanged)) throw error
    return ownerChangedResult(e.tool)
  }
}

// 'tool.call' { tool: TRACK_QUESTION }: the registration stays in register.tsx.
type TrackQuestionCallHook = MatchedHook<'tool.call', { tool: typeof TRACK_QUESTION }>
export async function trackQuestionCall($: Parameters<TrackQuestionCallHook>[0], e: Parameters<TrackQuestionCallHook>[1], ownedCalls: Map<string, OwnerToken>): Promise<Awaited<ReturnType<TrackQuestionCallHook>>> {
  const token = ownedCalls.get(e.tool_use_id)
  try {
  if (e.agentId !== undefined) {
    return { deny: 'track: a subagent cannot track questions for the user.' }
  }
  const summary = headOf(String(e.summary ?? ''))
  if (summary === '') {
    return { deny: 'track: summary is required.' }
  }
  const before = await read($, ledger)
  const { existing, capacityExceeded: admissionCapacityExceeded } = questionAdmission(before, summary)
  if (existing !== undefined) {
    await coverInput($, 'question', { source_text: e.source_text, source_request_id: e.source_request_id, summary, questionId: existing.id }, token)
    return { result: `Already tracked as Q${existing.id}: ${existing.head}.` }
  }
  if (admissionCapacityExceeded) return { deny: 'track: question capacity reached; unfinished work was kept.' }
  const session = token?.owner
  let trackedOrder = 0
  let trackedTurnId: string | null = null
  await update($, turn, cur => {
    assertOwner(token)
    trackedOrder = (cur.eventOrder ?? 0) + 1
    trackedTurnId = cur.currentId

    return { ...cur, eventOrder: trackedOrder }
  })
  let minted: Question | undefined
  let capacityExceeded = false
  await updateOwnedLedger($, token, l => {
    const sourceText = typeof e.source_text === 'string' ? e.source_text : undefined
    const sourceRequestId = typeof e.source_request_id === 'string' ? e.source_request_id : undefined
    const source = questionSource(l.prompts, { trackedTurnId, sourceText, sourceRequestId, sourceRowKey: sourceRequestId !== undefined ? rowKey(sourceRequestId) : undefined })
    const proposal = mintQuestion(l, { summary, now: Date.now(), trackedOrder, trackedTurnId, source, toolUseId: e.tool_use_id, session })
    minted = proposal.minted
    capacityExceeded = proposal.capacityExceeded
    return proposal.ledger
  })
  if (capacityExceeded) return { deny: 'track: question capacity reached; unfinished work was kept.' }
  // The Questions region follows the newest question again.
  await update($, scrollAt, cur => {
    assertOwner(token)
    return { ...cur, questions: null }
  })
  if (minted !== undefined) {
    const created = minted
    await update($, durability, cur => {
      assertOwner(token)
      return cur.baseline !== undefined ? cur : { ...cur,
        unverifiedQuestions: [...(cur.unverifiedQuestions ?? []), { id: created.id, at: created.at, head: created.head }] }
    })
    await coverInput($, 'question', { source_text: e.source_text, source_request_id: e.source_request_id, summary, questionId: minted.id }, token)
  }

  // A plugin tool's result is text (or content blocks), never a bare object.
  return { result: `Tracked as Q${minted?.id}: ${summary}. ${ANSWER.replaceAll('{id}', String(minted?.id))}. For deferral, use mcp__track__mark_answered with a note.` }
  } catch (error) {
    if (!(error instanceof OwnerChanged)) throw error
    return ownerChangedResult(e.tool)
  }
}

// 'tool.call' { tool: MARK_ANSWERED }: the registration stays in register.tsx.
type MarkAnsweredCallHook = MatchedHook<'tool.call', { tool: typeof MARK_ANSWERED }>
export async function markAnsweredCall($: Parameters<MarkAnsweredCallHook>[0], e: Parameters<MarkAnsweredCallHook>[1], ownedCalls: Map<string, OwnerToken>): Promise<Awaited<ReturnType<MarkAnsweredCallHook>>> {
  const token = ownedCalls.get(e.tool_use_id)
  try {
  if (e.agentId !== undefined) {
    return { deny: 'track: a subagent cannot mark the user\'s questions.' }
  }
  const id = Number(e.id)
  const status = e.status === 'deferred' ? 'deferred' : 'answered'
  const note = typeof e.note === 'string' ? e.note.slice(0, HEAD_CHARS) : undefined
  const l = await read($, ledger)
  if (!l.questions.some(q => q.id === id)) {
    const open = l.questions.filter(q => q.status === 'open').map(q => `Q${q.id} "${q.head}"`)

    return { result: `No question with id ${id}. Open: ${open.length > 0 ? open.join('; ') : 'none'}.` }
  }
  // Only the model can identify a completed answer. A latest text observation
  // establishes where matching words were drawn; progress alone grants no answer.
  const t = await read($, turn)
  const question = l.questions.find(q => q.id === id) as Question
  const text = t.lastText
  const isAfterQuestion = text?.order !== undefined && (question.turnId !== t.currentId || (question.trackedOrder !== undefined && text.order > question.trackedOrder))
  const last = status === 'answered' && text !== undefined && text.turnId === t.currentId && isAfterQuestion ? text : undefined
  if (e.answer_request_id !== undefined && (last?.requestId === undefined || last.requestId !== e.answer_request_id)) {
    return { deny: 'track: answer source is not the latest verified response in this turn; nothing changed.' }
  }
  const supplied = typeof e.answer_text === 'string' ? e.answer_text.trim() : undefined
  if (status === 'answered' && e.answer_text !== undefined && !supplied) {
    return { deny: 'track: answer_text must contain the completed answer; nothing changed.' }
  }
  const suppliedHash = status === 'answered' && supplied !== undefined ? await checksumOf(supplied) : undefined
  const matchesNative = supplied !== undefined && last !== undefined &&
    (last.textHash !== undefined ? suppliedHash === last.textHash : supplied === last.text)
  if (status === 'answered' && e.answer_request_id !== undefined && supplied !== undefined && !matchesNative) {
    return { deny: 'track: answer text does not match the verified response; nothing changed.' }
  }
  if (status === 'answered' && question.answerText !== undefined) return { result: `Q${id} is already answered; its known answer was kept.` }
  const native = status === 'answered' && (e.answer_request_id !== undefined || matchesNative) ? last : undefined
  const answerText = status === 'answered' ? supplied ?? native?.text : undefined
  if (status === 'answered' && !answerText) {
    return { deny: 'track: supply completed answer_text or a verified answer_request_id; nothing changed.' }
  }
  const answerKey = status === 'answered' ? native?.row ?? e.tool_use_id : undefined
  if (status === 'answered' && !answerKey) {
    return { deny: 'track: the answer has no verified response or tracking-call identity; nothing changed.' }
  }
  const answerOrder = t.eventOrder ?? 0
  await updateOwnedLedger($, token, cur => ({
    ...cur,
    questions: cur.questions.map(q => {
      if (!mayMarkAnswer(q, id, status)) return q
      return markQuestion(q, {
        status, now: Date.now(), note,
        answerRequestId: native?.requestId ?? e.tool_use_id,
        answeredBy: e.tool_use_id, answerKey, answerText,
        answerTextHash: suppliedHash ?? native?.textHash,
        ...(status === 'answered' && native === undefined && t.currentId !== null && { answerTurnId: t.currentId, answerOrder }),
      })
    }),
  }))
  // [A] is now the native answer row. A pane reveal of the saved text would stay stuck beside it.
  if (status === 'answered' && answerKey !== undefined) {
    await update($, reveal, cur => {
      assertOwner(token)
      return cur[String(id)] === 'a' ? { ...cur, [String(id)]: undefined } : cur
    })
  }

  return { result: `Q${id} marked ${status}.` }
  } catch (error) {
    if (!(error instanceof OwnerChanged)) throw error
    return ownerChangedResult(e.tool)
  }
}

// 'tool.call' { tool: TRACK_STEPS }: the registration stays in register.tsx.
type TrackStepsCallHook = MatchedHook<'tool.call', { tool: typeof TRACK_STEPS }>
export async function trackStepsCall($: Parameters<TrackStepsCallHook>[0], e: Parameters<TrackStepsCallHook>[1], ownedCalls: Map<string, OwnerToken>): Promise<Awaited<ReturnType<TrackStepsCallHook>>> {
  const token = ownedCalls.get(e.tool_use_id)
  try {
  if (e.agentId !== undefined) {
    return { deny: 'track: a subagent cannot set the session\'s steps.' }
  }
  await update($, scrollAt, cur => {
    assertOwner(token)
    return { ...cur, steps: null }
  })
  const titles = (Array.isArray(e.steps) ? e.steps : []).map(t => headOf(String(t))).filter(t => t !== '').slice(0, MAX_PLAN_STEPS)
  if (titles.length === 0) {
    return { result: 'No steps given: pass steps as an array of one-line titles.' }
  }
  const session = token?.owner
  if (e.after !== undefined && (typeof e.after !== 'string' || e.after.trim() === '')) {
    return { result: 'after must be a non-blank step id; no plan rows changed. Omit after only for replacement.' }
  }
  const after = e.after as string | undefined
  if (after !== undefined) {
    // New work joins a running plan: insert after that step, ids after the highest plan id. The
    // ids are taken inside the write, so two calls in flight never take the same ones.
    const l = await read($, ledger)
    if (after !== 'last' && !l.steps.some(s => s.id === after)) {
      return { result: `No step ${after}. Known steps: ${l.steps.map(s => s.id).join(', ') || 'none'}.` }
    }
    let added: Step[] = []
    let anchor: string | undefined
    await updateOwnedLedger($, token, cur => {
      // "last" is the last stored plan row, cleared or not, resolved here so a plan row another
      // writer added before this write is the anchor. With no plan row it creates the plan.
      const proposal = planInsertion(cur, after, titles.length)
      anchor = proposal.anchor
      added = proposal.ids.map((id, k) => newPlanStep(id, titles[k]!))
      return insertPlan(cur, added, anchor, session)
    })
    await coverInput($, 'steps', { source_text: e.source_text }, token)

    if (anchor === undefined) {
      return { result: `Tracking ${added.length} steps: ${added.map(s => `${s.id} ${s.subject}`).join('; ')}. Mark each with mcp__track__mark_step as you go.` }
    }
    return { result: `Inserted after ${anchor}: ${added.map(s => `${s.id} ${s.subject}`).join('; ')}. Mark each with mcp__track__mark_step as you go.` }
  }
  const beforeReplacement = e.replace === true ? [] : openPlanSteps((await read($, ledger)).steps)
  if (beforeReplacement.length > 0) return refusePlanReplacement(beforeReplacement)
  const steps: Step[] = titles.map((subject, i) => newPlanStep(`plan:${i + 1}`, subject))
  let unfinished: ReturnType<typeof openPlanSteps> = []
  await updateOwnedLedger($, token, cur => {
    // UI-1 (2026-10-20): validate inside the atomic update so concurrent additions cannot be lost.
    const proposal = replacePlan(cur, steps, e.replace === true, session)
    unfinished = proposal.unfinished
    return proposal.ledger
  })
  if (unfinished.length > 0) return refusePlanReplacement(unfinished)
  await coverInput($, 'steps', { source_text: e.source_text }, token)

  return { result: `Tracking ${steps.length} steps: ${steps.map(s => `${s.id} ${s.subject}`).join('; ')}. Mark each with mcp__track__mark_step as you go.` }
  } catch (error) {
    if (!(error instanceof OwnerChanged)) throw error
    return ownerChangedResult(e.tool)
  }
}

// 'tool.call' { tool: RESTORE_TRACKER } #1: the registration stays in register.tsx.
type RestoreTrackerCallHook = MatchedHook<'tool.call', { tool: typeof RESTORE_TRACKER }>
export async function restoreTrackerCall($: Parameters<RestoreTrackerCallHook>[0], e: Parameters<RestoreTrackerCallHook>[1], next: Parameters<RestoreTrackerCallHook>[2], ownedCalls: Map<string, OwnerToken>): Promise<Awaited<ReturnType<RestoreTrackerCallHook>>> {
  const token = ownedCalls.get(e.tool_use_id)
  // Only an engine-origin model call has a displayed ToolUse row. A plugin
  // call needs an acknowledged plugin user note; its generated tool id is not a
  // transcript target. Origin comes from the host, never from the arguments.
  const mechanical = next.origin.plugin !== 'engine'
  const from = typeof e.from_session === 'string' ? e.from_session : ''
  const expected = e.expected_checkpoint
  let destination: string | undefined
  const failed = (text: string) => expected === undefined ? { deny: text } : { result: JSON.stringify(checkpointFailure(from, text, destination)) }
  try {
  if (expected !== undefined) destination = await $.session.id()
  if (e.agentId !== undefined) {
    return failed('track: a subagent cannot set the session\'s steps.')
  }
  if (!SESSION_ID.test(from)) {
    return failed(`track: "${truncate(from, 60)}" is not a session id; nothing changed.`)
  }
  let routed: Awaited<ReturnType<typeof historySnapshot>> = 'legacy'
  if (await historyEnabled($)) {
    try { routed = await historySnapshot($, from) }
    catch (error) { return failed(`track: ${reason(error)}; nothing changed.`) }
  }
  const saved = (routed === 'legacy' ? await readBodySnapshot($, `s:${from}`, await $.store.get(`s:${from}`)) : routed === undefined ? undefined : { v: 1, ...routed }) as { checkpoint?: Checkpoint; ledger?: { steps?: unknown; questions?: unknown } } | undefined
  const source = savedLedger(saved, from)
  let checkpoint: Checkpoint | undefined
  if (expected !== undefined) {
    if (source === undefined || saved?.checkpoint === undefined) return failed('source checkpoint is missing or incompatible')
    checkpoint = await describeCheckpoint(source, from, saved.checkpoint)
    if (!matchesCheckpoint(checkpoint, expected) || !matchesCheckpoint(checkpoint, saved.checkpoint)) return failed('source checkpoint session, revision, checksum or counts do not match')
  }
  const { steps, questions } = restoreSource(saved, from)
  const visibleStepCount = visibleSteps(steps).length
  if (steps.length > MAX_STEPS || questions.length > MAX_QUESTIONS) return failed('track: restore capacity exceeded; unfinished source work was kept.')
  if (steps.length === 0 && questions.length === 0 && checkpoint === undefined) {
    return failed(`track: No saved steps or questions for session ${from}; nothing changed.`)
  }
  const replace = e.replace === true
  const before = await read($, ledger)
  // Legacy unowned ledgers need no destination lookup for an in-memory
  // restore. Explicit ownership must still match the active session.
  const beforeOwner = before.session_id ?? (await read($, durability)).memorySession
  if (destination === undefined && beforeOwner !== undefined) destination = await $.session.id()
  let refusal: string | undefined
  let restored: Question[] = []
  let personNotice: string | undefined
  // Build a proposal without changing the atom. A refused or altered notice
  // cannot leave restored rows behind in memory or trigger a durable save.
  const propose = (cur: Ledger): Ledger => {
    const result = proposeRestore(cur, { from, steps, questions, replace, beforeOwner, destination, mechanical, toolUseId: e.tool_use_id, hasCheckpoint: checkpoint !== undefined, visibleStepCount })
    refusal = result.refusal
    restored = result.restored
    return result.next
  }
  let proposed = propose(before)
  if (refusal !== undefined) {
    return failed(refusal)
  }
  if (mechanical && restored.length > 0) {
    // The acknowledged native UUID lives on the question itself, so a
    // bounded archive ring cannot evict a live question's jump target.
    const visible = restored.filter(q => q.cleared !== true)
    const existing = !replace && visible.every(q => q.restoredBy !== undefined && SESSION_ID.test(q.restoredBy) && proposed.restores?.some(r => r.by === q.restoredBy && r.display === 'user' && r.questions.some(saved => saved.id === q.id)))
    if (visible.length > 0 && !existing) {
      const text = restoreNotice({ by: '', from, steps: steps.length, visibleSteps: visibleStepCount, questions: visible, display: 'user' })
      const notice = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      if (notice.deny !== undefined) return failed(`track: visible restore receipt refused: ${notice.deny}`)
      if (!SESSION_ID.test(notice.uuid) || notice.message.type !== 'user' || textOf(notice.message.content) !== text) return failed('track: visible restore receipt is incompatible')
      const ids = new Set(visible.map(q => q.id))
      const displayed = proposed.questions.filter(q => ids.has(q.id)).map(q => ({ ...q, restoredBy: notice.uuid }))
      restored = restored.map(q => displayed.find(one => one.id === q.id) ?? q)
      proposed = {
        ...proposed,
        questions: proposed.questions.map(q => displayed.find(one => one.id === q.id) ?? q),
        restores: keepRestores([...(proposed.restores ?? []).filter(r => r.by !== e.tool_use_id), { by: notice.uuid, from, steps: steps.length, visibleSteps: visibleStepCount, questions: displayed, display: 'user' }], proposed.questions.map(q => displayed.find(one => one.id === q.id) ?? q)),
      }
      personNotice = restoreNotice({ by: notice.uuid, from, steps: steps.length, visibleSteps: visibleStepCount, questions: displayed })
    }
  }
  await updateOwnedLedger($, token, cur => {
    if (mechanical && !sameValue(cur, before)) {
      refusal = 'track: ledger changed while the restore receipt was pending; nothing was restored. Retry against the current ledger.'
      return cur
    }
    return mechanical ? proposed : propose(cur)
  })
  if (refusal !== undefined) return failed(refusal)
  // The person-facing notice is not a receipt. A refusal leaves the restore in place;
  // the pane still has the saved questions and answers.
  if (personNotice !== undefined) {
    try {
      const shownNotice = await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: personNotice }] } })
      if (shownNotice.deny !== undefined) $.ui.log(`track: person restore notice refused: ${shownNotice.deny}`, { to: 'debug' })
    } catch (error) {
      $.ui.log(`track: person restore notice failed: ${reason(error)}`, { to: 'debug' })
    }
  }
  await update($, scrollAt, cur => {
    assertOwner(token)
    return { steps: steps.length > 0 ? null : cur.steps, questions: restored.length > 0 ? null : cur.questions }
  })
  const shown = visibleSteps(steps)
  const at = shown.findIndex(s => s.status === 'in_progress')
  const where = at < 0 ? 'None in progress.' : `In progress: S${at + 1} ${shown[at]?.subject}.`
  // The model reads the ids and where each question stands; the answers are for the person.
  const listed = restored.map(q => `\nQ${q.id} ${q.status} ${q.head}`).join('')

  const applied = await read($, ledger)
  const openSteps = openStepsOf(applied.steps)
  return { result: checkpoint === undefined ? `Restored ${restoreStepCount({ by: '', from, steps: steps.length, visibleSteps: visibleStepCount, questions: restored })} and ${counted(restored.length, 'question')} from session ${from}. ${where}${listed}\nOpen steps: ${JSON.stringify(openSteps)}` : JSON.stringify({ ...checkpoint, destination_session: destination, applied_checksum: await appliedChecksum(source!, applied, from, destination!), open_steps: openSteps }) }
  } catch (error) {
    if (error instanceof OwnerChanged) return expected === undefined ? ownerChangedResult(e.tool) : restoreOwnerChangedResult(from, destination)
    return failed(`track: restoration failed — ${reason(error)}`)
  }
}

// 'tool.call' { tool: MARK_STEP }: the registration stays in register.tsx.
type MarkStepCallHook = MatchedHook<'tool.call', { tool: typeof MARK_STEP }>
export async function markStepCall($: Parameters<MarkStepCallHook>[0], e: Parameters<MarkStepCallHook>[1], reuseCalls: Map<string, { step?: Step }>, ownedCalls: Map<string, OwnerToken>): Promise<Awaited<ReturnType<MarkStepCallHook>>> {
  const token = ownedCalls.get(e.tool_use_id)
  try {
  if (e.agentId !== undefined) {
    return { deny: 'track: a subagent cannot mark the session\'s steps.' }
  }
  const currentId = (await read($, turn)).currentId
  const delegationProblem = delegationError(e)
  if (delegationProblem !== undefined) return { deny: delegationProblem }
  const id = String(e.id)
  const status = STEP_STATUSES.find(one => one === e.status)
  const supplied = typeof e.result_text === 'string' ? e.result_text.trim() : undefined
  if (e.result_text !== undefined && (status !== 'completed' || !supplied)) return { deny: 'track: result_text must contain the verified result and is accepted only for completed steps.' }
  const l = await read($, ledger)
  if (status === undefined || !l.steps.some(s => s.id === id)) {
    return { result: `No change. Known steps: ${l.steps.map(s => `${s.id} (${s.status})`).join(', ') || 'none'}.` }
  }
  const now = await $.clock.now()
  const result = supplied === undefined ? undefined : {
    resultText: supplied.slice(0, RESULT_CHARS), resultTextHash: await checksumOf(supplied), resultAt: now,
    ...(typeof e.tool_use_id === 'string' && { resultRequestId: e.tool_use_id }),
    ...(typeof currentId === 'string' && { resultTurnId: currentId }),
  }
  const reuse = reuseCalls.get(e.tool_use_id)
  await updateOwnedLedger($, token, cur => {
    // A compare-and-set retry must discard eligibility from the old snapshot.
    if (reuse !== undefined) reuse.step = undefined
    const proposal = markStep(cur, { id, status, now, currentId, note: typeof e.note === 'string' ? e.note : undefined, delegated: e.delegated, external_owner: e.external_owner, result })
    if (reuse !== undefined) reuse.step = proposal.reusableStep
    return proposal.ledger
  })
  await dropFinishedOwners($, token)

  return { result: `Step ${id} "${l.steps.find(s => s.id === id)?.subject}" marked ${status}.` }
  } catch (error) {
    if (!(error instanceof OwnerChanged)) throw error
    return ownerChangedResult(e.tool)
  }
}
