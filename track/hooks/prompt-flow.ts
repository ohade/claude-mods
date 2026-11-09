import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginState } from 'claude-code'
import type { Ledger, Pending, PendingInput, Prompt, Question, Step, Turn } from '../types'
import { checksumOf } from './checkpoint'
import { visibleSteps } from './steps'
import { needsQuestion, ofTurn, waitingArrowIds } from './turn-policy'
import { withoutStepResult, MAX_PROMPTS } from './ledger-policy'
import { ANSWER_CHARS, truncate, headOf, norm } from './ledger-text'
import { sameRecord as sameValue } from './durable-record'
import { answerBlocks, answerBlockKey } from './answer-blocks'
import { bindAnswerResponse, markerForQuestion, captureMarkerAnswer } from './question-commands'
import { classifyTranscriptChange, printsOf } from './transcript-baseline'
import { CLASSIFIER_KEY, CLASSIFIER_MAX_CHARS, CLASSIFIER, EMPTY_LEDGER, rowKey, reason, persistence, noteEvent, freshTurn, ownership, OwnerChanged, isOwnerCurrent, assertOwner, updateLedger, updateOwnedLedger } from './track-state'
import type { OwnerToken } from './track-state'
import { publishGate, saveLedger } from './ledger-store'
import { MESSAGES_CAP, captureMintOwner, ensureOwner } from './session-owner'

// Atom copies: identical to their register.tsx declarations (tests/helpers/architecture.ts).
const ledger = atom({ plugin: 'track', key: 'ledger' } as const, EMPTY_LEDGER)
const turn = atom({ plugin: 'track', key: 'turn' } as const, { currentId: null, gatedTurnId: null } as Turn)
const pending = atom({ plugin: 'track', key: 'pending' } as const, { inputs: [], nextId: 1 } as Pending)
const durability = atom({ plugin: 'track', key: 'durability' } as const, { isUnsaved: false, reason: '' } as PluginState['track']['durability'])

export const rewindCheck = { isScheduled: false, lastAt: -Infinity, running: undefined as { hasPrompt: boolean; run: Promise<boolean> } | undefined }

// The transcript last read for one session, as one cheap fingerprint per message. It lives only
// in memory. A later read that starts with it grew; one that it starts with was rewound. A read
// that is neither (allowing the prompt being sent after a rewound prefix) was compacted, even
// when the host sent no compaction callback.
export let transcriptBaseline: { session: string; prints: string[] } | undefined
// session.compact bumps this, so a read that started before the callback never writes after it.
export let baselineGeneration = 0
// The session.compact handler's reset, moved here because register.tsx cannot assign an
// imported binding (TRACK-46 slice 6). Same two statements, same order.
export function forgetTranscriptBaseline(): void {
  transcriptBaseline = undefined
  baselineGeneration++
}

// session.messages exposes no response UUID. Bind a marker answer to its
// stable block id and full words; a different answer with that id is absent.
export const answerSourceOf = (q: Question) => {
  const block = q.answeredBy === undefined ? /:A([1-9]\d*)$/.exec(q.answerKey ?? '') : null
  return block !== null && q.answerTextHash !== undefined
    ? `marker:A${block[1]}:${q.answerTextHash}`
    : q.answeredBy ?? q.answerRequestId
}
export const judgedQuestion = (q: Question, since: number): boolean =>
  (q.trackedBy !== undefined && q.at > since) || (answerSourceOf(q) !== undefined && (q.answeredAt ?? 0) > since)
export const judgedResultStep = (s: Step, since: number): boolean => s.resultRequestId !== undefined && (s.resultAt ?? 0) > since
// Rows the rewind check judges: transcript provenance newer than the last compaction.
export const hasJudgedRows = (l: Ledger): boolean =>
  l.questions.some(q => judgedQuestion(q, l.compactedAt ?? 0)) || l.steps.some(s => judgedResultStep(s, l.compactedAt ?? 0))

// /rewind raises no event, so detect it from the transcript: a question whose
// track_question call is gone was asked in a rewound turn, and an answer whose
// mark_answered call or complete marked text is gone was rewound. Only work since
// the last compaction is judged, since compaction removes old messages as well.
// `submitted` is the prompt being sent, which a rewind may already show after its prefix.
export async function observeRewind($: EngineInterface, submitted?: string): Promise<boolean> {
  const generation = baselineGeneration
  const l = await read($, ledger)
  const since = l.compactedAt ?? 0
  const judgedResult = (s: Step) => judgedResultStep(s, since)
  const missingResult = (s: Step) => judgedResult(s) && !present.has(s.resultRequestId!)
  const hasJudged = hasJudgedRows(l)
  // With no judged row, a baseline would go stale while nothing refreshes it; drop it.
  if (!hasJudged) transcriptBaseline = undefined
  const pending = (await read($, durability)).rewindSession
  // Empty registers and rows without transcript provenance need no session
  // lookup or transcript read before delivering their generic instruction.
  if (!hasJudged && pending === undefined) return true
  let session: string
  try { session = await $.session.id() }
  catch (error) {
    persistence.failure = `rewind session identity unavailable: ${reason(error)}`
    $.ui.log(`track: ${persistence.failure}`, { to: 'debug' })
    return false
  }
  // TRACK-46 A1/C1 (iv): rows another session owns are never judged against this session's
  // transcript, where that session's calls are absent. A viewport check selects no session; the
  // next owned event loads this session's rows, and a later check judges those.
  if (l.session_id !== undefined && l.session_id !== session) return true
  if (pending === session && !(await saveLedger($))) return false
  if (!hasJudged) {
    return true
  }
  const messages = await $.session.messages()
  if (!Array.isArray(messages) || messages.length >= MESSAGES_CAP) {
    return true
  }
  const present = new Set(messages.flatMap(m => m.toolUses.map(u => u.tool_use_id)))
  const blocks = messages.flatMap(m => m.role === 'assistant' ? answerBlocks(m.text) : [])
  for (const key of await Promise.all(blocks.map(async block => `marker:A${block.id}:${await checksumOf(block.text)}`))) present.add(key)
  if (await $.session.id() !== session || generation !== baselineGeneration) return true
  const prints = printsOf(messages)
  const change = classifyTranscriptChange(transcriptBaseline?.session === session ? transcriptBaseline.prints : undefined,
    prints, messages.at(-1), submitted)
  // Undecided keeps the baseline for the next prompt's read.
  if (change === 'undecided') return true
  transcriptBaseline = { session, prints }
  if (change === 'compacted') {
    // Keep every row and judge only later work, as the session.compact handler does.
    // Without an earlier read this cannot be told from a rewind.
    await updateLedger($, cur => ({ ...cur, compactedAt: Date.now() }))
    return true
  }
  if (!l.questions.some(q =>
    (q.trackedBy !== undefined && q.at > since && !present.has(q.trackedBy)) ||
    (answerSourceOf(q) !== undefined && (q.answeredAt ?? 0) > since && !present.has(answerSourceOf(q)!))
  ) && !l.steps.some(missingResult)) return true
  // Capture the pre-rewind rows in memory. The save path verifies this
  // snapshot against the durable body under its locks before adopting it.
  await update($, durability, cur => ({ ...cur, rewindBaseline: { session_id: session, ledger: l } }))
  const observed = new Map(l.questions.map(q => [q.id, q]))
  const observedSteps = new Map(l.steps.map(step => [step.id, step]))
  let changed = false
  await updateLedger($, cur => {
    const compactedAt = cur.compactedAt ?? 0
    const questions = cur.questions.flatMap(q => {
      const old = observed.get(q.id)
      // Only the calls judged by this read may be removed. A later tracking call,
      // answer, or compaction wins over the older transcript observation.
      if (old === undefined) return [q]
      if (q.trackedBy === old.trackedBy && q.at === old.at && q.trackedBy !== undefined && q.at > compactedAt && !present.has(q.trackedBy)) return []
      const source = answerSourceOf(q)
      if (source === undefined || source !== answerSourceOf(old) || q.answeredAt !== old.answeredAt || (q.answeredAt ?? 0) <= compactedAt || present.has(source)) return [q]
      const { answerRequestId: _a, answeredBy: _by, answeredAt: _t, answerTurnId: _turn, answerOrder: _order, note: _n, answerKey: _k, answerInstance: _i, answerInstanceSession: _in, answerText: _x, answerTextHash: _hash, ...rest } = q

      return [{ ...rest, status: 'open' as const }]
    })
    const steps = cur.steps.map(step => {
      const old = observedSteps.get(step.id)
      if (old === undefined || step.resultRequestId !== old.resultRequestId || step.resultAt !== old.resultAt || step.resultTextHash !== old.resultTextHash ||
          step.resultRequestId === undefined || (step.resultAt ?? 0) <= compactedAt || present.has(step.resultRequestId)) return step
      return withoutStepResult(step)
    })
    changed = !sameValue(questions, cur.questions) || !sameValue(steps, cur.steps)
    return changed ? { ...cur, questions, steps } : cur
  })
  if (changed) {
    await update($, durability, cur => ({ ...cur, rewindSession: session }))
    await publishGate($)
    return saveLedger($)
  }
  return true
}

// A main-loop turn end records the transcript only when the session has no baseline yet, so the
// next prompt's read can compare even when it is the first read since the rows were saved. It never
// judges a read: only a prompt's read classifies a change, against the baseline it last refreshed.
export async function recordTranscriptBaseline($: EngineInterface): Promise<void> {
  const generation = baselineGeneration
  if (!hasJudgedRows(await read($, ledger))) {
    transcriptBaseline = undefined
    return
  }
  try {
    const session = await $.session.id()
    if (transcriptBaseline?.session === session) return
    const messages = await $.session.messages()
    if (!Array.isArray(messages) || messages.length >= MESSAGES_CAP || await $.session.id() !== session ||
      generation !== baselineGeneration) return
    // A prompt may have established the baseline during either awaited read.
    if (transcriptBaseline?.session === session) return
    transcriptBaseline = { session, prints: printsOf(messages) }
  } catch (error) {
    // No baseline: the next read behaves as it did before baselines existed.
    $.ui.log(`track: transcript baseline not recorded: ${reason(error)}`, { to: 'debug' })
    noteEvent($, 'transcript.baseline_unrecorded')
  }
}

export async function dropRewound($: EngineInterface, submitted?: string): Promise<boolean> {
  const running = rewindCheck.running
  if (running !== undefined) {
    if (submitted === undefined || running.hasPrompt) return running.run
    // A viewport read lacks the prompt text needed to judge a rewind plus prompt.
    if (!(await running.run)) return false
    return dropRewound($, submitted)
  }
  const run = observeRewind($, submitted)
  const flight = { hasPrompt: submitted !== undefined, run }
  rewindCheck.running = flight
  try { return await run }
  finally { if (rewindCheck.running === flight) rewindCheck.running = undefined }
}

// Clear all for steps (Ohad, 2026-10-28). With an unfinished step the first press only arms; a
// second press within CLEAR_ARM_MS clears, and the unfinished steps it removed are told to the
// model once on its next prompt, as withdrawn questions are. All completed: one press clears.
// TRACK-46 A1/C1: a pane press is the session's own action, so it first selects the current
// session, as tool calls do; it never changes the previous owner's rows. Its token fences every
// ledger write, gate and save, so a press still running when another session is selected stops
// instead of writing into that session. An identity outage acts on memory, as before, fenced to
// the memory owner and the ownership epoch it read (Codex review of 2a0ecb2).
// TRACK-46 A1/C1 (iii): the reply observation after its admission, fenced by its token.
export async function observeResponse($: EngineInterface, requestId: string, text: string, token: OwnerToken): Promise<void> {
  let observed: (NonNullable<Turn['lastText']> & { requestId: string; order: number }) | undefined
  await update($, turn, cur => {
    assertOwner(token)
    const order = (cur.eventOrder ?? 0) + 1
    observed = { row: rowKey(requestId), requestId, turnId: cur.currentId, order, text: truncate(text, ANSWER_CHARS) }
    return { ...cur, eventOrder: order, lastText: observed }
  })
  // Reserve event order before hashing. Keep full-word identity in bounded
  // metadata; comparing only the saved prefix could attach a different answer.
  const answer = { ...observed!, textHash: await checksumOf(text) }
  await update($, turn, cur => {
    assertOwner(token)
    return cur.lastText?.requestId === answer.requestId && cur.lastText.order === answer.order
      ? { ...cur, lastText: answer }
      : cur
  })
  // Keep this message's observation. A later turn-atom write must never
  // replace its text while leaving this message's UUID on the answer.
  let changed = false
  await updateLedger($, cur => {
    assertOwner(token, cur)
    if (answer.text === undefined) {
      changed = false
      return cur
    }
    const proposal = bindAnswerResponse(cur, { text, answerText: answer.text, textHash: answer.textHash, row: answer.row, requestId, turnId: answer.turnId, order: answer.order })
    changed = proposal.changed
    return proposal.ledger
  })
  if (changed) {
    await publishGate($, token)
    await saveLedger($, token)
  }
}

// TRACK-46 A1/C1 (iii): the marker capture after its stored reply, fenced by the capture's token.
export async function captureResponse($: EngineInterface, text: string, requestId: string, observed: { turnId: string; order: number }, token: OwnerToken): Promise<void> {
  const current = await read($, turn)
  if (current.currentId !== observed.turnId) return
  assertOwner(token)
  const shown = visibleSteps((await read($, ledger)).steps)
  const arrows = waitingArrowIds(text, new Set(shown.map(step => step.id)), shown)
  await update($, turn, cur => {
    assertOwner(token)
    if (cur.currentId !== observed.turnId || cur.lastText?.order !== observed.order) return cur
    const fresh = cur.freshness?.turnId === observed.turnId ? cur.freshness : freshTurn(observed.turnId)
    return { ...cur, freshness: { ...fresh, response: { turn_id: observed.turnId, request_id: requestId, arrow_ids: arrows } } }
  })
  await publishGate($, token)
  const blocks = answerBlocks(text)
  if (blocks.length === 0) return
  const completed = await Promise.all(blocks.map(async block => ({ ...block, hash: await checksumOf(block.text) })))
  let changed = false
  await updateLedger($, cur => {
    assertOwner(token, cur)
    changed = false
    const questions = cur.questions.map(q => {
      const nativeKey = q.answerRequestId !== undefined ? answerBlockKey(rowKey(q.answerRequestId), q.id) : undefined
      const block = markerForQuestion(q, completed, observed.turnId, observed.order, nativeKey)
      if (block === undefined) return q
      changed = true
      return captureMarkerAnswer(q, { block, now: Date.now(), requestId, answerKey: answerBlockKey(rowKey(requestId), block.id), turnId: observed.turnId, order: observed.order })
    })
    return changed ? { ...cur, questions } : cur
  })
  if (changed) {
    await publishGate($, token)
    await saveLedger($, token)
  }
}

// Every message the person typed is recorded before the model reads it: its provisional row key
// and a short head. Only the composer's rows count. A subagent's row carries agentId, and a
// hand-back or a notification comes in under its sender's origin; its row is never linked, so
// as the last prompt it left the next question with no [ Q ].
export async function recordPrompt($: EngineInterface, e: { agentId?: string; origin: { kind: string }; uuid: string }, text: string): Promise<void> {
  if (e.agentId !== undefined || e.origin.kind !== 'composer') {
    return
  }
  const head = headOf(text)
  if (head === '' || head.startsWith('/')) {
    return
  }
  const admissionEpoch = ownership.epoch
  const owned = await ensureOwner($)
  if (!owned.ok && !owned.isIdentity) {
    $.ui.log(`track: prompt row not recorded: ${owned.reason}`, { to: 'debug' })
    return
  }
  const token = owned.ok ? owned.token : undefined
  const assertProvisionalOwner = (): void => {
    if (!owned.ok && !isOwnerCurrent({ owner: undefined, epoch: admissionEpoch })) throw new OwnerChanged()
  }
  const session = await captureMintOwner($)
  const prompt: Prompt = { rowKey: rowKey(e.uuid), head, turnId: null, at: Date.now() }
  try {
    await updateOwnedLedger($, token, l => {
      assertProvisionalOwner()
      return { ...l, session_id: l.session_id ?? session, prompts: [...l.prompts, prompt].slice(-MAX_PROMPTS) }
    })
    // The newest input with these words and no row yet takes this row: its identity for a
    // source_request_id.
    await update($, pending, p => {
      assertOwner(token)
      assertProvisionalOwner()
      const target = [...p.inputs].reverse().find(i => i.rowKey === undefined && norm(i.head) === norm(head))
      return target === undefined ? p : { ...p, inputs: p.inputs.map(i => (i.id === target.id ? { ...i, rowKey: prompt.rowKey } : i)) }
    })
  } catch (error) {
    if (!(error instanceof OwnerChanged)) throw error
    $.ui.log('track: prompt tracking stopped: session owner changed during the call.', { to: 'debug' })
  }
}

// Haiku labels in flight, by input id, so Stop can wait briefly for one. Module memory: a reload
// stops the managed timer, and the input falls back to the wording check.
export const classifying = new Map<number, Promise<void>>()
// Labels scheduled but not yet started (TRACK-46 C2 review): with classifying, every id whose
// label is still coming. Module memory too: a reload cancels the timer and empties both.
export const labelScheduled = new Set<number>()

// An accepted Track row covers one uncovered input: the one its source names. source_request_id
// wins when both are given, as it does for the row's own link: it must be that input's own row.
// source_text matches its first line, the oldest first. With no source, a question covers the
// current turn's input only when its summary is that input's first line and no other waiting
// input shares it: one candidate alone is no evidence. Steps need a source. One question row
// covers one input: reusing an open row that already covers one covers no second.
// Steps, new or reused after saving, never cover a prompt Haiku called a question.
export async function coverInput($: EngineInterface, kind: 'question' | 'steps', source: { source_text?: unknown; source_request_id?: unknown; summary?: string; questionId?: number } = {}, token?: OwnerToken): Promise<void> {
  const currentId = (await read($, turn)).currentId
  if (currentId === null) return
  const row = typeof source.source_request_id === 'string' ? rowKey(source.source_request_id) : undefined
  const text = row === undefined && typeof source.source_text === 'string' ? headOf(source.source_text) : undefined
  if (text === undefined && row === undefined && kind === 'steps') return
  await update($, pending, p => {
    assertOwner(token)
    if (source.questionId !== undefined && p.inputs.some(i => i.questionId === source.questionId)) return p
    const fits = (i: PendingInput) => i.covered === undefined && (kind === 'question' || i.label !== 'question')
    let target: PendingInput | undefined
    if (row !== undefined) target = p.inputs.find(i => fits(i) && i.rowKey === row)
    else if (text !== undefined) target = p.inputs.find(i => fits(i) && norm(i.head) === norm(text))
    else if (source.summary !== undefined) {
      const named = ofTurn(p.inputs, currentId).filter(i => fits(i) && needsQuestion(i) && norm(i.head) === norm(source.summary!))
      target = named.length === 1 ? named[0] : undefined
    }
    return target === undefined ? p : { ...p, inputs: p.inputs.map(i => (i.id === target!.id ? { ...i, covered: kind, ...(source.questionId !== undefined && { questionId: source.questionId }) } : i)) }
  })
}


export async function classifierOn($: EngineInterface): Promise<boolean> {
  try {
    return ((await $.store.get(CLASSIFIER_KEY)) as { isOn?: unknown } | undefined)?.isOn === true
  } catch (error) {
    $.ui.log(`track: the classifier setting is unreadable, so it is off: ${reason(error)}`, { to: 'debug' })
    return false
  }
}

// One Haiku label for one input, written only while that input is still pending and unlabelled:
// an input an earlier turn left, or one a reload replaced, takes no late label.
export async function classifyInput($: EngineInterface, id: number, text: string, epoch: number): Promise<void> {
  let label: NonNullable<PendingInput['label']> = 'unknown'
  if (text.length <= CLASSIFIER_MAX_CHARS) {
    try {
      const r = await $.model.complete({ ...CLASSIFIER, prompt: text })
      const said = r.isAnswered ? r.text.trim() : ''
      if (said === 'question' || said === 'not_question') label = said
      else $.ui.log(`track: the classifier gave no label (${r.isAnswered ? 'malformed reply' : r.reason})`, { to: 'debug' })
    } catch (error) {
      $.ui.log(`track: the classifier failed: ${reason(error)}`, { to: 'debug' })
    }
  }
  if (epoch !== ownership.epoch) {
    $.ui.log('track: a classifier label from a previous session was dropped', { to: 'debug' })
    return
  }
  // A question label undoes coverage by new steps: steps never cover a question.
  await update($, pending, p => (p.inputs.some(i => i.id === id && i.label === undefined)
    ? { ...p, inputs: p.inputs.map(i => {
      if (i.id !== id) return i
      if (label === 'question' && i.covered === 'steps') {
        const { covered: _covered, ...rest } = i
        return { ...rest, label }
      }
      return { ...i, label }
    }) }
    : p))
  if (epoch === ownership.epoch) {
    try { await publishGate($, { owner: await $.session.id(), epoch }) }
    catch (error) {
      $.ui.log(`track: Stop snapshot unavailable: ${reason(error)}`, { to: 'debug' })
      noteEvent($, 'stop.snapshot_unavailable')
    }
  }
}
