import { atom, read } from 'claude-code'
import type { EngineInterface, PluginState, Register, RenderElement, RenderSurface } from 'claude-code'

import type { Pane, Pending, ScrollAt, Step, Turn } from '../types'
import { MAX_INPUTS } from './prompt-intake'
import { diagnose } from './diagnose-flow'
import type { DiagnosePorts } from './diagnose-flow'

declare module 'claude-code' {
  interface EngineInterface {
    prismantis: {
      reply: (args: { surface: RenderSurface; requestId: string; text: string; isFirstOfReply: boolean; columns: number; segments: PrismantisSegment[] }) => Promise<RenderElement | undefined>
      tint: (args: { key: string; color: string | null }) => Promise<void>
    }
  }
}

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
import { PANE, LOADED_IDENTITY, TRACK_QUESTION, MARK_ANSWERED, MARK_STEP, TRACK_STEPS, RESTORE_TRACKER, CHECKPOINT, LOOKUP_ROWS, REORDER_STEPS, EMPTY_LEDGER, IDLE, reason, eventRing, gateCache, configDir, sha256Hex, ownership } from './track-state'
import type { OwnerToken } from './track-state'
import { observedDisk } from './session-owner'
import { FRESHNESS_KINDS } from './turn-guidance'
import type { PrismantisSegment } from './pane-actions'
import { checkpointCall, lookupRowsCall, reorderStepsCall, trackQuestionCall, markAnsweredCall, trackStepsCall, restoreTrackerCall, markStepCall } from './track-tools'
import { ownedToolCall, taskCreateCall, taskUpdateCall, todoWriteCall, exitPlanModeCall, agentCall, askUserQuestionCall, bashCall } from './task-mirror'
import { sessionStartEvent, promptAppendEvent, deliveryAppendEvent, responseAppendEvent, responseTurnAppendEvent, turnStartEvent, promptComposeEvent, promptSubmitEvent, stopEvent, sessionCompactEvent, turnCompleteEvent, classicSessionStartEvent, sessionEndEvent } from './session-events'
import { userMessageRender, trackCommand, paneClose, promptHintRender, abovePromptRender, toolGroupRender, toolUseRender, assistantMessageRender, toolResultRender, paneScroll, paneRender } from './ui-render'

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
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => userMessageRender($, e, next))

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

  on('command.run', { command: 'track' }, ($, e) => trackCommand($, e))

  on('ui.close', ($, e, next) => paneClose($, e, next))

  // A rewind puts the old prompt back in the box, which redraws the prompt hint; no event
  // marks the rewind itself. So a hint redraw schedules the rewind check, at most once per
  // REWIND_CHECK_GAP_MS, and the rewound question leaves the pane without a new prompt.
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => promptHintRender($, e, next))

  // Not every build draws every prompt site, so the band above the prompt reports the layout too.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => abovePromptRender($, e, next))

  on('classic.SessionStart', ($, e, next) => classicSessionStartEvent($, e, next)).catch(($, e, next) => {
    $.ui.log(`track: resume failed: ${reason(next.error)}`, { to: 'debug' })

    return next(e)
  })

  // Save the ledger at the end of the session; /clear starts a fresh one.
  on('session.end', ($, e, next) => sessionEndEvent($, e, next))

  // A collapsed ToolGroup draws no ToolUse children. Keep groups with current question sources
  // or restore snapshots expanded so those owned rows exist. Cleared sources do not hold it open.
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => toolGroupRender($, e, next))

  // The model's bookkeeping calls stay quiet in the transcript: track_question and track_steps
  // draw nothing; mark_answered draws one dim acknowledgement, separate from answer targets.
  // restore_tracker draws what it restored, so the person reads the old answers here.
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => toolUseRender($, e, next))

  // The answer's text row alone. Each row reads only the
  // level kept under its own row key, so a jump redraws the lit row alone.
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => assistantMessageRender($, e, next))

  on('ui.render', { component: 'ToolResult' }, ($, e, next) => toolResultRender($, e, next))

  // A wheel tick moves the region under the pointer by a row; the scroll keys move the region
  // last scrolled. The pane body is pinned at its top (offset 0): its tree is as tall as the body,
  // and a body left scrolled down could otherwise never come back.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, ($, e, next) => paneScroll($, e, next))

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => paneRender($, e))
}
