import { atom, memberOf, read, update } from 'claude-code'
import type { PluginState, RenderElement, MatchedHook, Hook } from 'claude-code'
import type { Pane, ScrollAt, Step } from '../types'
import { checksumOf } from './checkpoint'
import { visibleSteps, sameResultOwner } from './steps'
import { hasClock, runningClocks, isLifecycleNote, STEP_STATUSES } from './ledger-policy'
import { RESULT_CHARS, truncate } from './ledger-text'
import { wrappedLines, fitLines } from './terminal-text'
import { clampTo, clockText, questionLabels, buttonWidth } from './pane-layout'
import { FOLDED_LINES, labelCell, paneRowMetrics, stepFoldKey } from './pane-row-metrics'
import { paneViewport } from './pane-viewport-model'
import { paneBanner } from './pane-banner-model'
import { paneRootView, paneItem } from './pane-root-view'
import type { BannerRow } from './banner-layout'
import { lookupPaneRows, visibleQuestions } from './pane-order'
import { answerBlocks, answerBlockKey } from './answer-blocks'
import { hideAnsweredQuestions } from './question-commands'
import { hideCompletedSteps } from './clear-commands'
import { stepView } from './pane-step-view'
import { questionView } from './pane-question-view'
import type { QuestionRow } from './pane-question-view'
import { restoreKey } from './restore-records'
import { PANE, TITLE, TRACK_QUESTION, MARK_ANSWERED, MARK_STEP, TRACK_STEPS, RESTORE_TRACKER, EMPTY_LEDGER, IDLE, CLEAR_ARM_MS, rowKey, reason, acknowledgedLedger, assertOwner, updateLedger } from './track-state'
import type { OwnerToken } from './track-state'
import { publishGate, saveLedger, saveClassifierSetting, savePanePreference, pendingCauseOf, migrateStore } from './ledger-store'
import { renderInstances, renderSaved, rememberRender, pressOwned, keepAnswerInstance, ensureOwner, identityLine } from './session-owner'
import { rewindCheck, dropRewound, classifierOn } from './prompt-flow'
import { HOTKEYS, ROW_INDENT, pulsing, ticking, COMPACT_COLUMNS, HINT, NONE_YET, ALL_CLEARED, regions, SCROLL_FLUSH_MS, pendingScroll, ring, statusGlyph, shade, isPulsing, startPulse, startTick, jump, withdraw, scheduleAutoOpen, renderRestore, clearQuestions, clearSteps, openPane, reorderTrackedSteps } from './pane-actions'
import type { PrismantisSegment } from './pane-actions'

// Atom copies: identical to their register.tsx declarations (tests/helpers/architecture.ts).
const ledger = atom({ plugin: 'track', key: 'ledger' } as const, EMPTY_LEDGER)
const pane = atom({ plugin: 'track', key: 'pane' } as const, { isOpen: false, hidden: false, closedByPerson: false } as Pane)
const flash = atom({ plugin: 'track', key: 'flash' } as const, 0)
const activity = atom({ plugin: 'track', key: 'activity' } as const, IDLE)
const reveal = atom({ plugin: 'track', key: 'reveal' } as const, {} as Record<string, 'q' | 'a' | 'r' | undefined>)
// Rows unfolded to their whole text, keyed q:<id> and s:<sourceId or id>; every row starts folded.
const expandedRows = atom({ plugin: 'track', key: 'expanded' } as const, {} as Record<string, true | undefined>)
const pulse = atom({ plugin: 'track', key: 'pulse' } as const, 0)
const tick = atom({ plugin: 'track', key: 'tick' } as const, 0)
const scrollAt = atom({ plugin: 'track', key: 'scroll' } as const, { questions: null, steps: null } as ScrollAt)
const clearArm = atom({ plugin: 'track', key: 'clearArm' } as const, null as number | null)
const durability = atom({ plugin: 'track', key: 'durability' } as const, { isUnsaved: false, reason: '' } as PluginState['track']['durability'])

// The rewind check a prompt-hint redraw schedules: run after this delay, at most once per gap.
// Module memory, not $.state: a reload only resets the debounce.
export const REWIND_CHECK_DELAY_MS = 1000
export const REWIND_CHECK_GAP_MS = 3000

// 'ui.render' { component: 'UserMessage' }: the registration stays in register.tsx.
type UserMessageRenderHook = MatchedHook<'ui.render', { component: 'UserMessage' }>
export async function userMessageRender($: Parameters<UserMessageRenderHook>[0], e: Parameters<UserMessageRenderHook>[1], next: Parameters<UserMessageRenderHook>[2]): Promise<Awaited<ReturnType<UserMessageRenderHook>>> {
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
}

// 'command.run' { command: 'track' }: the registration stays in register.tsx.
type TrackCommandHook = MatchedHook<'command.run', { command: 'track' }>
export async function trackCommand($: Parameters<TrackCommandHook>[0], e: Parameters<TrackCommandHook>[1]): Promise<Awaited<ReturnType<TrackCommandHook>>> {
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
}

// 'ui.close': the registration stays in register.tsx.
type PaneCloseHook = Hook<'ui.close'>
export async function paneClose($: Parameters<PaneCloseHook>[0], e: Parameters<PaneCloseHook>[1], next: Parameters<PaneCloseHook>[2]): Promise<Awaited<ReturnType<PaneCloseHook>>> {
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
}

// 'ui.render' { component: 'PromptHint' }: the registration stays in register.tsx.
type PromptHintRenderHook = MatchedHook<'ui.render', { component: 'PromptHint' }>
export async function promptHintRender($: Parameters<PromptHintRenderHook>[0], e: Parameters<PromptHintRenderHook>[1], next: Parameters<PromptHintRenderHook>[2]): Promise<Awaited<ReturnType<PromptHintRenderHook>>> {
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
}

// 'ui.render' { component: 'AbovePrompt' }: the registration stays in register.tsx.
type AbovePromptRenderHook = MatchedHook<'ui.render', { component: 'AbovePrompt' }>
export async function abovePromptRender($: Parameters<AbovePromptRenderHook>[0], e: Parameters<AbovePromptRenderHook>[1], next: Parameters<AbovePromptRenderHook>[2]): Promise<Awaited<ReturnType<AbovePromptRenderHook>>> {
  await scheduleAutoOpen($, e.viewport)

  return next(e)
}

// 'ui.render' { component: 'ToolGroup' }: the registration stays in register.tsx.
type ToolGroupRenderHook = MatchedHook<'ui.render', { component: 'ToolGroup' }>
export async function toolGroupRender($: Parameters<ToolGroupRenderHook>[0], e: Parameters<ToolGroupRenderHook>[1], next: Parameters<ToolGroupRenderHook>[2]): Promise<Awaited<ReturnType<ToolGroupRenderHook>>> {
  const l = await read($, ledger)
  const ownsTarget = e.props.calls.some(call => call.tool_use_id !== undefined && (
    l.questions.some(q => q.cleared !== true && (
      (q.trackedBy === call.tool_use_id && q.askedRequestId === call.tool_use_id)
      || (q.answeredBy === call.tool_use_id && q.answerKey === call.tool_use_id)
      || q.restoredBy === call.tool_use_id
    ))
  ))
  return next(ownsTarget && !e.props.isExpanded ? { ...e, props: { ...e.props, isExpanded: true } } : e)
}

// 'ui.render' { component: 'ToolUse' }: the registration stays in register.tsx.
type ToolUseRenderHook = MatchedHook<'ui.render', { component: 'ToolUse' }>
export async function toolUseRender($: Parameters<ToolUseRenderHook>[0], e: Parameters<ToolUseRenderHook>[1], next: Parameters<ToolUseRenderHook>[2]): Promise<Awaited<ReturnType<ToolUseRenderHook>>> {
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
}

// 'ui.render' { component: 'AssistantMessage' }: the registration stays in register.tsx.
type AssistantMessageRenderHook = MatchedHook<'ui.render', { component: 'AssistantMessage' }>
export async function assistantMessageRender($: Parameters<AssistantMessageRenderHook>[0], e: Parameters<AssistantMessageRenderHook>[1], next: Parameters<AssistantMessageRenderHook>[2]): Promise<Awaited<ReturnType<AssistantMessageRenderHook>>> {
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
}

// 'ui.render' { component: 'ToolResult' }: the registration stays in register.tsx.
type ToolResultRenderHook = MatchedHook<'ui.render', { component: 'ToolResult' }>
export async function toolResultRender($: Parameters<ToolResultRenderHook>[0], e: Parameters<ToolResultRenderHook>[1], next: Parameters<ToolResultRenderHook>[2]): Promise<Awaited<ReturnType<ToolResultRenderHook>>> {
  if ([TRACK_QUESTION, MARK_ANSWERED, TRACK_STEPS, MARK_STEP, RESTORE_TRACKER].includes(e.props.tool)) {
    const { Box } = $.ui.resolve(e)

    return <Box />
  }

  return next(e)
}

// 'ui.scroll' { component: 'Pane', requestId: PANE }: the registration stays in register.tsx.
type PaneScrollHook = MatchedHook<'ui.scroll', { component: 'Pane', requestId: typeof PANE }>
export async function paneScroll($: Parameters<PaneScrollHook>[0], e: Parameters<PaneScrollHook>[1], next: Parameters<PaneScrollHook>[2]): Promise<Awaited<ReturnType<PaneScrollHook>>> {
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
}

// 'ui.render' { component: 'Pane', requestId: PANE }: the registration stays in register.tsx.
type PaneRenderHook = MatchedHook<'ui.render', { component: 'Pane', requestId: typeof PANE }>
export async function paneRender($: Parameters<PaneRenderHook>[0], e: Parameters<PaneRenderHook>[1]): Promise<Awaited<ReturnType<PaneRenderHook>>> {
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
  const expanded = await read($, expandedRows)
  // Opening a row anchors its region on it, as a reveal does, so the taller row stays in view.
  const toggleExpanded = async (key: string, region: 'questions' | 'steps', index: number) => {
    let opening = false
    await update($, expandedRows, cur => {
      opening = cur[key] !== true
      return { ...cur, [key]: opening ? true as const : undefined }
    })
    if (opening) await update($, scrollAt, cur => ({ ...cur, [region]: index }))
  }
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
    allLabel, doneLabel, questions, steps, opened, resultReveals, expanded, qEmpty, sEmpty, questionLabel, clockOf,
  })
  const { qLabelWidth, sLabelWidth, roomy, titleRows, qControlsRows, stepControlsRows, stepWidth, stepSubjectWidth, qToggle, qTextWidth, qOpen, stepToggle, stepOpen } = metrics
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
        const headShown = fitLines(q.head, qTextWidth(q), qOpen(q) ? headBudget : Math.min(FOLDED_LINES, headBudget))
        const revealRaw = opened[String(q.id)] === 'q' && savedQuestion ? q.head : opened[String(q.id)] === 'a' && savedAnswer && !nativeAnswer ? q.answerText : undefined
        // A short region still draws one cut line. An empty press is not an answer.
        const revealBudget = revealRaw === undefined ? 0 : Math.max(1, qRows - qControlsRows - wrappedLines(headShown, qTextWidth(q)))
        const revealShown = revealRaw !== undefined ? fitLines(revealRaw, qTextWidth(q), revealBudget) : undefined
        return questionView({ Box, Button, Text }, {
          id: q.id, glyph: statusGlyph(q), color, dim: q.status === 'deferred',
          compact, rowIndent, width: qTextWidth(q), toggle: qToggle(q) ? { open: qOpen(q), onPress: () => toggleExpanded(`q:${q.id}`, 'questions', index) } : undefined, label: labelCell(questionLabel(q.id), qLabelWidth), headShown,
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
        const headShown = fitLines(s.subject, stepSubjectWidth(s), Math.min(stepOpen(s) ? Infinity : FOLDED_LINES, Math.max(1, sRows - stepControlsRows(s) - (resultRaw === undefined ? 0 : 1))))
        const resultShown = resultRaw === undefined ? undefined : fitLines(resultRaw, stepWidth(s), Math.max(1, sRows - stepControlsRows(s) - wrappedLines(headShown, stepSubjectWidth(s))))
        // The follow-up note stays here: the pure view's source check reserves the word for state writes.
        const follow = s.followUp === true && <Text key={`s-follow-${s.id}`}>update status</Text>
        return stepView({ Box, Button, Text }, {
          step: s, index, label: labelCell(`S${index + 1}`, sLabelWidth), lifecycle, phase, work, compact, rowIndent,
          result: stepResults.get(s.id), headShown, resultShown,
          width: stepWidth(s), subjectWidth: stepSubjectWidth(s),
          toggle: stepToggle(s) ? { open: stepOpen(s), onPress: () => toggleExpanded(stepFoldKey(s), 'steps', index) } : undefined,
          clockLabel: hasClock(s) ? clockOf(s) : undefined,
          follow,
          onToggleResult: toggleResult,
          onJumpResult: key => jump($, [key], 'start', key, renderInstances.get(key)),
        })
      })
  const bottomControls = clearButtons('-bottom')
  return paneRootView({ Box, Button, Text }, { width, bodyRows, roomy, titleLabel, titleSide, qDone, qTotal: questions.length, qRing, qHidden, qRows, qEmpty, sDone, sTotal: steps.length, sRing, sHidden, sRows, sEmpty, questionClear, answeredClear, stepHeaderControls, bottomControls, questionRows, stepRows, hints, bannerRows })
}
