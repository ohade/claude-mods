import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, PluginState, Register, RenderElement, RenderSurface } from 'claude-code'

import type { Pane, Pending, ScrollAt, Step, Turn } from '../types'
import { checksumOf } from './checkpoint'
import { visibleSteps, sameResultOwner } from './steps'
import { MAX_INPUTS } from './prompt-intake'
import { hasClock, runningClocks, isLifecycleNote, STEP_STATUSES } from './ledger-policy'
import { RESULT_CHARS, truncate } from './ledger-text'
import { wrappedLines, fitLines } from './terminal-text'
import { clampTo, clockText, questionLabels, buttonWidth } from './pane-layout'
import { paneRowMetrics } from './pane-row-metrics'
import { paneViewport } from './pane-viewport-model'
import { paneBanner } from './pane-banner-model'
import { paneRootView, paneItem } from './pane-root-view'
import type { BannerRow } from './banner-layout'
import { lookupPaneRows, visibleQuestions } from './pane-order'
import { answerBlocks, answerBlockKey } from './answer-blocks'
import { hideAnsweredQuestions } from './question-commands'
import { hideCompletedSteps } from './clear-commands'
import { diagnose } from './diagnose-flow'
import type { DiagnosePorts } from './diagnose-flow'
import { stepView } from './pane-step-view'
import { questionView } from './pane-question-view'
import type { QuestionRow } from './pane-question-view'
import { restoreKey } from './restore-records'

declare module 'claude-code' {
  interface EngineInterface {
    prismantis: {
      reply: (args: { surface: RenderSurface; requestId: string; text: string; isFirstOfReply: boolean; columns: number; segments: PrismantisSegment[] }) => Promise<RenderElement | undefined>
      tint: (args: { key: string; color: string | null }) => Promise<void>
    }
  }
}
// The rewind check a prompt-hint redraw schedules: run after this delay, at most once per gap.
// Module memory, not $.state: a reload only resets the debounce.
const REWIND_CHECK_DELAY_MS = 1000
const REWIND_CHECK_GAP_MS = 3000

const ledger = atom({ plugin: 'track', key: 'ledger' } as const, EMPTY_LEDGER)
const turn = atom({ plugin: 'track', key: 'turn' } as const, { currentId: null, gatedTurnId: null } as Turn)
const pane = atom({ plugin: 'track', key: 'pane' } as const, { isOpen: false, hidden: false, closedByPerson: false } as Pane)
const pending = atom({ plugin: 'track', key: 'pending' } as const, { inputs: [], nextId: 1 } as Pending)
// One level per transcript row (by its requestId, or `text:` and a key for an answer's text):
// 0 unlit, up to FLASH_SHADES.length at full. `lit` names the rows a jump lit.
const flash = atom({ plugin: 'track', key: 'flash' } as const, 0)
const lit = atom({ plugin: 'track', key: 'lit' } as const, [] as string[])
const renders = atom({ plugin: 'track', key: 'renders' } as const, { session: null, rows: [] } as { session: string | null; rows: [string, string][] })
const activity = atom({ plugin: 'track', key: 'activity' } as const, IDLE)
// Which restored question is expanded in the pane. Not part of the ledger: a checkpoint must not keep it.
const reveal = atom({ plugin: 'track', key: 'reveal' } as const, {} as Record<string, 'q' | 'a' | 'r' | undefined>)
const pulse = atom({ plugin: 'track', key: 'pulse' } as const, 0)
const tick = atom({ plugin: 'track', key: 'tick' } as const, 0)
// Each region's first shown row; null follows the news (the newest question, the step at work).
const scrollAt = atom({ plugin: 'track', key: 'scroll' } as const, { questions: null, steps: null } as ScrollAt)
// When the steps' "clear all" was pressed with unfinished steps; a second press within
// CLEAR_ARM_MS clears, and the pane draws the control as a red confirmation meanwhile. A timer
// ends the arm, so the pane redraws without a key press. Pane state only, never saved.
const clearArm = atom({ plugin: 'track', key: 'clearArm' } as const, null as number | null)
const durability = atom({ plugin: 'track', key: 'durability' } as const, { isUnsaved: false, reason: '' } as PluginState['track']['durability'])
import { PANE, TITLE, LOADED_IDENTITY, TRACK_QUESTION, MARK_ANSWERED, MARK_STEP, TRACK_STEPS, RESTORE_TRACKER, CHECKPOINT, LOOKUP_ROWS, REORDER_STEPS, EMPTY_LEDGER, IDLE, CLEAR_ARM_MS, rowKey, reason, acknowledgedLedger, eventRing, gateCache, configDir, sha256Hex, ownership, assertOwner, updateLedger } from './track-state'
import type { OwnerToken } from './track-state'
import { publishGate, saveLedger, saveClassifierSetting, savePanePreference, pendingCauseOf, migrateStore } from './ledger-store'
import { renderInstances, renderSaved, rememberRender, pressOwned, keepAnswerInstance, ensureOwner, observedDisk, identityLine } from './session-owner'
import { FRESHNESS_KINDS } from './turn-guidance'
import { rewindCheck, dropRewound, classifierOn } from './prompt-flow'
import { HOTKEYS, ROW_INDENT, pulsing, ticking, COMPACT_COLUMNS, HINT, NONE_YET, ALL_CLEARED, regions, SCROLL_FLUSH_MS, pendingScroll, ring, statusGlyph, shade, isPulsing, startPulse, startTick, jump, withdraw, scheduleAutoOpen, renderRestore, clearQuestions, clearSteps, openPane, reorderTrackedSteps } from './pane-actions'
import type { PrismantisSegment } from './pane-actions'
import { checkpointCall, lookupRowsCall, reorderStepsCall, trackQuestionCall, markAnsweredCall, trackStepsCall, restoreTrackerCall, markStepCall } from './track-tools'
import { ownedToolCall, taskCreateCall, taskUpdateCall, todoWriteCall, exitPlanModeCall, agentCall, askUserQuestionCall, bashCall } from './task-mirror'
import { sessionStartEvent, promptAppendEvent, deliveryAppendEvent, responseAppendEvent, responseTurnAppendEvent, turnStartEvent, promptComposeEvent, promptSubmitEvent, stopEvent, sessionCompactEvent, turnCompleteEvent, classicSessionStartEvent, sessionEndEvent } from './session-events'

const DIAGNOSE = 'mcp__track__diagnose'
const INPUT_CLAIM_KIND = 'uncovered_input'
// stop-gate.py claim_name: sha256 of the compact JSON [session, turn, kind].
const claimName = (session: string, turnId: string, kind: string): Promise<string> => sha256Hex(JSON.stringify([session, turnId, kind]))

// The helper's claim turn for a pending input; stop-gate.py builds the same string.
const inputClaimTurn = (id: number, epoch: string | undefined): string => epoch === undefined ? `input:${id}` : `input:${epoch}:${id}`
// D9: stat only the claim names this session and turn can own; contents are never read and the
// directory is never listed, so no other session is enumerated.
const claimStats = async ($: EngineInterface, session: string, turnId: string | null, heldInputs: number[], epoch?: string, legacy: readonly number[] = []): Promise<Array<{ name: string; kind: string; present: boolean }>> => {
  // CLAUDE_CONFIG_DIR wins, as in configDir; HOME is asked only when it is unset.
  let config: string | undefined
  try { config = (await $.env.get('CLAUDE_CONFIG_DIR')) || await configDir($) } catch { config = undefined }
  if (!config?.startsWith('/')) return []
  const wanted: Array<[string, string]> = [
    ...(typeof turnId === 'string' && turnId !== '' ? FRESHNESS_KINDS.map(kind => [turnId, kind] as [string, string]) : []),
    ...heldInputs.slice(0, MAX_INPUTS).map(id => [inputClaimTurn(id, legacy.includes(id) ? undefined : epoch), INPUT_CLAIM_KIND] as [string, string]),
  ]
  const stats: Array<{ name: string; kind: string; present: boolean }> = []
  for (const [claimTurn, kind] of wanted) {
    const name = await claimName(session, claimTurn, kind)
    let present = false
    // D9 lstat: a symbolic link never counts as a present claim, whatever it leads to.
    try {
      const stat = await $.fs.stat(`${config}/state/track/stop-holds/${kind === INPUT_CLAIM_KIND ? 'inputs/' : ''}${name}`)
      present = stat.kind === 'file' && stat.isLink !== true
    }
    catch { present = false }
    stats.push({ name, kind, present })
  }
  return stats
}

// D7-D11: diagnose-flow's native reads, built per call. isAdmitted reads `ownership` on each of its
// two calls; the durability read happens only when the ledger names no owner.
const diagnosePorts = ($: EngineInterface): DiagnosePorts => ({
  epoch: () => ownership.epoch,
  sessionId: () => $.session.id(),
  isAdmitted: async (epoch, id) => {
    if (ownership.running !== undefined || ownership.epoch !== epoch) return false
    return ((await read($, ledger)).session_id ?? (await read($, durability)).memorySession) === id
  },
  readLedger: () => read($, ledger),
  readTurn: () => read($, turn),
  readActivity: () => read($, activity),
  readPending: () => read($, pending),
  observedDisk: () => observedDisk($),
  claimStats: (session, turnId, heldInputs, epoch, legacy) => claimStats($, session, turnId, heldInputs, epoch, legacy),
  cachedGate: () => gateCache.last,
  events: () => eventRing,
  identity: LOADED_IDENTITY,
})

export const register: Register = on => {
  // Per-call eligibility crosses the handler/save boundary, then leaves memory.
  // It is decided inside the atom update, whose retries see concurrent marks.
  const reuseCalls = new Map<string, { step?: Step }>()
  const ownedCalls = new Map<string, OwnerToken>()
  // One restore owns its visible receipt and save through acknowledgement.
  // Other ledger writers still use atom compare-and-set; a changed ledger
  // during a mechanical receipt is refused instead of overwriting their work.
  let restoreQueue = Promise.resolve()
  on('tool.call', { tool: RESTORE_TRACKER }, async (_, e, next) => {
    if (next.origin.plugin === 'engine') return next(e)
    const run = restoreQueue.then(() => next(e))
    restoreQueue = run.then(() => undefined, () => undefined)
    return run
  })
  // Persist acknowledged tracking changes before their callers receive success.
  // This hook never runs from a redraw; UI mutations save in their own handlers.
  const mutationTools = new Set([TRACK_QUESTION, MARK_ANSWERED, TRACK_STEPS, MARK_STEP, RESTORE_TRACKER, 'TaskCreate', 'TaskUpdate', 'TodoWrite'])
  // Track-state tools refuse before their handler runs when the current session's rows are not selected.
  const ownedTools = new Set([...mutationTools, LOOKUP_ROWS, REORDER_STEPS])
  on('tool.call', ($, e, next) => ownedToolCall($, e, next, reuseCalls, ownedCalls, mutationTools, ownedTools))

  on('session.start', ($, e, next) => sessionStartEvent($, e, next))

  // The per-turn tools stay in the model's tool list; a deferred tool costs a ToolSearch round trip.
  on('tool.describe', { tool: TRACK_QUESTION }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: MARK_ANSWERED }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: TRACK_STEPS }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: MARK_STEP }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: RESTORE_TRACKER }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: CHECKPOINT }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', { tool: CHECKPOINT }, ($, e) => checkpointCall($, e))

  on('tool.call', { tool: DIAGNOSE }, async ($, e) => diagnose(diagnosePorts($), e))

  on('tool.call', { tool: LOOKUP_ROWS }, ($, e) => lookupRowsCall($, e))

  on('tool.call', { tool: REORDER_STEPS }, ($, e) => reorderStepsCall($, e, ownedCalls))

  on('session.append', { door: 'prompt' }, ($, e, next) => promptAppendEvent($, e, next))

  // A message typed while a turn runs is no prompt: the engine folds it into that turn as a
  // queued_command attachment, by the delivery door, and draws it under that row's id.
  on('session.append', { door: 'delivery' }, ($, e, next) => deliveryAppendEvent($, e, next))

  // Event order verifies a source, not whether its words answer the question.
  // A later response can move an explicit answer's call target to the same verified text;
  // it never supplies unknown answer words from narration.
  // TRACK-46 A1/C1 (iii): the observation belongs to the session whose memory saw the reply. A
  // session switch while it runs stops it, so a retry never ties the reply to the new session's
  // turn; the stored reply still flows on.
  on('session.append', { door: 'response' }, ($, e, next) => responseAppendEvent($, e, next))

  // A completed marker pair is the model's explicit answer identification. Capture
  // only a stored main-model response, never peer hand-backs, tool output or progress.
  // TRACK-46 A1/C1 (iii): the capture belongs to the session whose memory saw the reply. A
  // session switch while it runs stops it: question numbers repeat across sessions.
  on('session.append', { door: 'response' }, ($, e, next) => responseTurnAppendEvent($, e, next))

  on('turn.start', ($, e, next) => turnStartEvent($, e, next))

  // The standing rule: one byte-stable system-prompt section, appended last (scope `session`),
  // so the prompt cache holds across turns. Everything that changes per turn goes in the
  // prompt.submit context row instead.
  on('prompt.compose', ($, e, next) => promptComposeEvent($, e, next))

  // A question-like main prompt becomes a pending input. One typed while a turn runs carries that
  // turn's id; an idle one is bound by its turn.start or its Stop. A notification, a doorbell or
  // a request neither adds nor erases one. A prompt a hook dropped never reached the model.
  // Then the per-turn reminder: a short row beside the prompt, only while something is open.
  // One handler: the loader takes one prompt.submit hook without a matcher.
  on('prompt.submit', ($, e, next) => promptSubmitEvent($, e, next))

  // The gate: after the settings Stop hooks have run (and only when none of them blocked),
  // hold the turn once when a question the model tracked this turn is still open. The catch
  // replays the chain, so a failure here can never add or erase a block.
  on('classic.Stop', ($, e, next) => stopEvent($, e, next)).catch(($, e, next) => next(e))

  // Compaction removes old tool calls from the transcript; record when, so the rewind check
  // never mistakes compacted questions for rewound ones.
  on('session.compact', ($, e, next) => sessionCompactEvent($, e, next))

  // Each finished main-loop turn saves the ledger, so /resume finds it.
  on('turn.complete', ($, e, next) => turnCompleteEvent($, e, next))

  // The drawn row's requestId is the authoritative jump target, linked to the prompt whose row key
  // it carries and to no other. A fallback that gave an unmatched row (the engine's
  // `placeholder`, a redraw of an older prompt) to the first prompt still unlinked once sent
  // [ Q ] of the third prompt to the first. A later draw of the right row
  // repairs a wrong link. State is written from a timer: a write during a render is refused.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    if (e.surface !== 'terminal') {
      return drawn
    }
    // The mechanical restore's user row is for the model. It is not a jump target,
    // and a system notice has no documented render component (2026-10-08).
    if (e.props.origin.kind !== 'composer') return drawn
    // A jump to this prompt lights it, fading back over FLASH_HOLD_MS and the steps after it.
    const level = await read($, memberOf(flash, e))
    const { Box } = $.ui.resolve(e)
    const row = <Box key={`question:${rowKey(e.requestId)}`} backgroundColor={shade(level)}>{drawn}</Box>
    const l = await read($, ledger)
    const key = rowKey(e.requestId)
    const isLinked = (requestId: string | undefined) => requestId === e.requestId
    const stale = l.prompts.some(p => p.rowKey === key && !isLinked(p.requestId)) || l.questions.some(q => q.rowKey === key && !isLinked(q.askedRequestId))
    if (!stale) {
      return row
    }
    $.clock.after(0, () => {
      void updateLedger($, cur => ({
        ...cur,
        prompts: cur.prompts.map(p => (p.rowKey === key ? { ...p, requestId: e.requestId } : p)),
        questions: cur.questions.map(q => (q.rowKey === key ? { ...q, askedRequestId: e.requestId } : q)),
      }))
    })

    return row
  })

  on('tool.call', { tool: TRACK_QUESTION }, ($, e) => trackQuestionCall($, e, ownedCalls))

  on('tool.call', { tool: MARK_ANSWERED }, ($, e) => markAnsweredCall($, e, ownedCalls))

  // Steps come from the model's own tools, read after each call succeeds. A subagent's
  // calls are its own work, not the session's steps.
  on('tool.call', { tool: 'TaskCreate' }, ($, e, next) => taskCreateCall($, e, next, ownedCalls))

  on('tool.call', { tool: 'TaskUpdate' }, ($, e, next) => taskUpdateCall($, e, next, ownedCalls))

  on('tool.call', { tool: 'TodoWrite' }, ($, e, next) => todoWriteCall($, e, next, ownedCalls))

  on('tool.call', { tool: 'ExitPlanMode' }, ($, e, next) => exitPlanModeCall($, e, next))

  // The banner's inputs: an Agent call in flight, a background agent, a background shell task, a
  // question dialog for the person. A subagent's own calls are its work, not the session's.
  on('tool.call', { tool: 'Agent' }, ($, e, next) => agentCall($, e, next, ownedCalls))

  on('tool.call', { tool: 'AskUserQuestion' }, ($, e, next) => askUserQuestionCall($, e, next))

  on('tool.call', { tool: 'Bash' }, ($, e, next) => bashCall($, e, next, ownedCalls))

  // Explicit tracking creates plan rows; approving a plan never imports its text.
  on('tool.call', { tool: TRACK_STEPS }, ($, e) => trackStepsCall($, e, ownedCalls))

  // A handoff seeds a fresh session, whose pane starts empty. One call copies the old session's
  // steps and its questions from the store, keyed by its session id.
  // Steps already in the pane are kept unless the call asks to replace them. Task ids start again
  // in every session, so a restored step keeps no link to the old Task, and a Task step takes a
  // restored: id, leaving task:<n> to the new session's own Task.
  // Every question not cleared comes back after this session's own, with this session's next ids.
  // Its old row links are dropped, since those rows are in the old transcript; this call's row
  // shows it instead, drawn from a copy kept with the register, so clearing the pane leaves the
  // row as it was. A second call from the same session replaces those questions, never adds them
  // again.
  on('tool.call', { tool: RESTORE_TRACKER }, ($, e, next) => restoreTrackerCall($, e, next, ownedCalls))

  on('tool.call', { tool: MARK_STEP }, ($, e) => markStepCall($, e, reuseCalls, ownedCalls))

  on('command.run', { command: 'track' }, async ($, e) => {
    const arg = e.args.trim()
    // TRACK-46 A1/C1: a read-only answer first selects the current session, as tool calls do, so
    // it never reports the previous owner's rows. An identity outage still reads memory.
    const ownerRefusal = async (): Promise<string | undefined> => {
      const owned = await ensureOwner($)
      return !owned.ok && !owned.isIdentity ? `track: ${owned.reason}` : undefined
    }
    if (arg === 'order') {
      const refused = await ownerRefusal()
      if (refused !== undefined) return { text: JSON.stringify({ ok: false, reason: refused }) }
      return { text: JSON.stringify({ ok: true, rows: lookupPaneRows(await read($, ledger)) }) }
    }
    if (/^reorder(?:\s|$)/.test(arg)) {
      let ids: unknown
      try { ids = JSON.parse(arg.slice('reorder'.length).trim()) } catch {
        return { text: JSON.stringify({ ok: false, reason: 'Use /track reorder ["plan:2","plan:1"] with every visible permanent step id once. Read /track order first.' }) }
      }
      return { text: (await reorderTrackedSteps($, ids)).result }
    }
    const migration = /^(export|import) (.+)$/.exec(arg)
    if (migration !== null) return { text: await migrateStore($, migration[1] as 'export' | 'import', migration[2]!.trim()) }
    const classifier = /^classifier(?: (on|off))?$/.exec(arg)
    if (classifier !== null) {
      if (classifier[1] !== undefined) {
        try {
          await saveClassifierSetting($, classifier[1] === 'on')
        } catch (error) {
          return { text: `track: the classifier setting was not saved — ${reason(error)}` }
        }
      }
      return { text: (await classifierOn($))
        ? 'track: the Haiku question classifier is on. Each typed prompt costs one small Haiku call; /track classifier off stops it.'
        : 'track: the Haiku question classifier is off; the wording check decides. /track classifier on starts it.' }
    }
    if (arg === 'status') {
      const refused = await ownerRefusal()
      if (refused !== undefined) return { text: refused }
      const l = await read($, ledger)
      const open = l.questions.filter(q => q.status === 'open').map(q => `Q${q.id} ${q.head}`)

      return { text: `track: ${l.questions.length} questions (${open.length} open), ${l.steps.length} steps.${open.length > 0 ? `\nOpen: ${open.join('; ')}` : ''}\n${await identityLine($)}` }
    }
    const p = await read($, pane)
    if (p.isOpen) {
      await $.ui.close({ id: PANE })
      await update($, pane, cur => ({ ...cur, isOpen: false, hidden: true }))
      $.ui.toast('track: pane hidden for this session; /track shows it again.')

      return {}
    }
    await update($, pane, cur => ({ ...cur, hidden: false, closedByPerson: false }))
    await savePanePreference($, false)
    // openPane says so in a toast when the pane cannot be placed.
    await openPane($)

    return {}
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (closed.deny === undefined && e.id === PANE) {
      const byPerson = e.origin.kind === 'person'
      await update($, pane, cur => ({ ...cur, isOpen: false, closedByPerson: cur.closedByPerson || byPerson }))
      if (byPerson) {
        // The persistent off, as the diff panel's: later sessions do not auto-open it.
        await savePanePreference($, true)
      }
    }

    return closed
  })

  // A rewind puts the old prompt back in the box, which redraws the prompt hint; no event
  // marks the rewind itself. So a hint redraw schedules the rewind check, at most once per
  // REWIND_CHECK_GAP_MS, and the rewound question leaves the pane without a new prompt.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const now = await $.clock.now()
    if (!rewindCheck.isScheduled && now - rewindCheck.lastAt >= REWIND_CHECK_GAP_MS) {
      rewindCheck.isScheduled = true
      $.clock.after(REWIND_CHECK_DELAY_MS, () => {
        void (async () => {
          rewindCheck.lastAt = await $.clock.now()
          rewindCheck.isScheduled = false
          await dropRewound($)
        })()
      })
    }
    await scheduleAutoOpen($, e.viewport)

    return next(e)
  })

  // Not every build draws every prompt site, so the band above the prompt reports the layout too.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await scheduleAutoOpen($, e.viewport)

    return next(e)
  })

  on('classic.SessionStart', ($, e, next) => classicSessionStartEvent($, e, next)).catch(($, e, next) => {
    $.ui.log(`track: resume failed: ${reason(next.error)}`, { to: 'debug' })

    return next(e)
  })

  // Save the ledger at the end of the session; /clear starts a fresh one.
  on('session.end', ($, e, next) => sessionEndEvent($, e, next))

  // A collapsed ToolGroup draws no ToolUse children. Keep groups with current question sources
  // or restore snapshots expanded so those owned rows exist. Cleared sources do not hold it open.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const l = await read($, ledger)
    const ownsTarget = e.props.calls.some(call => call.tool_use_id !== undefined && (
      l.questions.some(q => q.cleared !== true && (
        (q.trackedBy === call.tool_use_id && q.askedRequestId === call.tool_use_id)
        || (q.answeredBy === call.tool_use_id && q.answerKey === call.tool_use_id)
        || q.restoredBy === call.tool_use_id
      ))
    ))
    return next(ownsTarget && !e.props.isExpanded ? { ...e, props: { ...e.props, isExpanded: true } } : e)
  })

  // The model's bookkeeping calls stay quiet in the transcript: track_question and track_steps
  // draw nothing; mark_answered draws one dim acknowledgement, separate from answer targets.
  // restore_tracker draws what it restored, so the person reads the old answers here.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if ((e.props.tool === MARK_STEP || e.props.tool === MARK_ANSWERED) && typeof e.props.output === 'string' &&
        (e.props.isErrored || e.props.isInterrupted || e.props.output.startsWith('No ') || e.props.output.startsWith('track:'))) {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>{e.props.output}</Text>
    }
    if (e.props.tool === TRACK_QUESTION) {
      const l = await read($, ledger)
      const q = l.questions.find(q => q.trackedBy === e.props.tool_use_id && q.askedRequestId === e.props.tool_use_id)
      if (q !== undefined) {
        const { Text } = $.ui.resolve(e)
        const level = await read($, memberOf(flash, e))
        return <Text dimColor backgroundColor={shade(level)}>{`${questionLabels(l.questions)(q.id)}. ${q.head}`}</Text>
      }
    }
    if (e.props.tool === TRACK_QUESTION || e.props.tool === TRACK_STEPS) {
      const { Box } = $.ui.resolve(e)

      return <Box />
    }
    if (e.props.tool === RESTORE_TRACKER) {
      const { Box } = $.ui.resolve(e)
      // Words come from the copy the call kept; labels follow the current pane.
      // A refused call kept none and draws nothing.
      const l = await read($, ledger)
      const restore = l.restores?.find(r => r.by === e.props.tool_use_id)
      if (restore === undefined) {
        return <Box />
      }
      rememberRender($, `restore:${restore.by}`, e.requestId)
      return renderRestore($, $.ui.resolve(e), restore, questionLabels(l.questions))
    }
    if (e.props.tool === MARK_STEP) {
      const { Box, Text } = $.ui.resolve(e)
      const input = (e.props.input ?? {}) as { id?: unknown; status?: unknown; result_text?: unknown }
      const status = STEP_STATUSES.find(one => one === input.status) ?? 'pending'
      const glyph = status === 'completed' ? '✓' : status === 'in_progress' ? '◧' : status === 'paused' ? '⏸' : status === 'waiting' ? '◆' : '◻'
      // Named as the pane names it, S<n> and the title: an id such as plan:10 can sit third in
      // the pane after an insert, and was read as S10.
      const id = String(input.id ?? '?')
      const l = await read($, ledger)
      const shown = visibleSteps(l.steps)
      const at = shown.findIndex(s => s.id === id)
      const step = shown[at]
      const name = step === undefined ? id : `S${at + 1}. ${truncate(step.subject, 60)}`
      const proposed = e.props.isRunning || e.props.isErrored || e.props.isInterrupted ||
        (typeof e.props.output !== 'string' && !l.steps.some(row => row.id === id))
      const label = `${proposed ? '◻' : glyph} ${name} ${status.replace('_', ' ')}${proposed ? ' (requested)' : ''}`
      // Proposed tool input is not an accepted result. Only the durable row
      // acknowledged for this source and these full words may draw it.
      const full = typeof input.result_text === 'string' ? input.result_text.trim() : undefined
      if (status !== 'completed' || full === undefined) return <Text dimColor>{label}</Text>
      const acknowledged = await read($, durability)
      const saved = acknowledgedLedger(l, acknowledged)?.steps.find(row => row.id === id)
      if (status === 'completed' && saved?.status === 'completed' && saved.resultRequestId === e.props.tool_use_id && saved.resultText !== undefined &&
          full !== undefined && saved.resultTextHash === await checksumOf(full) && !e.props.isRunning && !e.props.isErrored && !e.props.isInterrupted) {
        const key = `result:${e.props.tool_use_id}`
        rememberRender($, key, e.requestId)
        const level = await read($, memberOf(flash, { requestId: key }))
        const resultName = step !== undefined && sameResultOwner(step, saved) ? name : `${saved.id}. ${truncate(saved.subject, 60)}`
        return <Box flexDirection="column"><Text dimColor>{`${glyph} ${resultName} completed`}</Text><Box key={key} backgroundColor={shade(level)}><Text dimColor wrap="wrap">{full}</Text></Box></Box>
      }
      return <Text dimColor>{label}</Text>
    }
    if (e.props.tool === MARK_ANSWERED) {
      const { Box, Text } = $.ui.resolve(e)
      const input = (e.props.input ?? {}) as { id?: unknown; status?: unknown }
      const status = input.status === 'deferred' ? 'deferred' : 'answered'
      const level = await read($, memberOf(flash, e))
      const l = await read($, ledger)
      const questionLabel = questionLabels(l.questions)
      const q = l.questions.find(one => one.id === Number(input.id))
      const proposed = e.props.isRunning || e.props.isErrored || e.props.isInterrupted || (typeof e.props.output !== 'string' && q === undefined)
      const label = `${proposed ? '' : '✓ '}${questionLabel(String(input.id ?? '?'))}. ${status}${proposed ? ' (requested)' : ''}`
      if (q?.answeredBy === e.props.tool_use_id && q.answerKey === e.props.tool_use_id && q.answerText !== undefined) {
        return <Box flexDirection="column"><Text dimColor>{label}</Text><Box key={`answer:${q.answerKey}`} backgroundColor={shade(level)}><Text wrap="wrap">{q.answerText}</Text></Box></Box>
      }
      if (q !== undefined && q.status !== status) return <Text dimColor>{`${questionLabel(q.id)}. ${q.status}`}</Text>

      return level > 0 ? <Text backgroundColor={shade(level)}>{` ${label} `}</Text> : <Text dimColor>{label}</Text>
    }

    return next(e)
  })

  // The answer's text row alone. Each row reads only the
  // level kept under its own row key, so a jump redraws the lit row alone.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    rememberRender($, rowKey(e.requestId), e.requestId)
    const blocks = answerBlocks(e.props.text)
    if (blocks.length > 0 && e.props.isSummary !== true) {
      const { Box, Markdown, Text } = $.ui.resolve(e)
      const l = await read($, ledger)
      const parts: RenderElement[] = []
      const segments: PrismantisSegment[] = []
      let offset = 0
      for (const block of blocks) {
        const before = e.props.text.slice(offset, block.start).trim()
        if (before !== '') {
          parts.push(<Markdown key={`before:${block.start}`} text={before} />)
          segments.push({ kind: 'markdown', key: `before:${block.start}`, text: before })
        }
        const key = answerBlockKey(rowKey(e.requestId), block.id)
        const q = l.questions.find(one => one.answerKey === key && one.cleared !== true)
        if (q !== undefined) rememberRender($, key, e.requestId)
        if (q !== undefined && (q.answerInstance !== e.requestId || q.answerInstanceSession !== renderSaved.session)) keepAnswerInstance($, key, e.requestId)
        const level = q === undefined ? 0 : await read($, memberOf(flash, { requestId: key }))
        parts.push(<Box key={`answer:${key}`} backgroundColor={shade(level)}><Markdown text={block.text} /></Box>)
        segments.push({ kind: 'markdown', key: `answer:${key}`, text: block.text })
        if (q !== undefined) {
          const ack = `✓ ${questionLabels(l.questions)(q.id)}. answered`
          parts.push(<Text key={`ack:${key}`} dimColor>{ack}</Text>)
          segments.push({ kind: 'note', key: `ack:${key}`, text: ack })
        }
        offset = block.end
      }
      const after = e.props.text.slice(offset).trim()
      if (after !== '') {
        parts.push(<Markdown key="after-answers" text={after} />)
        segments.push({ kind: 'markdown', key: 'after-answers', text: after })
      }
      // Prismantis draws the reply in its own frame from Track's segments and keys; Track's own
      // tree stays for a session without it, or with one too old to draw segments.
      let themed: RenderElement | undefined
      try {
        themed = await $.prismantis.reply({ surface: e.surface, requestId: e.requestId, text: e.props.text, isFirstOfReply: e.props.isFirstOfReply === true, columns: e.viewport?.columns ?? 100, segments })
      } catch {
        themed = undefined
      }
      return themed ?? <Box flexDirection="column">{parts}</Box>
    }
    const level = await read($, memberOf(flash, { requestId: rowKey(e.requestId) }))
    const { Box } = $.ui.resolve(e)

    return <Box key={`answer:${rowKey(e.requestId)}`} backgroundColor={shade(level)}>{await next(e)}</Box>
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if ([TRACK_QUESTION, MARK_ANSWERED, TRACK_STEPS, MARK_STEP, RESTORE_TRACKER].includes(e.props.tool)) {
      const { Box } = $.ui.resolve(e)

      return <Box />
    }

    return next(e)
  })

  // A wheel tick moves the region under the pointer by a row; the scroll keys move the region
  // last scrolled. The pane body is pinned at its top (offset 0): its tree is as tall as the body,
  // and a body left scrolled down could otherwise never come back.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'person') {
      return next(e)
    }
    const row = e.pointer?.row
    const region =
      row === undefined
        ? regions.last
        : row >= regions.qTop && row < regions.qBottom
          ? 'questions'
          : row >= regions.sTop && row < regions.sBottom
            ? 'steps'
            : undefined
    if (region !== undefined) {
      regions.last = region
      pendingScroll[region] += e.by
      if (pendingScroll.timer === undefined) {
        pendingScroll.timer = $.clock.after(SCROLL_FLUSH_MS, () => {
          const moves = { questions: pendingScroll.questions, steps: pendingScroll.steps }
          Object.assign(pendingScroll, { questions: 0, steps: 0, timer: undefined })
          void update($, scrollAt, cur => ({
            questions: moves.questions === 0 ? cur.questions : clampTo(regions.qLast, (cur.questions ?? regions.qStart) + moves.questions),
            steps: moves.steps === 0 ? cur.steps : clampTo(regions.sLast, (cur.steps ?? regions.sStart) + moves.steps),
          })).catch(error => $.ui.log(`track: scroll write failed: ${reason(error)}`, { to: 'debug' }))
        })
      }
    }

    return next({ ...e, offset: 0 })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const l = await read($, ledger)
    const now = await read($, activity)
    const saved = await read($, durability)
    const isUnsaved = saved.isUnsaved
    const unsavedReason = saved.reason
    const phase = await read($, pulse)
    if (pulsing.timer === undefined && isPulsing(l, now)) {
      startPulse($)
    }
    // The tick is read so each one redraws the pane; the time itself is the clock's.
    await read($, tick)
    const opened = await read($, reveal)
    const clockRuns = runningClocks(l).length > 0
    if (ticking.timer === undefined && clockRuns) {
      startTick($)
    }
    const nowMs = clockRuns ? await $.clock.now() : 0
    // A step's clock: its time so far while it runs, how long it took once done.
    const clockOf = (s: Step): string =>
      s.startedAt === undefined ? '' : clockText((s.endedAt ?? Math.max(nowMs, s.startedAt)) - s.startedAt)
    const width = Math.max(1, e.props.bodyColumns)
    const compact = width < COMPACT_COLUMNS
    const rowIndent = compact ? 0 : ROW_INDENT
    const bodyRows = Math.max(8, e.props.scroll.bodyRows)
    const at = await read($, scrollAt)
    const titleLabel = fitLines(width < TITLE.length + 4 ? ' TRACK ' : ` ${TITLE.toUpperCase()} `, width, 1)
    const titleSide = Math.max(0, Math.floor((width - titleLabel.length) / 2))
    // Every uncleared row is listed in both placements; the pane body scrolls, so older rows
    // stay reachable above the newest (track_question scrolls the newest into view).
    // The rings count the rows shown: a cleared row leaves its ring too. A deferred answer still
    // waits, so it is not done, and clear completed keeps it.
    const questions = visibleQuestions(l.questions)
    const questionLabel = questionLabels(l.questions)
    // Opening brings that row into view once. Later wheel, key, and track_question
    // writes to scrollAt.questions win; the open row does not pin the window.
    const toggleReveal = async (id: number, side: 'q' | 'a', index: number) => {
      let opening = false
      await update($, reveal, cur => {
        const next = cur[String(id)] === side ? undefined : side
        opening = next !== undefined
        return { ...cur, [String(id)]: next }
      })
      if (opening) await update($, scrollAt, cur => ({ ...cur, questions: index }))
    }
    const qDone = questions.filter(q => q.status === 'answered').length
    const steps = visibleSteps(l.steps)
    const currentSteps = new Map(steps.map(step => [step.id, step]))
    const stepResults = new Map((acknowledgedLedger(l, saved)?.steps ?? [])
      .filter(step => {
        const current = currentSteps.get(step.id)
        return current?.status === 'completed' && current.resultText !== undefined && step.status === 'completed' &&
          step.resultText !== undefined && sameResultOwner(current, step)
      }).map(step => [step.id, step]))
    const resultReveals = new Map<string, string>()
    for (const current of steps) {
      const step = stepResults.get(current.id)
      if (current.status !== 'completed' || step === undefined || step.resultRequestId !== undefined || step.resultText === undefined || opened[`step-result:${step.id}`] !== 'r') continue
      const truncated = step.resultText.length === RESULT_CHARS && step.resultTextHash !== undefined && await checksumOf(step.resultText) !== step.resultTextHash
      resultReveals.set(step.id, step.resultText + (truncated ? '\n(saved result truncated at 1000 characters)' : ''))
    }
    const toggleResult = async (step: Step, index: number): Promise<void> => {
      let opening = false
      await update($, reveal, cur => {
        const key = `step-result:${step.id}`
        const next = cur[key] === 'r' ? undefined : 'r' as const
        opening = next !== undefined
        return { ...cur, [key]: next }
      })
      if (opening) await update($, scrollAt, cur => ({ ...cur, steps: index }))
    }
    const sDone = steps.filter(s => s.status === 'completed').length
    const clearAnsweredQuestions = () => pressOwned($, async token => {
      await updateLedger($, cur => {
        assertOwner(token, cur)
        return hideAnsweredQuestions(cur)
      })
      await publishGate($, token)
      await saveLedger($, token)
    })
    const clearCompletedSteps = () => pressOwned($, async token => {
      await updateLedger($, cur => {
        assertOwner(token, cur)
        return hideCompletedSteps(cur)
      })
      await publishGate($, token)
      await saveLedger($, token)
    })
    // The steps' two clear controls, above the steps and again below them. Both sit outside the
    // scrolling region, so a scroll never moves them. The copies share hotkeys: the engine lets the
    // later one win, and both do the same thing. Each is an item of its own, so a narrow pane wraps
    // between them instead of cutting one.
    // A header or bar item keeps its width; the header wraps between items.
    const item = (key: string, child: RenderElement) => paneItem({ Box, Button, Text }, key, child)
    const allLabel = compact ? 'all' : 'clear all'
    // While "clear all" is armed, both copies ask to confirm, in red, until the arm ends.
    const unfinishedSteps = l.steps.filter(s => s.status !== 'completed').length
    const armedAt = await read($, clearArm)
    // TRACK-46 A2: a reload keeps the atom but cancels the reset timer, so the window is checked
    // here too. An expired arm draws the ordinary label; it is left in place, because a press
    // already treats it as unarmed and a reset here could race that press's new arm.
    const armExpired = armedAt !== null && await $.clock.now() - armedAt >= CLEAR_ARM_MS
    const confirming = armedAt !== null && !armExpired && unfinishedSteps > 0
    // The arm ends once no unfinished step is left, so later unfinished steps need a fresh first
    // press. Only this arm is ended: a newer arm or a confirmed clear has already replaced it.
    if (armedAt !== null && unfinishedSteps === 0) $.clock.after(0, () => { void update($, clearArm, at => (at === armedAt ? null : at)) })
    const confirmLabel = compact ? 'confirm' : `confirm — clear ${unfinishedSteps} unfinished step${unfinishedSteps === 1 ? '' : 's'}`
    const stepsLabel = confirming ? confirmLabel : allLabel
    const doneLabel = compact ? 'done' : 'clear completed'
    const clearButtons = (suffix: '' | '-bottom') => [
      ...(l.steps.length > 0
        ? [item(`item-clear-steps${suffix}`, <Button key={`clear-steps${suffix}`} plain dimColor={!confirming} hotkey="s" label={stepsLabel} onPress={() => clearSteps($)}>{confirming ? <Text color="error">{confirmLabel}</Text> : allLabel}</Button>)]
        : []),
      item(`item-clear-completed${suffix}`, <Button key={`clear-completed${suffix}`} plain dimColor hotkey="c" label={doneLabel} onPress={clearCompletedSteps} />),
    ]
    const clearWidths = [l.steps.length > 0 ? buttonWidth('s', stepsLabel) : 0, buttonWidth('c', doneLabel)]
    const hints = compact ? [{ key: 'hint-hide', text: '/track hide' }, { key: 'hint-close', text: 'ctrl+x x close' }] : [{ key: 'hint', text: HINT }]

    const { work, openRows } = paneBanner({
      l, now, phase, isUnsaved, unsavedReason, pendingCause: isUnsaved ? pendingCauseOf(unsavedReason) : undefined,
      width, questions, steps, questionLabel,
    })
    const countLabel = (done: number, total: number) => {
      const full = ring(done, total)

      return compact && total > 0 ? `${full.split(' ')[0]} ${done}/${total}` : full
    }
    const qRing = countLabel(qDone, questions.length)
    const sRing = countLabel(sDone, steps.length)
    const qEmpty = l.questions.length === 0 ? NONE_YET : ALL_CLEARED
    const sEmpty = l.steps.length === 0 ? NONE_YET : ALL_CLEARED

    // The layout: the title, the two headers, the separator, the bottom bar and the banner take
    // fixed rows, a header or the bar as many as its items wrap onto; the two regions share the
    // room left, measured in wrapped lines.
    const metrics = paneRowMetrics({
      width, bodyRows, compact, rowIndent, clearWidths, hints, hasQuestions: l.questions.length > 0, hasSteps: l.steps.length > 0,
      allLabel, doneLabel, questions, steps, opened, resultReveals, qEmpty, sEmpty, questionLabel, clockOf,
    })
    const { roomy, titleRows, qWidth, qControlsRows, stepControlsRows, stepWidth, stepSubjectWidth } = metrics
    const fitted = paneViewport({ metrics, width, bodyRows, qRing, sRing, at, openRows, questionCount: questions.length, stepCount: steps.length })
    const bannerRows: BannerRow[] = fitted.bannerRows
    const { qHead, sHead, qRows, sRows, qLast, sLast, qStart, qEnd, sStart, sEnd, qHidden, sHidden } = fitted
    Object.assign(regions, {
      qTop: titleRows,
      qBottom: titleRows + qHead + qRows,
      sTop: titleRows + qHead + qRows,
      sBottom: titleRows + qHead + qRows + 1 + sHead + sRows,
      qStart,
      sStart,
      qLast,
      sLast,
    })
    const questionClear = l.questions.length > 0 && item('questions-clear', <Button key="clear-questions" plain dimColor hotkey="q" label={allLabel} onPress={() => clearQuestions($)} />)
    const answeredClear = l.questions.length > 0 && item('questions-clear-answered', <Button key="clear-answered" plain dimColor hotkey="a" label={doneLabel} onPress={clearAnsweredQuestions} />)
    const questionRows = questions.slice(qStart, qEnd).map((q, shownAt) => {
          const index = qStart + shownAt
          // The question is text, green once answered (a Button takes no color, so the question
          // is not one); the jumps are short buttons, [ Q ] to the prompt and [ A ] to the answer,
          // the answer in the primary style. An answered row puts its digit hotkey on [ A ], an
          // open row on [ Q ].
          const hotkey = index < HOTKEYS ? String(index + 1) : undefined
          const answered = q.status === 'answered'
          const color = answered ? 'success' : undefined
          // A link to another prompt's row (stored by an older version) offers no jump.
          // A drawn restore_tracker row is a real scroll target. A mechanical restore's
          // user row is hidden and its system notice has no render component, so [ Q ]
          // and [ A ] show the saved text in the pane. Nothing saved stays dim, with no toast.
          const linkedAt = q.askedRequestId !== undefined && (q.rowKey === undefined || rowKey(q.askedRequestId) === q.rowKey) ? q.askedRequestId : undefined
          const restoreInstance = q.restoredBy === undefined ? undefined : renderInstances.get(`restore:${q.restoredBy}`)
          const restoredOnly = linkedAt === undefined && restoreInstance === undefined && (q.restoredFrom !== undefined || q.restoredBy !== undefined)
          const askedAt = linkedAt ?? (restoredOnly ? undefined : q.restoredBy)
          const questionKey = linkedAt === undefined && q.restoredBy !== undefined && !restoredOnly ? restoreKey(q, 'q') : undefined
          const savedQuestion = q.head.trim() !== ''
          const savedAnswer = (q.answerText?.trim().length ?? 0) > 0
          // An answer recorded in this session keeps its native row even when the question was restored.
          const nativeAnswer = q.answerKey !== undefined
          const answerKey = nativeAnswer ? `answer:${q.answerKey}` : !restoredOnly && q.restoredBy !== undefined && q.status !== 'open' ? restoreKey(q, 'a') : undefined
          const ready = answered && savedAnswer && (restoredOnly || answerKey !== undefined)
          const hasAnswerAnchor = answerKey !== undefined || q.answerRequestId !== undefined || (restoredOnly && savedAnswer)
          const answerIds = q.answerKey !== undefined ? [q.answerKey] : answerKey !== undefined ? [answerKey] : []
          // A completed answer displayed by mark_answered owns its ToolUse row: the native
          // contract makes that call id the requestId, even before its first draw after reload.
          const answerInstance = q.answerKey === undefined ? restoreInstance
            : q.answerKey === q.answeredBy ? q.answerKey : renderInstances.get(q.answerKey) ?? (q.answerInstanceSession !== undefined && q.answerInstanceSession === renderSaved.session ? q.answerInstance : undefined)

          const questionControl: QuestionRow['question'] = restoredOnly && !savedQuestion
            ? { dimColor: true, onPress: () => undefined }
            : restoredOnly
              ? { hotkey: ready ? undefined : hotkey, onPress: () => toggleReveal(q.id, 'q', index) }
              : askedAt === undefined
                ? undefined
                : { hotkey: ready ? undefined : hotkey, onPress: () => jump($, [questionKey ?? askedAt], 'start', questionKey, questionKey === undefined ? undefined : restoreInstance) }
          const answerControl: QuestionRow['answer'] = nativeAnswer || !restoredOnly
            ? !hasAnswerAnchor
              ? undefined
              : { variant: ready ? 'primary' : undefined, dimColor: ready ? undefined : true, hotkey: ready ? hotkey : undefined, onPress: () => ready ? jump($, answerIds, 'start', answerKey, answerInstance) : undefined }
            : !savedAnswer
              ? { dimColor: true, onPress: () => undefined }
              : { variant: answered ? 'primary' : undefined, hotkey: ready ? hotkey : undefined, onPress: () => toggleReveal(q.id, 'a', index) }
          const headBudget = Math.max(1, qRows - qControlsRows)
          const headShown = fitLines(`${questionLabel(q.id)}. ${q.head}`, qWidth, headBudget)
          const revealRaw = opened[String(q.id)] === 'q' && savedQuestion ? q.head : opened[String(q.id)] === 'a' && savedAnswer && !nativeAnswer ? q.answerText : undefined
          // A short region still draws one cut line. An empty press is not an answer.
          const revealBudget = revealRaw === undefined ? 0 : Math.max(1, qRows - qControlsRows - wrappedLines(headShown, qWidth))
          const revealShown = revealRaw !== undefined ? fitLines(revealRaw, qWidth, revealBudget) : undefined
          return questionView({ Box, Button, Text }, {
            id: q.id, glyph: statusGlyph(q), color, dim: q.status === 'deferred',
            compact, rowIndent, width: qWidth, headShown,
            // revealRaw above supplies text only for the question and answer sides.
            reveal: revealShown === undefined ? undefined : { side: opened[String(q.id)] as 'q' | 'a', text: revealShown },
            question: questionControl, answer: answerControl,
            onWithdraw: () => withdraw($, q.id, l.session_id),
          })
        })
    const stepHeaderControls = l.steps.length > 0 && clearButtons('')
    const stepRows = steps.slice(sStart, sEnd).map((s, shownAt) => {
          const index = sStart + shownAt
          const lifecycle = s.status === 'paused' && s.note !== undefined && isLifecycleNote(s.note) ? s.note : undefined
          const resultRaw = resultReveals.get(s.id)
          const headShown = fitLines(`S${index + 1}. ${s.subject}`, stepSubjectWidth(s), Math.max(1, sRows - stepControlsRows(s) - (resultRaw === undefined ? 0 : 1)))
          const resultShown = resultRaw === undefined ? undefined : fitLines(resultRaw, stepWidth(s), Math.max(1, sRows - stepControlsRows(s) - wrappedLines(headShown, stepSubjectWidth(s))))
          // The follow-up note stays here: the pure view's source check reserves the word for state writes.
          const follow = s.followUp === true && <Text key={`s-follow-${s.id}`}>update status</Text>
          return stepView({ Box, Button, Text }, {
            step: s, index, lifecycle, phase, work, compact, rowIndent,
            result: stepResults.get(s.id), headShown, resultShown,
            width: stepWidth(s), subjectWidth: stepSubjectWidth(s),
            clockLabel: hasClock(s) ? clockOf(s) : undefined,
            follow,
            onToggleResult: toggleResult,
            onJumpResult: key => jump($, [key], 'start', key, renderInstances.get(key)),
          })
        })
    const bottomControls = clearButtons('-bottom')
    return paneRootView({ Box, Button, Text }, { width, bodyRows, roomy, titleLabel, titleSide, qDone, qTotal: questions.length, qRing, qHidden, qRows, qEmpty, sDone, sTotal: steps.length, sRing, sHidden, sRows, sEmpty, questionClear, answeredClear, stepHeaderControls, bottomControls, questionRows, stepRows, hints, bannerRows })
  })
}
