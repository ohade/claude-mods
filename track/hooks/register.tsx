import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, PluginState, Register, RenderElement, RenderSurface, Timer } from 'claude-code'

import type { Activity, Ledger, Pane, Pending, PendingInput, Question, Restore, ScrollAt, Step, Turn } from '../types'
import { appliedChecksum, checkpointFailure, checksumOf, describeCheckpoint, matchesCheckpoint } from './checkpoint'
import type { Checkpoint } from './checkpoint'
import { deploymentDriftMessage } from './deploy-drift'
import { visibleSteps, openStepsOf, openPlanSteps, sameResultOwner } from './steps'
import { MAX_INPUTS, admitInput } from './prompt-intake'
import { unregisteredContext, promptContext, remainingNotices } from './prompt-context'
import { gateable, looksLikeQuestion, needsQuestion } from './turn-policy'
import { cancelReasonOf, cancelOwner } from './cancel-policy'
import { launchOwner, agentLaunchOwner, ownersForLiveSteps, rememberOwner, rememberLaunch } from './task-ownership'
import { MAX_STEPS, withStatus, hasClock, runningClocks, isLifecycleNote, STEP_STATUSES, MAX_QUESTIONS, keepRestores } from './ledger-policy'
import { HEAD_CHARS, RESULT_CHARS, truncate, headOf } from './ledger-text'
import { savedLedger } from './stored-codecs'
import { toolContracts } from './tool-contracts'
import { wrappedLines, fitLines } from './terminal-text'
import { clampTo, clockText, questionLabels, buttonWidth } from './pane-layout'
import { paneRowMetrics } from './pane-row-metrics'
import { paneViewport } from './pane-viewport-model'
import { paneBanner } from './pane-banner-model'
import { paneRootView, paneItem } from './pane-root-view'
import type { BannerRow } from './banner-layout'
import { lookupPaneRows, reorderVisibleSteps, visibleQuestions } from './pane-order'
import { sameRecord as sameValue } from './durable-record'
import { answerBlocks, answerBlockKey } from './answer-blocks'
import { questionAdmission, questionSource, mintQuestion, withdrawQuestion, clearQuestionRows, hideAnsweredQuestions, mayMarkAnswer, markQuestion } from './question-commands'
import { planStepClear, hideCompletedSteps } from './clear-commands'
import { planInsertion, insertPlan, replacePlan, markStep, delegationError } from './step-commands'
import { createTask, updateTask, replaceTodos } from './task-sync-commands'
import { diagnose } from './diagnose-flow'
import type { DiagnosePorts } from './diagnose-flow'
import { workState } from './work-appearance'
import { stepView } from './pane-step-view'
import { questionView } from './pane-question-view'
import type { QuestionRow } from './pane-question-view'
import { NOT_SAVED, counted, restoreStepCount, restoreNotice, restoreKey } from './restore-records'
import { restoreSource } from './restore-source'
import { proposeRestore } from './restore-proposal'


type PrismantisSegment = { kind: 'markdown' | 'note'; key: string; text: string }

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
// The built-in diff panel's rule, less its git condition (the tracker does not need git, and a
// session often starts outside a repository): it opens by itself only from this width, in the
// fullscreen layout, and never after the person closed it by hand.
const AUTO_OPEN_MIN_COLUMNS = 144
const AUTO_OPEN_DELAY_MS = 50
const autoOpen = { isScheduled: false }

const HOTKEYS = 9
// Rows sit this many columns in under their section header, questions and steps alike.
const ROW_INDENT = 2

// A jump lights the row it lands on, then fades it: the background at each level, brightest
// last, held FLASH_HOLD_MS at full and stepped down every FLASH_STEP_MS.
const FLASH_SHADES = ['#2b2a1e', '#4a4120', '#6e5a1c'] as const
const FLASH_HOLD_MS = 1200
const FLASH_STEP_MS = 250
// The fade's own timers, a generation per jump, and one queue every flash and lit write runs
// through in order, so a fade step already under way cannot clear a newer jump's lit list.
// Module memory, as a reload only cuts a fade short; session.start puts out what is left.
const fade = { timers: [] as Timer[], generation: 0, queue: Promise.resolve() as Promise<void> }

// An organization's managed plugin can bypass prompt.compose (the debug log then reads "track:
// prompt.compose bypassed by <plugin>"), and a /retro ran its steps unlisted. While the rule has
// not reached the model this session, each prompt that can start work carries the steps
// instruction beside it.
const STEPS_LINE = RULE

// The step in progress breathes while work runs: one phase every PULSE_MS, a
// spinner and grey shades while the main session works, an hourglass and amber shades while it
// waits on agents. The phase is $.state, so each tick redraws the pane alone.
const PULSE_MS = 400
const PULSE_PHASES = 12

const pulsing: { timer?: Timer } = {}
// Each step row ends in its wall clock. It moves every second under an hour, then once a minute.
const TICK_MS = 1000
const HOUR_MS = 3_600_000
const ticking: { timer?: Timer } = {}

// Below this width the Q/A columns crowd out the question; place them on the next line.
const COMPACT_COLUMNS = 40
const HINT = '/track hides · ctrl+x x closes for good'
const NONE_YET = '  None yet.'
const ALL_CLEARED = '  all cleared'
const regions = { qTop: 0, qBottom: 0, sTop: 0, sBottom: 0, qStart: 0, sStart: 0, qLast: 0, sLast: 0, last: 'steps' as 'questions' | 'steps' }
// Fast wheel ticks are summed and written once per SCROLL_FLUSH_MS, so a quick flick costs one
// state write and one redraw, not one per tick (one write per tick made the pane lag).
const SCROLL_FLUSH_MS = 30
const pendingScroll: { questions: number; steps: number; timer?: Timer } = { questions: 0, steps: 0 }

const refusePlanReplacement = (steps: ReturnType<typeof openPlanSteps>) => {
  const rows = steps.map(s => `${s.id} ${JSON.stringify(s.subject)} (${s.status})`).join('; ')
  return { result: `Cannot replace unfinished plan steps: ${rows}. Reuse them or insert with after; pass replace: true only for an intentional replacement.` }
}

// A replacement plan reuses plan:1, even when its title is unchanged. Give
// each new row its own logical identity; sourceId already survives restore.
const newPlanStep = (id: string, subject: string): Step => ({
  id, source: 'plan', subject, status: 'pending', sourceId: `plan:${crypto.randomUUID()}`,
})

// A background task's id in its notification text.
const TASK_ID = /<task-id>([^<]+)<\/task-id>/g
// CC-179, 2026-10-10: a rejected or unrelated Track call counted as tracking a question, one
// excerpt was kept and every later prompt overwrote it. Each question-like main prompt is now a
// pending input until an accepted row covers it: a question created or reused for it, or new steps.
// The pending atom, not the turn atom: a turn-atom write retries forever against a test that pins
// the turn version. $.state survives a mod reload; module memory did not.
// Round 2 (Codex's review of 12e11c8): an unresolved input stays until a row covers it, across
// turns; it is held once, then named on each later prompt. At the cap a covered input leaves
// first, then one Haiku called not_question; with none, the new prompt is not recorded, with a
// toast. Never an unresolved one.
// How long Stop waits for a Haiku label already in flight.
const STOP_JOIN_MS = 2000
// TODO(CC-179): one label per message cannot count two questions inside it; that needs span
// extraction (Codex's plan, out of scope here).
const dropFinishedOwners = async ($: EngineInterface, token?: OwnerToken): Promise<void> => {
  const steps = (await read($, ledger)).steps
  await update($, activity, a => {
    assertOwner(token)
    if (a.owners === undefined) return a
    const owners = ownersForLiveSteps(a.owners, steps)
    return JSON.stringify(owners) === JSON.stringify(a.owners) ? a : { ...a, owners }
  })
}
const applyCancel = async ($: EngineInterface, owners: string[], ran: { result?: unknown; deny?: unknown; text?: unknown; isError?: boolean }, token?: OwnerToken): Promise<void> => {
  const reasonNote = cancelReasonOf(ran)
  if (reasonNote === undefined || owners.length === 0) return
  const currentId = (await read($, turn)).currentId
  const now = await $.clock.now()
  const owned = new Set(owners)
  let changed = false
  await updateOwnedLedger($, token, cur => {
    changed = false
    const steps = cur.steps.map(s => {
      if (!owned.has(s.id) || s.cleared === true || s.status !== 'in_progress' || s.activeTurnId !== currentId) return s
      changed = true
      return { ...withStatus(s, 'paused', now), note: reasonNote }
    })
    return changed ? { ...cur, steps } : cur
  })
  if (!changed) return
  await saveLedger($, token)
  await dropFinishedOwners($, token)
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

// The engine's words around a message typed mid-turn, if the delivered row carries them; they
// are not the person's, and would hide a slash command from the check on the head.
const MIDTURN_FRAME = /^\s*(<system-reminder>\s*)?The user sent a new message while you were working:\s*/


// Ring glyph for a completion fraction; `○ —` when there is nothing to count.
const ring = (done: number, total: number): string => {
  if (total === 0) return '○ —'
  const pct = Math.round((100 * done) / total)
  const glyph = pct >= 100 ? '●' : pct >= 75 ? '◕' : pct >= 50 ? '◑' : pct >= 25 ? '◔' : '○'

  return `${glyph} ${done} of ${total} · ${pct}%`
}



const statusGlyph = (q: Question): string => (q.status === 'answered' ? '●' : q.status === 'deferred' ? '◌' : '○')

const shade = (level: number): string | undefined => (level > 0 ? FLASH_SHADES[Math.min(level, FLASH_SHADES.length) - 1] : undefined)

// Prismantis draws a message inside its own fill, which covers Track's outer shade, so the same
// level is handed to it under the key its drawing reads: answer:<answerKey> for an answer block,
// the full native request id for a plain reply or a prompt. Without Prismantis the call throws
// and Track's own shade is the highlight. A plain answer's answerKey is its bare row key, so the
// row-key test runs first: that reply is tinted under its drawn host, never answer:<row>.
const ROW_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/
const tintKey = (l: Ledger, id: string): string | undefined => {
  if (ROW_KEY.test(id)) {
    const host = renderInstances.get(id)
    return host !== undefined && rowKey(host) === id ? host : undefined
  }
  return l.questions.some(q => q.answerKey === id) ? `answer:${id}` : id
}

const light = async ($: EngineInterface, id: string, level: number): Promise<void> => {
  await update($, memberOf(flash, { requestId: id }), () => level)
  const key = tintKey(await read($, ledger), id)
  if (key === undefined) return
  try {
    await $.prismantis.tint({ key, color: shade(level) ?? null })
  } catch {
    return
  }
}



// Background work pulses even beside a user wait or a main turn. Main work alone pulses
// only a step in progress; an open question dialog is not evidence of main work.
const isPulsing = (l: Ledger, now: Activity): boolean => {
  const state = workState(l, now)

  return now.background.length > 0 || (now.tasks ?? []).length > 0 || state === 'agents' || state === 'tasks' || (state === 'working' && l.steps.some(s => s.status === 'in_progress' && s.cleared !== true))
}

// Started from the pane's drawing when a step should pulse; each tick stops it once nothing does.
const startPulse = ($: EngineInterface): void => {
  pulsing.timer = $.clock.every(PULSE_MS, () => {
    void (async () => {
      if (!isPulsing(await read($, ledger), await read($, activity))) {
        pulsing.timer?.cancel()
        pulsing.timer = undefined

        return
      }
      await update($, pulse, n => (n + 1) % PULSE_PHASES)
    })().catch(error => $.ui.log(`track: pulse tick failed: ${reason(error)}`, { to: 'debug' }))
  })
}

// Started from the pane's drawing while a step's clock runs; each tick stops it once none does.
// Past an hour every running clock shows minutes, so a tick writes only when the minute turns.
const startTick = ($: EngineInterface): void => {
  ticking.timer = $.clock.every(TICK_MS, () => {
    void (async () => {
      const running = runningClocks(await read($, ledger))
      if (running.length === 0) {
        ticking.timer?.cancel()
        ticking.timer = undefined

        return
      }
      const now = await $.clock.now()
      const last = await read($, tick)
      const everyMinute = running.every(s => now - (s.startedAt ?? now) >= HOUR_MS)
      if (everyMinute && Math.floor(now / 60_000) === Math.floor(last / 60_000)) {
        return
      }
      await update($, tick, () => now)
    })().catch(error => $.ui.log(`track: clock tick failed: ${reason(error)}`, { to: 'debug' }))
  })
}

// Runs a flash or lit write after every write queued before it.
const serially = (op: () => Promise<void>): Promise<void> => {
  const run = fade.queue.then(op)
  fade.queue = run.catch(() => undefined)

  return run
}

// Lights the rows a jump lands on and fades them out; a new jump puts out the last one first.
// A fade step of an older jump finds a newer generation and leaves the rows to it.
const flashRows = async ($: EngineInterface, ids: string[]): Promise<void> => {
  for (const timer of fade.timers) timer.cancel()
  fade.timers = []
  const generation = ++fade.generation
  await serially(async () => {
    const before = await read($, lit)
    await update($, lit, () => ids)
    await Promise.all([...before.filter(id => !ids.includes(id)).map(id => light($, id, 0)), ...ids.map(id => light($, id, FLASH_SHADES.length))])
  })
  if (fade.generation !== generation) {
    return
  }
  for (let level = FLASH_SHADES.length - 1; level >= 0; level--) {
    const at = FLASH_HOLD_MS + (FLASH_SHADES.length - 1 - level) * FLASH_STEP_MS
    fade.timers.push(
      $.clock.after(at, () => {
        void serially(async () => {
          if (fade.generation !== generation) return
          await Promise.all(ids.map(id => light($, id, level)))
          if (level === 0 && fade.generation === generation) await update($, lit, () => [])
        }).catch(error => $.ui.log(`track: fade to level ${level} failed: ${reason(error)}`, { to: 'debug' }))
      }),
    )
  }
}

// Scrolls the transcript to the first target row, then lights the rows. The scroll starts first:
// a transcript row moves only while the plugin answers the person's own input, a Button press
// here, so it must not wait behind the state writes. A refusal is a toast. The debug line
// carries the scroll's exact arguments.
const jump = async ($: EngineInterface, ids: string[], block: 'start' | 'end', key?: string, instance?: string): Promise<void> => {
  // 2026-10-08 native A clicks proved that Box keys resolve only inside plugin sites,
  // not transcript rows. Reveal the exact host; the flash still selects only its text.
  // A missing host never falls back to the acknowledgement or a guessed transcript key.
  if (key !== undefined && instance === undefined) {
    $.ui.toast('track: cannot jump — the source row has not been drawn on this load')
    return
  }
  const target = { to: { requestId: instance ?? ids[0] as string }, block }
  $.ui.log(`track: jump ${JSON.stringify(target)}`, { to: 'debug' })
  const moving = $.ui.scroll(target).then(
    moved => moved,
    (error: unknown) => ({ deny: reason(error) }),
  )
  await flashRows($, ids)
  const moved = await moving
  if (moved.deny !== undefined) {
    $.ui.toast(`track: cannot jump — ${moved.deny}`)
  }
}

// ✕ on a question: it leaves the ledger and both counts, and the next prompt tells the
// model not to answer it. The Stop gate stops holding the turn for it, as it is gone.
// TRACK-46 A1/C1: the ✕ names the session whose row it was drawn for. Question numbers repeat
// across sessions, so a press drawn for another session's row withdraws nothing.
const withdraw = ($: EngineInterface, id: number, drawnFor: string | undefined): Promise<void> => pressOwned($, async token => {
  let outcome = 'missing' as 'withdrawn' | 'missing' | 'other session'
  await updateLedger($, cur => {
    assertOwner(token, cur)
    const q = cur.questions.find(one => one.id === id)
    outcome = cur.session_id !== drawnFor ? 'other session' : q === undefined ? 'missing' : 'withdrawn'
    return outcome === 'withdrawn' && q !== undefined ? withdrawQuestion(cur, id, q.head) : cur
  })
  if (outcome === 'other session') $.ui.toast(`track: Q${id} was drawn for another session; nothing was removed.`)
  if (outcome !== 'withdrawn') return
  await publishGate($, token)
  await saveLedger($, token)
  $.ui.toast(`track: Q${id} removed; the model is told on your next prompt.`)
})

// Called from a prompt redraw, which only draws: the cheap viewport test runs here, and the
// store read and the open run from a timer, where state may be written.
const scheduleAutoOpen = async ($: EngineInterface, viewport: { columns?: number; isFullscreen?: boolean } | undefined): Promise<void> => {
  if (autoOpen.isScheduled || viewport?.isFullscreen !== true || (viewport.columns ?? 0) < AUTO_OPEN_MIN_COLUMNS) {
    return
  }
  const p = await read($, pane)
  if (p.isOpen || p.hidden || p.autoOpenDone === true) {
    return
  }
  autoOpen.isScheduled = true
  $.clock.after(AUTO_OPEN_DELAY_MS, () => {
    void (async () => {
      // A refused explicit choice lives in reload-persistent state until its
      // save succeeds. The older store flag cannot reverse that choice.
      const pending = (await read($, durability)).closedByPerson
      const closedByPerson = pending ?? ((await $.store.get('closedByPerson')) === true)
      if (closedByPerson) {
        await update($, pane, cur => ({ ...cur, closedByPerson, autoOpenDone: true as const }))
      } else {
        await openPane($)
        await update($, pane, cur => ({ ...cur, autoOpenDone: true as const }))
      }
    })().finally(() => {
      autoOpen.isScheduled = false
    })
  })
}
const durability = atom({ plugin: 'track', key: 'durability' } as const, { isUnsaved: false, reason: '' } as PluginState['track']['durability'])
import { PANE, TITLE, PANE_COLUMNS, PANE_ROWS, LOADED_IDENTITY, TRACK_QUESTION, MARK_ANSWERED, MARK_STEP, TRACK_STEPS, RESTORE_TRACKER, CHECKPOINT, LOOKUP_ROWS, REORDER_STEPS, SESSION_ID, MAX_PLAN_STEPS, STEP_RESULT, STEPS, ANSWER, RULE, AGENT_TASK, EMPTY_LEDGER, IDLE, CLEAR_ARM_MS, rowKey, textOf, reason, persistence, writer, acknowledgedLedger, eventRing, noteEvent, gateCache, freshTurn, configDir, sha256Hex, ownership, OwnerChanged, isOwnerCurrent, assertOwner, updateLedger, updateOwnedLedger } from './track-state'
import type { OwnerToken } from './track-state'
import { closeLock } from './writer-lock'
import { publishGate, readBodySnapshot, saveLedger, saveClassifierSetting, savePanePreference, historyEnabled, pendingCauseOf, savePendingCause, saveFailureText, historySnapshot, migrateStore } from './ledger-store'
import { renderInstances, renderSaved, rememberRender, captureMintOwner, memoryToken, pressOwned, ownerChangedResult, isFailedCheckpointResult, restoreOwnerChangedResult, keepAnswerInstance, switchOwner, ensureOwner, observedDisk, identityLine } from './session-owner'
import { stepReceiptIds, recordWork, ACTIVE_STEP_NUDGE, dueActiveStepNudge, FRESHNESS_KINDS, freshnessNudge, nudgeFed, missingResultText, nudgeMissingResults, remindFinishedTurn, readStopInventory, inventoryDrops, finishTasks, stepStop, claimUncoveredInputs } from './turn-guidance'
import { rewindCheck, recordTranscriptBaseline, dropRewound, observeResponse, captureResponse, recordPrompt, classifying, labelScheduled, coverInput, classifierOn, classifyInput, forgetTranscriptBaseline } from './prompt-flow'





const renderRestore = async ($: EngineInterface, ui: ReturnType<EngineInterface['ui']['resolve']>, r: Restore, label: (id: number) => string): Promise<RenderElement> => {
  const { Box, Text } = ui
  const rows = await Promise.all(r.questions.map(async q => {
    const questionKey = restoreKey({ ...q, restoredBy: q.restoredBy ?? r.by }, 'q')
    const answerKey = restoreKey({ ...q, restoredBy: q.restoredBy ?? r.by }, 'a')
    const questionLevel = await read($, memberOf(flash, { requestId: questionKey }))
    const answerLevel = await read($, memberOf(flash, { requestId: answerKey }))
    const below = q.status === 'answered' ? (q.answerText ?? NOT_SAVED) : q.status === 'deferred' ? q.note : undefined
    return (
      <Box key={`restored-${q.id}`} flexDirection="column" marginLeft={ROW_INDENT}>
        <Box key={questionKey} backgroundColor={shade(questionLevel)} flexDirection="row" columnGap={1}>
          <Box flexShrink={1}>
            <Text color={q.status === 'answered' ? 'success' : undefined} dimColor={q.status === 'deferred'} wrap="wrap">{`${label(q.id)}. ${q.head}`}</Text>
          </Box>
          <Text dimColor>{q.status}</Text>
        </Box>
        {below !== undefined && (
          <Box key={answerKey} backgroundColor={shade(answerLevel)} marginLeft={ROW_INDENT}>
            <Text dimColor={below === NOT_SAVED} wrap="wrap">{below}</Text>
          </Box>
        )}
      </Box>
    )
  }))
  const count = r.visibleSteps === undefined ? `${r.steps} saved ${r.steps === 1 ? 'step' : 'steps'}` : restoreStepCount(r)
  return <Box flexDirection="column"><Text bold>{`Restored from the previous session: ${count}, ${counted(r.questions.length, 'question')}`}</Text>{rows}</Box>
}



// Clear all, per section. Unlike Clear completed, the rows leave and the ring restarts. Open
// and deferred questions are withdrawn, so the model is told not to answer them; ids go on
// counting up, so a later Q<n> never reuses one the model saw.
const clearQuestions = ($: EngineInterface): Promise<void> => pressOwned($, async token => {
  await updateLedger($, cur => {
    assertOwner(token, cur)
    return clearQuestionRows(cur)
  })
  await publishGate($, token)
  await saveLedger($, token)
  $.ui.toast('track: questions cleared; open ones are withdrawn on your next prompt.')
})

const clearSteps = ($: EngineInterface): Promise<void> => pressOwned($, async token => {
  const now = await $.clock.now()
  // Read with its version, so the arm below goes live only if nothing wrote clearArm since this read.
  const held = await $.state.get({ plugin: 'track', key: 'clearArm' })
  const armedAt = held.value ?? null
  const armed = armedAt !== null && now - armedAt < CLEAR_ARM_MS
  let arming = false
  // Decided on the steps this same write removes, so a step reopened meanwhile is never cleared
  // without a confirming press (refuter R16 finding 7).
  await updateLedger($, cur => {
    assertOwner(token, cur)
    const decision = planStepClear(cur, armed)
    arming = decision.arming
    return decision.ledger
  })
  if (arming) {
    // One compare-and-set, never retried: a reset that landed meanwhile wins and this press arms nothing.
    const { isSet } = await $.state.set({ plugin: 'track', key: 'clearArm' }, now, { ifVersion: held.version })
    if (isSet) $.clock.after(CLEAR_ARM_MS, () => { void update($, clearArm, at => (at === now ? null : at)) })
    return
  }
  await update($, clearArm, () => null)
  await saveLedger($, token)
  await publishGate($, token)
  $.ui.toast('track: steps cleared.')
})

const openPane = async ($: EngineInterface): Promise<boolean> => {
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS, rows: PANE_ROWS })
  await update($, pane, p => ({ ...p, isOpen: opened.isPlaced }))
  if (!opened.isPlaced) {
    $.ui.toast(`track: the pane did not open — ${opened.reason}`)
  }

  return opened.isPlaced
}

// Whether the drift status shows: while it does, each main turn's end checks
// again, so a land clears it; with none, a session checks at start alone.
const deployDrift = { isShown: false }

// CC-159, 2026-10-10: tested main changes repeatedly remained absent from live.
// Engine calls must stay in this file for the native capability scanner.
const checkDeployDrift = async ($: EngineInterface): Promise<void> => {
  const deadline = Date.now() + 2000
  let isShowing = false
  try {
    const home = await $.env.get('HOME')
    if (!home?.startsWith('/')) return
    const repo = `${home}/git/claude-mods`
    const live = `${home}/git/worktrees/claude-mods/live`
    const git = (path: string, args: string[]) => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('drift check deadline reached')
      return $.process.run(['git', '-C', path, ...args], { timeoutMs: remaining, cwd: repo })
    }
    const [main, deployed, receiptText] = await Promise.all([
      git(repo, ['rev-parse', '--verify', 'refs/heads/main']),
      git(live, ['rev-parse', '--verify', 'HEAD']),
      $.fs.read(`${home}/.claude/state/claude-mods-live.json`),
    ])
    if (main.exitCode !== 0 || deployed.exitCode !== 0) return
    const mainHead = main.stdout.trim()
    const liveHead = deployed.stdout.trim()
    const message = deploymentDriftMessage(mainHead, liveHead, receiptText)
    if (message === undefined) return
    const ancestry = await git(repo, ['merge-base', '--is-ancestor', liveHead, mainHead])
    if (ancestry.exitCode !== 0 || Date.now() > deadline) return
    $.ui.status(message)
    isShowing = true
  } catch {
    // Advisory only: missing receipts, refused I/O and Git errors stay silent.
    // Never turn an unknown deployment state into a false drift warning.
  } finally {
    // Any check that shows no drift takes down a status shown before.
    if (!isShowing && deployDrift.isShown) $.ui.status(undefined)
    deployDrift.isShown = isShowing
  }
}

const reorderTrackedSteps = async ($: EngineInterface, ids: unknown, token?: OwnerToken): Promise<{ result: string }> => {
  const failure = (reason: string) => ({ result: JSON.stringify({ ok: false, reason }) })
  if (reorderVisibleSteps((await read($, ledger)).steps, ids) === undefined) return failure('ids must list every visible step exactly once; use permanent ids from lookup_rows')
  if (token === undefined) {
    const owned = await ensureOwner($)
    if (!owned.ok) return failure(owned.reason)
    token = owned.token
  }
  const session = token.owner
  if (session === undefined) return failure('current session identity is unavailable; order was kept')
  let refusal: string | undefined
  await updateOwnedLedger($, token, current => {
    refusal = undefined
    if (current.session_id !== undefined && current.session_id !== session) {
      refusal = 'ledger belongs to another session; order was kept'
      return current
    }
    const steps = reorderVisibleSteps(current.steps, ids)
    if (steps === undefined) {
      refusal = 'visible steps changed; read lookup_rows and retry'
      return current
    }
    return { ...current, session_id: current.session_id ?? session, steps }
  })
  if (refusal !== undefined) return failure(refusal)
  await publishGate($, token)
  if (!(await saveLedger($, token))) return failure(saveFailureText('order'))
  const saved = (await read($, durability)).baseline
  if (saved?.session_id !== session) return failure('saved order could not be verified')
  const order = visibleSteps(saved.ledger.steps).map(step => step.id)
  if (JSON.stringify(order) !== JSON.stringify(ids)) return failure('saved order differs from the requested order; read lookup_rows and retry')
  return { result: JSON.stringify({ ok: true, order }) }
}

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
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    let token: OwnerToken = { owner: undefined, epoch: ownership.epoch }
    if (ownedTools.has(e.tool)) {
      const owned = await ensureOwner($)
      if (!owned.ok && !owned.isIdentity) {
        const text = `track: ${owned.reason}`
        return e.tool === RESTORE_TRACKER && e.expected_checkpoint !== undefined
          ? { result: JSON.stringify(checkpointFailure(String(e.from_session ?? ''), text, owned.destination)) }
          : { deny: text }
      }
      if (owned.ok) token = owned.token
    }
    const current = await read($, turn)
    const beforeLedger = await read($, ledger)
    const beforeActivity = await read($, activity)
    if (token.owner === undefined) token = { ...token, owner: beforeLedger.session_id ?? (await read($, durability)).memorySession ?? undefined }
    // Keep outage rows provisional, but never acquire a different owner after native execution.
    if ([TRACK_QUESTION, TRACK_STEPS, 'TaskCreate', 'TodoWrite'].includes(e.tool) && token.owner === undefined) await captureMintOwner($)
    let completed: Awaited<ReturnType<typeof next>> | undefined
    ownedCalls.set(e.tool_use_id, token)
    try {
    if (ownedTools.has(e.tool)) assertOwner(token, beforeLedger)
    const owner = cancelOwner(beforeLedger.steps, e.tool, current.currentId)
    const owners = owner === undefined ? [] : [owner]
    if (!mutationTools.has(e.tool)) {
      const ran = await next(e)
      completed = ran
      if (!isOwnerCurrent(token)) return ran
      await applyCancel($, owners, ran, token)
      if (ran.deny === undefined && ran.isError !== true) {
        if (await recordWork($, current, e.tool, e.tool_use_id, [], beforeLedger, await read($, ledger), beforeActivity, token)) await publishGate($, token)
        if (await dueActiveStepNudge($, current, token)) return { ...ran, context: [...(ran.context ?? []), ACTIVE_STEP_NUDGE] }
      }
      return ran
    }
    const before = JSON.stringify(beforeLedger)
    // TRACK-8, 2026-10-19: Stop repair replaced an active plan because marking its
    // existing step could not register the request. Only an explicit source opts
    // into reuse; repeating an old completed row is not new work.
    const reuse: { step?: Step } | undefined = e.tool === MARK_STEP && STEP_STATUSES.some(status => status === e.status) &&
      (typeof e.source_text === 'string' || typeof e.source_request_id === 'string')
      ? {} : undefined
    const reuseSession = reuse === undefined ? undefined : await $.session.id()
    if (reuse !== undefined) reuseCalls.set(e.tool_use_id, reuse)
    const ran = await next(e).finally(() => {
      if (reuse !== undefined && reuseCalls.get(e.tool_use_id) === reuse) reuseCalls.delete(e.tool_use_id)
    })
    completed = ran
    if (!isOwnerCurrent(token)) {
      if (e.tool === RESTORE_TRACKER && e.expected_checkpoint !== undefined) {
        return isFailedCheckpointResult(ran.result) ? ran : restoreOwnerChangedResult(String(e.from_session ?? ''), token.owner, ran)
      }
      return ran.deny !== undefined || ran.isError === true || (ran.result as { success?: unknown } | undefined)?.success === false ? ran : ownerChangedResult(e.tool, ran)
    }
    const reusedStep = reuse?.step
    await applyCancel($, owners, ran, token)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const afterLedger = await read($, ledger)
    const touched = stepReceiptIds(e.tool, e, ran.result, beforeLedger, afterLedger)
    const recorded = await recordWork($, current, e.tool, e.tool_use_id, touched, beforeLedger, afterLedger, beforeActivity, token)
    if (before === JSON.stringify(afterLedger) && reusedStep === undefined) {
      if (recorded) await publishGate($, token)
      return ran
    }
    if (e.tool === RESTORE_TRACKER && e.expected_checkpoint !== undefined && typeof ran.result === 'string' && (JSON.parse(ran.result) as Checkpoint).ok !== true) return ran
    await publishGate($, token)
    assertOwner(token)
    if (await saveLedger($, token)) {
      if (e.tool === MARK_STEP && typeof ran.result === 'string') {
        // TRACK-23: copy the acknowledged row, not the caller's proposed note
        // or an atom that may already contain a later, unsaved edit.
        const saved = (await read($, durability)).baseline
        const row = saved?.session_id === await $.session.id()
          ? saved.ledger.steps.find(step => step.id === String(e.id)) : undefined
        if (row !== undefined) {
          // Coverage follows the same durable acknowledgement as this receipt,
          // including an unchanged status. A reconciled replacement cannot cover
          // on behalf of the row the caller meant to reuse.
          if (reusedStep !== undefined && saved?.session_id === reuseSession && row.cleared !== true && row.status === e.status &&
              row.source === reusedStep.source && row.sourceId === reusedStep.sourceId && row.subject === reusedStep.subject &&
              row.taskId === reusedStep.taskId && row.createdRequestId === reusedStep.createdRequestId) {
            await coverInput($, 'steps', { source_text: e.source_text, source_request_id: e.source_request_id }, token)
          }
          const { id, subject, status, note } = row
          return { ...ran, result: `${ran.result}\nSaved row: ${JSON.stringify({ id, subject, status, ...(note !== undefined && { note }) })}` }
        }
      }
      return ran
    }
    const pendingCause = savePendingCause()
    const warning = pendingCause === undefined ? `track: unsaved — ${persistence.failure}` : `track: save outcome pending — ${pendingCause}`
    if (e.tool === RESTORE_TRACKER && e.expected_checkpoint !== undefined && typeof ran.result === 'string') {
      const receipt = JSON.parse(ran.result) as Checkpoint
      return { ...ran, result: JSON.stringify({ ...receipt, ok: false, reason: warning }), context: [...(ran.context ?? []), warning] }
    }
    return { ...ran, ...(typeof ran.result === 'string' && { result: `${ran.result}\n${warning}` }), context: [...(ran.context ?? []), warning] }
    } catch (error) {
      if (!(error instanceof OwnerChanged)) throw error
      if (e.tool === RESTORE_TRACKER && e.expected_checkpoint !== undefined) {
        if (completed !== undefined && isFailedCheckpointResult(completed.result)) return completed
        return restoreOwnerChangedResult(String(e.from_session ?? ''), token.owner, completed)
      }
      return ownerChangedResult(e.tool, completed)
    } finally {
      if (ownedCalls.get(e.tool_use_id) === token) ownedCalls.delete(e.tool_use_id)
    }
  })

  on('session.start', async ($, e, next) => {
    // A reload keeps the status the last load set, so the first check clears it.
    deployDrift.isShown = true
    $.clock.after(0, () => checkDeployDrift($))
    renderInstances.clear()
    renderSaved.session = undefined
    // Like /btw: typed while a turn runs, /track acts at once instead of waiting for the turn to
    // end, and the toggle answers with no text, so the session gets no row.
    await $.command.register({
      name: 'track',
      description: 'Show or hide the track pane: questions asked, where answered, and the steps',
      argumentHint: '[order | reorder <JSON step-id array> | status | classifier [on|off] | export <absolute-path> | import <absolute-path>]',
      immediate: true,
    })
    const catalog = toolContracts(STEPS, STEP_RESULT, STEP_STATUSES, MAX_STEPS)
    await $.tool.register(catalog.track_question)
    await $.tool.register(catalog.mark_answered)
    await $.tool.register(catalog.track_steps)
    await $.tool.register(catalog.restore_tracker)
    await $.tool.register(catalog.checkpoint)
    await $.tool.register(catalog.lookup_rows)
    await $.tool.register(catalog.diagnose)
    await $.tool.register(catalog.reorder_steps)
    await $.tool.register(catalog.mark_step)

    try {
      const saved = await read($, renders)
      renderSaved.session = await $.session.id()
      if (saved.session === renderSaved.session) {
        for (const [key, id] of saved.rows) if (!renderInstances.has(key)) renderInstances.set(key, id)
      }
    } catch (error) {
      $.ui.log(`track: render instances not restored: ${reason(error)}`, { to: 'debug' })
    }

    try {
      const id = await $.session.id()
      await switchOwner($, id)
    } catch (error) {
      $.ui.log(`track: resume failed: ${reason(error)}`, { to: 'debug' })
    }

    // Housekeeping runs after the registrations, so a refused call here never costs the session
    // /track or the tools.
    try {
      // session.start runs again on a reload, an enable or a worker respawn, while the pane stays
      // up (closing it here made the pane open by itself, then close). Only a pane asked for by
      // code below 144 columns, which waits unseen, is dropped.
      const mine = (await $.ui.panes()).find(p => p.id === PANE)
      if (mine !== undefined && !mine.isPlaced) {
        await $.ui.close({ id: PANE })
      } else if (mine !== undefined) {
        await update($, pane, p => ({ ...p, isOpen: true }))
      }
      const stale = await read($, lit)
      if (stale.length > 0) {
        await Promise.all(stale.map(id => light($, id, 0)))
        await update($, lit, () => [])
      }
    } catch (error) {
      $.ui.log(`track: session.start housekeeping failed: ${reason(error)}`, { to: 'debug' })
    }

    return next(e)
  })

  // The per-turn tools stay in the model's tool list; a deferred tool costs a ToolSearch round trip.
  on('tool.describe', { tool: TRACK_QUESTION }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: MARK_ANSWERED }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: TRACK_STEPS }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: MARK_STEP }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: RESTORE_TRACKER }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: CHECKPOINT }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', { tool: CHECKPOINT }, async ($, e) => {
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
  })

  on('tool.call', { tool: DIAGNOSE }, async ($, e) => diagnose(diagnosePorts($), e))

  on('tool.call', { tool: LOOKUP_ROWS }, async ($, e) => {
    if (e.references !== undefined && (!Array.isArray(e.references) || e.references.length > 64 || !e.references.every(reference => typeof reference === 'string' && /^[SQ]\d+$/i.test(reference)))) {
      return { result: JSON.stringify({ ok: false, reason: 'references must contain at most 64 S/Q labels' }) }
    }
    return { result: JSON.stringify({ ok: true, rows: lookupPaneRows(await read($, ledger), e.references as string[] | undefined) }) }
  })

  on('tool.call', { tool: REORDER_STEPS }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: 'track: a subagent cannot reorder the session steps.' }
    try {
      return await reorderTrackedSteps($, e.ids, ownedCalls.get(e.tool_use_id))
    } catch (error) {
      if (!(error instanceof OwnerChanged)) throw error
      return ownerChangedResult(e.tool)
    }
  })

  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    await recordPrompt($, e, textOf(e.message.content))

    return next(e)
  })

  // A message typed while a turn runs is no prompt: the engine folds it into that turn as a
  // queued_command attachment, by the delivery door, and draws it under that row's id.
  on('session.append', { door: 'delivery' }, async ($, e, next) => {
    if (e.message.name === 'queued_command') {
      await recordPrompt($, e, textOf(e.message.content).replace(MIDTURN_FRAME, ''))
    }

    return next(e)
  })

  // Event order verifies a source, not whether its words answer the question.
  // A later response can move an explicit answer's call target to the same verified text;
  // it never supplies unknown answer words from narration.
  // TRACK-46 A1/C1 (iii): the observation belongs to the session whose memory saw the reply. A
  // session switch while it runs stops it, so a retry never ties the reply to the new session's
  // turn; the stored reply still flows on.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const epoch = ownership.epoch
    const text = textOf(e.message.content).trim()
    if (e.agentId === undefined && text !== '') {
      try { await observeResponse($, e.uuid, text, await memoryToken($, epoch)) }
      catch (error) {
        if (!(error instanceof OwnerChanged)) throw error
        $.ui.log('track: reply observation stopped: session owner changed during the reply.', { to: 'debug' })
      }
    }

    return next(e)
  })

  // A completed marker pair is the model's explicit answer identification. Capture
  // only a stored main-model response, never peer hand-backs, tool output or progress.
  // TRACK-46 A1/C1 (iii): the capture belongs to the session whose memory saw the reply. A
  // session switch while it runs stops it: question numbers repeat across sessions.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const epoch = ownership.epoch
    const observed = (await read($, turn)).lastText
    const stored = await next(e)
    if (stored.deny !== undefined || e.agentId !== undefined || e.origin.kind !== 'model' || stored.message.type !== 'assistant' || observed?.requestId !== e.uuid || observed.turnId === null || observed.order === undefined) return stored
    try { await captureResponse($, textOf(stored.message.content), stored.uuid, { turnId: observed.turnId, order: observed.order }, await memoryToken($, epoch)) }
    catch (error) {
      if (!(error instanceof OwnerChanged)) throw error
      $.ui.log('track: answer capture stopped: session owner changed during the reply.', { to: 'debug' })
    }
    return stored
  })

  on('turn.start', async ($, e, next) => {
    // A subagent's loop starts turns too (agentId set). Everything below is the main turn's:
    // its current id, freshness record, input and row binding, and activity. A subagent's start
    // touches none of it, or the main turn's Stop would judge an emptied record.
    if (e.agentId !== undefined) return next(e)
    // prompt.submit may already have stored this turn's inputs, unbound: they are this turn's.
    // A covered input of an earlier turn is done and leaves, and so is one Haiku called
    // not_question; an unresolved one stays. Steps coverage waits for a label still to come: a late
    // question label undoes it.
    await update($, turn, t => ({ ...t, currentId: e.turnId, freshness: typeof e.turnId === 'string' ? freshTurn(e.turnId) : undefined } as Turn))
    if (typeof e.turnId === 'string') {
      await update($, pending, p => (p.inputs.length === 0 ? p : {
        ...p,
        inputs: p.inputs.filter(i => i.turnId === null || i.turnId === e.turnId || (i.covered === undefined ? i.label !== 'not_question' : i.covered === 'steps' && i.label === undefined)).map(i => (i.turnId === null ? { ...i, turnId: e.turnId } : i)),
      }))
    }
    await update($, activity, a => ({ ...a, isWorking: true, mainTurnId: e.turnId }))
    await updateLedger($, l => ({
      ...l,
      prompts: l.prompts.map(p => (p.turnId === null ? { ...p, turnId: e.turnId } : p)),
      questions: l.questions.map(q => (q.turnId === null ? { ...q, turnId: e.turnId } : q)),
    }))
    await publishGate($)

    return next(e)
  })

  // The standing rule: one byte-stable system-prompt section, appended last (scope `session`),
  // so the prompt cache holds across turns. Everything that changes per turn goes in the
  // prompt.submit context row instead.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    // The rule reaches the model this session, so prompts need not carry the steps line.
    if ((await read($, turn)).composedRule !== RULE) {
      await update($, turn, t => ({ ...t, composedRule: RULE }))
    }

    return { sections: [...composed.sections, { id: 'track:rule', text: RULE, scope: 'session' as const }] }
  })

  // A question-like main prompt becomes a pending input. One typed while a turn runs carries that
  // turn's id; an idle one is bound by its turn.start or its Stop. A notification, a doorbell or
  // a request neither adds nor erases one. A prompt a hook dropped never reached the model.
  // Then the per-turn reminder: a short row beside the prompt, only while something is open.
  // One handler: the loader takes one prompt.submit hook without a matcher.
  on('prompt.submit', async ($, e, next) => {
    // The pending write runs after several awaits, so it checks the admitted owner inside its atom.
    const admissionEpoch = ownership.epoch
    let token: OwnerToken | undefined
    let provisional = false
    if ((e as { agentId?: string }).agentId === undefined) {
      const owned = await ensureOwner($)
      if (!owned.ok && !owned.isIdentity) {
        // Keep the prompt available when Track cannot select its session's rows.
        return next({ ...e, context: [...(e.context ?? []), `track: ${owned.reason}; Track did not record this prompt.`] })
      }
      token = owned.ok ? owned.token : undefined
      provisional = !owned.ok
    }
    // Every write after an await checks the admitted owner, inside its atom where there is one.
    const assertAdmitted = (): void => {
      assertOwner(token)
      if (provisional && !isOwnerCurrent({ owner: undefined, epoch: admissionEpoch })) throw new OwnerChanged()
    }
    const passThrough = () => {
      // Another session owns the rows now: pass the prompt through and leave its state alone.
      $.ui.log('track: prompt input not recorded: session owner changed during the call.', { to: 'debug' })
      return next({ ...e, context: [...(e.context ?? []), 'track: session owner changed during the call; Track did not record this prompt.'] })
    }
    const trimmed = (e as { agentId?: string }).agentId === undefined ? gateable(String(e.text ?? ''), e.origin?.kind) : undefined
    const wording = trimmed !== undefined && looksLikeQuestion(trimmed)
    const classify = trimmed !== undefined && (await classifierOn($))
    let added: number | undefined
    if (trimmed !== undefined && (wording || classify)) {
      const excerpt = trimmed.slice(0, 80)
      const head = headOf(String(e.text))
      const turnId = typeof e.turnId === 'string' ? e.turnId : null
      const textHash = await checksumOf(String(e.text))
      // The prompt row may already be recorded: the newest with these words, not yet taken.
      const prompts = (await read($, ledger)).prompts
      let full = false
      try {
        await update($, pending, p => {
          assertAdmitted()
          added = undefined
          full = false
          const admission = admitInput(p, { head, excerpt, textHash, turnId, wording, prompts, labelling: new Set([...classifying.keys(), ...labelScheduled]), needsRow: needsQuestion })
          added = admission.added
          full = admission.full
          // Permanent helper claims are named per epoch, so a restarted runtime's input 1 is new.
          // Inputs already queued when the epoch is minted (a hot reload from an older version)
          // keep their legacy claim names, so a held one is never held again.
          if (admission.added === undefined) return admission.next
          if (p.epoch !== undefined) return { ...admission.next, epoch: p.epoch }
          const fresh = admission.added
          return { ...admission.next, inputs: admission.next.inputs.map(i => i.id === fresh ? i : { ...i, legacy: true as const }), epoch: crypto.randomUUID() }
        })
      } catch (error) {
        if (!(error instanceof OwnerChanged)) throw error
        return passThrough()
      }
      if (full) $.ui.toast(`track: ${MAX_INPUTS} prompts still wait for a Track row; this one was not recorded.`)
      // Started, not awaited: the label is read at Stop. A managed timer stops on a reload.
      if (added !== undefined && classify) {
        const id = added
        const text = String(e.text)
        const epoch = ownership.epoch
        labelScheduled.add(id)
        $.clock.after(0, () => {
          labelScheduled.delete(id)
          const run = classifyInput($, id, text, epoch).finally(() => classifying.delete(id))
          classifying.set(id, run)
          return run
        })
      }
    }
    const entered = await (async () => {
      assertAdmitted()
      // A finished background task or agent says so in its notification: it leaves the banner.
      // Its step stays as it is and gains a visible flag, plus one nudge to update it.
      let followUpLine: string | undefined
      if (e.origin?.kind === 'task-notification') {
        const done = [...e.text.matchAll(new RegExp(TASK_ID.source, 'g'))].map(m => m[1] ?? '')
        if (done.length > 0) followUpLine = await finishTasks($, () => done, assertAdmitted, token)
      }
      assertAdmitted()
      const kept = await dropRewound($, String(e.text ?? ''))
      // A rewind check that ran after an owner change speaks for the new owner, not for this prompt.
      assertAdmitted()
      if (!kept) return { drop: `track: ${saveFailureText('rewind')}. Retry after storage is available.` }
      const typed = e.origin?.kind === 'composer'
      // A plugin's prompt (Plannotator's review comments) can add work to a running plan.
      const fromPlugin = e.origin?.kind === 'plugin'
      const needsSteps = (await read($, turn)).composedRule !== RULE
      if (e.text.trim().startsWith('/')) {
        // /track and the built-in commands reach no main-loop work: nothing rides on them, and a
        // withdrawn question waits for a prompt the model reads. A skill's slash command reaches the
        // model and starts work, so it carries what a typed prompt carries.
        const name = /^\/([^\s]+)/.exec(e.text.trim())?.[1] ?? ''
        const isBuiltin = name === 'track' || (await $.command.list()).some(c => c.name === name && c.source === 'builtin')
        assertAdmitted()
        if (isBuiltin) return next(e)
      }
      // Phase 2 D6: classic.Stop may not run on this host, so the command hook's inventory of the
      // finished turn's live tasks retires the rest at the next main prompt. Ids launched later stay.
      // After the builtin return: a builtin command reaches no model, so it would lose the line.
      const origin = e.origin?.kind
      if ((e as { agentId?: string }).agentId === undefined && typeof token?.owner === 'string' && (origin === 'composer' || origin === 'plugin' || origin === 'task-notification')) {
        const live = await readStopInventory($, token.owner)
        if (live !== undefined) {
          let dropped = 0
          const line = await finishTasks($, a => {
            const drops = inventoryDrops(a, live)
            dropped = drops.length
            return drops
          }, assertAdmitted, token)
          noteEvent($, 'stop.inventory_applied', { dropped, launch_seq: live.launchSeq }, live.turnId)
          if (line !== undefined) followUpLine = followUpLine === undefined ? line : `${followUpLine} ${line}`
        }
      }
      const lines: string[] = [...(needsSteps ? [STEPS_LINE] : []), ...(followUpLine !== undefined ? [followUpLine] : [])]
      if ((typed || fromPlugin || e.origin?.kind === 'task-notification') && (e as { agentId?: string }).agentId === undefined) await remindFinishedTurn($, assertAdmitted)
      const reminder = (await read($, turn)).stepReminder
      if ((typed || fromPlugin) && (e as { agentId?: string }).agentId === undefined && reminder !== undefined) {
        lines.push(reminder)
        await update($, turn, current => {
          assertAdmitted()
          return current.stepReminder === reminder ? { ...current, stepReminder: undefined } : current
        })
      }
      const resultReminder = (await read($, turn)).resultReminder
      if ((typed || fromPlugin) && (e as { agentId?: string }).agentId === undefined && resultReminder !== undefined) {
        const text = missingResultText((await read($, ledger)).steps, resultReminder.ids)
        if (text !== undefined) lines.push(text)
        await update($, turn, current => {
          assertAdmitted()
          return current.resultReminder?.turnId === resultReminder.turnId ? { ...current, resultReminder: undefined } : current
        })
      }
      // A prompt Stop already asked about once and no row covers yet is named again here.
      const unresolved = (await read($, pending)).inputs.filter(i => i.held === true && i.covered === undefined && needsQuestion(i))
      const waiting = unregisteredContext(unresolved)
      if (waiting !== undefined) lines.push(waiting)
      const l = await read($, ledger)
      assertAdmitted()
      const context = promptContext(l, e.text, ANSWER)
      if (context.references !== undefined) lines.push(context.references)
      // A question the user withdrew with ✕ is told to the model once, on whatever prompt it reads next.
      if (context.withdrawn !== undefined) {
        lines.push(context.withdrawn)
        await updateLedger($, cur => {
          assertAdmitted()
          return { ...cur, withdrawn: remainingNotices(cur.withdrawn, l.withdrawn) }
        })
      }
      // Unfinished steps the user removed with a confirmed "clear all", told once like a withdrawal.
      if (context.cleared !== undefined) {
        lines.push(context.cleared)
        await updateLedger($, cur => {
          assertAdmitted()
          return { ...cur, clearedSteps: remainingNotices(cur.clearedSteps, l.clearedSteps) }
        })
      }
      if (context.open === undefined) {
        return lines.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...lines] })
      }
      return next({ ...e, context: [...(e.context ?? []), ...lines, context.open] })
    })().catch((error: unknown) => {
      if (!(error instanceof OwnerChanged)) throw error
      return passThrough()
    })
    if (added !== undefined && 'drop' in entered) {
      const dropped = added
      // The drop removes this prompt's own input; after an owner change it is not in these rows.
      await update($, pending, p => {
        try { assertAdmitted() } catch (error) {
          if (error instanceof OwnerChanged) return p
          throw error
        }
        return { ...p, inputs: p.inputs.filter(i => i.id !== dropped) }
      })
    }

    return entered
  })

  // The gate: after the settings Stop hooks have run (and only when none of them blocked),
  // hold the turn once when a question the model tracked this turn is still open. The catch
  // replays the chain, so a failure here can never add or erase a block.
  on('classic.Stop', async ($, e, next) => {
    const below = await next(e)
    // Stop lists the background work still in flight: a task whose notification never came
    // (killed, or lost) leaves the banner here.
    if (e.agent_id === undefined && Array.isArray(e.background_tasks)) {
      const inFlight = e.background_tasks
      const background = inFlight.filter(task => AGENT_TASK.test(task.type)).map(task => task.id)
      const tasks = inFlight.filter(task => !AGENT_TASK.test(task.type)).map(task => task.id)
      await update($, activity, a => ({ ...a, background, tasks }))
    }
    if (below.block !== undefined || e.agent_id !== undefined) {
      return below
    }
    const t = await read($, turn)
    await nudgeMissingResults($, t)
    // Each uncovered input is held once, even after another Stop hook continued the turn: its
    // own mark bounds the repair, so no loop. Unbound inputs are this turn's and are bound now.
    if (t.currentId !== null) {
      const currentId = t.currentId
      // Wait briefly for a Haiku label already in flight; past the wait the wording check decides.
      const inFlight = (await read($, pending)).inputs.filter(i => i.covered === undefined && i.held !== true && i.label === undefined).map(i => classifying.get(i.id)).filter(run => run !== undefined)
      if (inFlight.length > 0) await Promise.race([Promise.all(inFlight), $.clock.sleep(STOP_JOIN_MS)])
      let uncovered: PendingInput[] = []
      await update($, pending, p => {
        // Any unresolved input not yet asked about: this turn's, or one an interrupted turn left.
        uncovered = p.inputs.filter(i => i.covered === undefined && i.held !== true && needsQuestion(i))
        const bound = p.inputs.some(i => i.turnId === null)
        return bound ? { ...p, inputs: p.inputs.map(i => ({ ...i, turnId: i.turnId ?? currentId })) } : p
      })
      if (uncovered.length > 0) {
        // On hosts with both hooks, the command hook claims first. Both paths
        // use that same per-input claim, so the module cannot block it twice.
        const claim = await claimUncoveredInputs($, e, uncovered, currentId)
        if (claim.held) {
          const held = new Set(uncovered.map(i => i.id))
          await update($, pending, p => ({ ...p, inputs: p.inputs.map(i => held.has(i.id) ? { ...i, held: true as const } : i) }))
        }
        if (claim.block !== undefined) {
          await update($, turn, cur => ({ ...cur, gatedTurnId: currentId }))
          noteEvent($, 'stop.block.module', { kind: 'uncovered_input', inputs: uncovered.length }, currentId)
          return { ...below, block: claim.block }
        }
      }
    }
    if (t.currentId === null) {
      if (!e.stop_hook_active) nudgeFed($, 'identity', await freshnessNudge($, 'identity', 'track: current turn identity unavailable; reconcile steps before finishing.'))
      return below
    }
    // Ohad, 2026-10-18: every Stop after a block carries stop_hook_active, and it still checks
    // the freshness kinds. Each kind's shared hold allows one block per turn, so this cannot
    // loop. The open-question gate keeps its bypass.
    if (e.stop_hook_active) {
      const block = await stepStop($, e)
      return block === undefined ? below : { ...below, block }
    }
    const l = await read($, ledger)
    const open = l.questions.filter(q => q.status === 'open' && q.turnId === t.currentId)
    if (open.length === 0 || t.gatedTurnId === t.currentId) {
      const block = await stepStop($, e)
      return block === undefined ? below : { ...below, block }
    }
    await update($, turn, cur => ({ ...cur, gatedTurnId: t.currentId }))
    await publishGate($)
    noteEvent($, 'stop.block.module', { kind: 'open_question', open: open.length }, t.currentId)
    const first = open[0] as Question
    const rest = open.length > 1 ? ` (${open.length - 1} more open: ${open.slice(1).map(q => `Q${q.id}`).join(', ')})` : ''

    return {
      ...below,
      block: `track: Q${first.id} "${first.head}" from this turn is still open${rest}. ${ANSWER.replaceAll('{id}', String(first.id))}. If it must wait, call mcp__track__mark_answered with status "deferred" and a note. Then finish.`,
    }
  }).catch(($, e, next) => next(e))

  // Compaction removes old tool calls from the transcript; record when, so the rewind check
  // never mistakes compacted questions for rewound ones.
  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    if (e.agentId === undefined && !('skip' in compacted)) {
      await updateLedger($, l => ({ ...l, compactedAt: Date.now() }))
      // The transcript before compaction is no baseline for the one after it.
      forgetTranscriptBaseline()
    }

    return compacted
  })

  // Each finished main-loop turn saves the ledger, so /resume finds it.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const currentId = (await read($, turn)).currentId
      // The activity atom's own identity fences a new turn that starts during this update.
      await update($, activity, a => (a.mainTurnId ?? currentId) === e.turnId || (a.mainTurnId ?? currentId) === null
        ? { ...a, isWorking: false, agentCalls: [], askCalls: [] }
        : a)
    } else {
      // A background agent's loop ended: retire it as a finished task, so the step it owned is flagged now.
      const agentId = e.agentId
      // Fence on the owner at completion. A child receipt never claims or switches the session owner.
      const epoch = ownership.epoch
      try {
        const owner = (await read($, ledger)).session_id ?? (await read($, durability)).memorySession ?? undefined
        const token: OwnerToken = { owner, epoch }
        const assertAdmitted = () => assertOwner(token)
        assertAdmitted()
        await finishTasks($, () => [agentId], assertAdmitted, token)
        await publishGate($, token)
      } catch (error) {
        // The owner changed during this child completion: its writes belong to the old session, so drop them.
        if (!(error instanceof OwnerChanged)) throw error
      }
    }
    const done = await next(e)
    if (e.agentId === undefined && deployDrift.isShown) $.clock.after(0, () => checkDeployDrift($))
    if (e.agentId === undefined) {
      if (e.isAborted) {
        const now = await $.clock.now()
        await updateLedger($, l => ({ ...l, steps: l.steps.map(s => {
          if (s.cleared === true || s.status !== 'in_progress' || s.delegated === true || s.activeTurnId !== e.turnId) return s
          return { ...withStatus(s, 'paused', now), note: s.note ? `${s.note}; interrupted` : 'interrupted' }
        }) }))
        await dropFinishedOwners($)
      }
      await recordTranscriptBaseline($)
      await saveLedger($)
    }

    return done
  })

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

  on('tool.call', { tool: TRACK_QUESTION }, async ($, e) => {
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
  })

  on('tool.call', { tool: MARK_ANSWERED }, async ($, e) => {
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
  })

  // Steps come from the model's own tools, read after each call succeeds. A subagent's
  // calls are its own work, not the session's steps.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const token = ownedCalls.get(e.tool_use_id)
    const ran = await next(e)
    const task = (ran.result as { task?: { id?: unknown } } | undefined)?.task
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true || task?.id === undefined) {
      return ran
    }
    try {
    const taskId = String(task.id)
    const subject = headOf(String(e.subject ?? ''))
    const session = token?.owner
    await updateOwnedLedger($, token, cur => createTask(cur, { taskId, subject, toolUseId: e.tool_use_id, session }))

    return ran
    } catch (error) {
      if (!(error instanceof OwnerChanged)) throw error
      return ownerChangedResult(e.tool, ran)
    }
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const token = ownedCalls.get(e.tool_use_id)
    const currentId = e.agentId === undefined ? (await read($, turn)).currentId : null
    const ran = await next(e)
    const status = e.status
    const failed = (ran.result as { success?: unknown } | undefined)?.success === false
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true || failed || status === undefined) {
      return ran
    }
    try {
    const taskId = String(e.taskId)
    const now = await $.clock.now()
    await updateOwnedLedger($, token, cur => updateTask(cur, { taskId, status, now, currentId }))
    await dropFinishedOwners($, token)

    return ran
    } catch (error) {
      if (!(error instanceof OwnerChanged)) throw error
      return ownerChangedResult(e.tool, ran)
    }
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const token = ownedCalls.get(e.tool_use_id)
    const currentId = e.agentId === undefined ? (await read($, turn)).currentId : null
    const ran = await next(e)
    const todos = (ran.result as { newTodos?: Array<{ content: string; status: Step['status'] }> } | undefined)?.newTodos
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true || todos === undefined) {
      return ran
    }
    try {
    // Two todos whose titles normalize alike get #2, #3 after the id, so mark_step reaches each.
    // A todo written again keeps its clock.
    const session = token?.owner
    const now = await $.clock.now()
    await updateOwnedLedger($, token, cur => replaceTodos(cur, { todos, now, currentId, session }))
    await dropFinishedOwners($, token)

    return ran
    } catch (error) {
      if (!(error instanceof OwnerChanged)) throw error
      return ownerChangedResult(e.tool, ran)
    }
  })

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    const result = ran.result as { plan?: unknown; isAgent?: unknown } | undefined
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true || typeof result?.plan !== 'string' || result.isAgent === true) {
      return ran
    }
    return { ...ran, context: [...(ran.context ?? []), `track: the plan was approved. Reuse the existing open steps; register meaningful missing work with mcp__track__track_steps. ${STEPS}`] }
  })

  // The banner's inputs: an Agent call in flight, a background agent, a background shell task, a
  // question dialog for the person. A subagent's own calls are its work, not the session's.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }
    const callId = e.tool_use_id
    const token = ownedCalls.get(callId)
    await update($, activity, a => ({ ...a, agentCalls: [...a.agentCalls, callId] }))
    try {
      const ran = await next(e)
      const launched = ran.result as { status?: unknown; agentId?: unknown } | undefined
      // TRACK-46 A1/C1: a launch that returns after another session was selected belongs to the
      // old owner, so it never enters the new owner's activity (as for Bash).
      if (launched?.status === 'async_launched' && typeof launched.agentId === 'string' && (token === undefined || isOwnerCurrent(token))) {
        const agentId = launched.agentId
        const steps = (await read($, ledger)).steps
        const ids = agentLaunchOwner(steps, (await read($, turn)).currentId)
        await update($, activity, a => {
          assertOwner(token)
          return { ...a, background: [...a.background.filter(id => id !== agentId), agentId], ...rememberOwner(a, agentId, ids, steps), ...rememberLaunch(a, agentId) }
        })
      }

      return ran
    } finally {
      await update($, activity, a => ({ ...a, agentCalls: a.agentCalls.filter(id => id !== callId) }))
    }
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }
    const callId = e.tool_use_id
    await update($, activity, a => ({ ...a, askCalls: [...a.askCalls, callId] }))
    try {
      return await next(e)
    } finally {
      await update($, activity, a => ({ ...a, askCalls: a.askCalls.filter(id => id !== callId) }))
    }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const token = ownedCalls.get(e.tool_use_id)
    const ran = await next(e)
    const taskId = (ran.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId
    if (e.agentId === undefined && typeof taskId === 'string' && (token === undefined || isOwnerCurrent(token))) {
      const steps = (await read($, ledger)).steps
      const ids = launchOwner(steps, (await read($, turn)).currentId)
      await update($, activity, a => {
        assertOwner(token)
        return { ...a, tasks: [...(a.tasks ?? []).filter(id => id !== taskId), taskId], ...rememberOwner(a, taskId, ids, steps), ...rememberLaunch(a, taskId) }
      })
    }

    return ran
  })

  // Explicit tracking creates plan rows; approving a plan never imports its text.
  on('tool.call', { tool: TRACK_STEPS }, async ($, e) => {
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
  })

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
  on('tool.call', { tool: RESTORE_TRACKER }, async ($, e, next) => {
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
  })

  on('tool.call', { tool: MARK_STEP }, async ($, e) => {
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
  })

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

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'resume') {
      await switchOwner($, e.session_id)
    }

    return next(e)
  }).catch(($, e, next) => {
    $.ui.log(`track: resume failed: ${reason(next.error)}`, { to: 'debug' })

    return next(e)
  })

  // Save the ledger at the end of the session; /clear starts a fresh one.
  on('session.end', async ($, e, next) => {
    await saveLedger($)
    if (writer.lease !== null) await closeLock(writer.lease).catch(() => undefined)
    writer.lease = null
    writer.session = ''
    if (e.reason === 'clear') {
      await updateLedger($, () => EMPTY_LEDGER)
      await update($, turn, () => ({ currentId: null, gatedTurnId: null }))
      await update($, activity, () => IDLE)
    }

    return next(e)
  })

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
