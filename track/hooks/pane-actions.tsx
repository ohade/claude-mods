import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, PluginState, RenderElement, Timer } from 'claude-code'
import type { Activity, Ledger, Pane, Question, Restore } from '../types'
import { visibleSteps } from './steps'
import { runningClocks } from './ledger-policy'
import { reorderVisibleSteps } from './pane-order'
import { withdrawQuestion, clearQuestionRows } from './question-commands'
import { planStepClear } from './clear-commands'
import { workState } from './work-appearance'
import { NOT_SAVED, counted, restoreStepCount, restoreKey } from './restore-records'
import { PANE, TITLE, PANE_COLUMNS, PANE_ROWS, RULE, EMPTY_LEDGER, IDLE, CLEAR_ARM_MS, rowKey, reason, assertOwner, updateLedger, updateOwnedLedger } from './track-state'
import type { OwnerToken } from './track-state'
import { publishGate, saveLedger, saveFailureText } from './ledger-store'
import { renderInstances, pressOwned, ensureOwner } from './session-owner'

// Atom copies: identical to their register.tsx declarations (tests/helpers/architecture.ts).
const ledger = atom({ plugin: 'track', key: 'ledger' } as const, EMPTY_LEDGER)
const pane = atom({ plugin: 'track', key: 'pane' } as const, { isOpen: false, hidden: false, closedByPerson: false } as Pane)
const flash = atom({ plugin: 'track', key: 'flash' } as const, 0)
const lit = atom({ plugin: 'track', key: 'lit' } as const, [] as string[])
const activity = atom({ plugin: 'track', key: 'activity' } as const, IDLE)
const pulse = atom({ plugin: 'track', key: 'pulse' } as const, 0)
const tick = atom({ plugin: 'track', key: 'tick' } as const, 0)
const clearArm = atom({ plugin: 'track', key: 'clearArm' } as const, null as number | null)
const durability = atom({ plugin: 'track', key: 'durability' } as const, { isUnsaved: false, reason: '' } as PluginState['track']['durability'])



export type PrismantisSegment = { kind: 'markdown' | 'note'; key: string; text: string }
// The built-in diff panel's rule, less its git condition (the tracker does not need git, and a
// session often starts outside a repository): it opens by itself only from this width, in the
// fullscreen layout, and never after the person closed it by hand.
export const AUTO_OPEN_MIN_COLUMNS = 144
export const AUTO_OPEN_DELAY_MS = 50
export const autoOpen = { isScheduled: false }

export const HOTKEYS = 9
// Rows sit this many columns in under their section header, questions and steps alike.
export const ROW_INDENT = 2

// A jump lights the row it lands on, then fades it: the background at each level, brightest
// last, held FLASH_HOLD_MS at full and stepped down every FLASH_STEP_MS.
export const FLASH_SHADES = ['#2b2a1e', '#4a4120', '#6e5a1c'] as const
export const FLASH_HOLD_MS = 1200
export const FLASH_STEP_MS = 250
// The fade's own timers, a generation per jump, and one queue every flash and lit write runs
// through in order, so a fade step already under way cannot clear a newer jump's lit list.
// Module memory, as a reload only cuts a fade short; session.start puts out what is left.
export const fade = { timers: [] as Timer[], generation: 0, queue: Promise.resolve() as Promise<void> }

// An organization's managed plugin can bypass prompt.compose (the debug log then reads "track:
// prompt.compose bypassed by <plugin>"), and a /retro ran its steps unlisted. While the rule has
// not reached the model this session, each prompt that can start work carries the steps
// instruction beside it.
export const STEPS_LINE = RULE

// The step in progress breathes while work runs: one phase every PULSE_MS, a
// spinner and grey shades while the main session works, an hourglass and amber shades while it
// waits on agents. The phase is $.state, so each tick redraws the pane alone.
export const PULSE_MS = 400
export const PULSE_PHASES = 12

export const pulsing: { timer?: Timer } = {}
// Each step row ends in its wall clock. It moves every second under an hour, then once a minute.
export const TICK_MS = 1000
export const HOUR_MS = 3_600_000
export const ticking: { timer?: Timer } = {}

// Below this width the Q/A columns crowd out the question; place them on the next line.
export const COMPACT_COLUMNS = 40
export const HINT = '/track hides · ctrl+x x closes for good'
export const NONE_YET = '  None yet.'
export const ALL_CLEARED = '  all cleared'
export const regions = { qTop: 0, qBottom: 0, sTop: 0, sBottom: 0, qStart: 0, sStart: 0, qLast: 0, sLast: 0, last: 'steps' as 'questions' | 'steps' }
// Fast wheel ticks are summed and written once per SCROLL_FLUSH_MS, so a quick flick costs one
// state write and one redraw, not one per tick (one write per tick made the pane lag).
export const SCROLL_FLUSH_MS = 30
export const pendingScroll: { questions: number; steps: number; timer?: Timer } = { questions: 0, steps: 0 }

// The engine's words around a message typed mid-turn, if the delivered row carries them; they
// are not the person's, and would hide a slash command from the check on the head.
export const MIDTURN_FRAME = /^\s*(<system-reminder>\s*)?The user sent a new message while you were working:\s*/


// Ring glyph for a completion fraction; `○ —` when there is nothing to count.
export const ring = (done: number, total: number): string => {
  if (total === 0) return '○ —'
  const pct = Math.round((100 * done) / total)
  const glyph = pct >= 100 ? '●' : pct >= 75 ? '◕' : pct >= 50 ? '◑' : pct >= 25 ? '◔' : '○'

  return `${glyph} ${done} of ${total} · ${pct}%`
}



export const statusGlyph = (q: Question): string => (q.status === 'answered' ? '●' : q.status === 'deferred' ? '◌' : '○')

export const shade = (level: number): string | undefined => (level > 0 ? FLASH_SHADES[Math.min(level, FLASH_SHADES.length) - 1] : undefined)

// Prismantis draws a message inside its own fill, which covers Track's outer shade, so the same
// level is handed to it under the key its drawing reads: answer:<answerKey> for an answer block,
// the full native request id for a plain reply or a prompt. Without Prismantis the call throws
// and Track's own shade is the highlight. A plain answer's answerKey is its bare row key, so the
// row-key test runs first: that reply is tinted under its drawn host, never answer:<row>.
export const ROW_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/
export const tintKey = (l: Ledger, id: string): string | undefined => {
  if (ROW_KEY.test(id)) {
    const host = renderInstances.get(id)
    return host !== undefined && rowKey(host) === id ? host : undefined
  }
  return l.questions.some(q => q.answerKey === id) ? `answer:${id}` : id
}

export async function light($: EngineInterface, id: string, level: number): Promise<void> {
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
export const isPulsing = (l: Ledger, now: Activity): boolean => {
  const state = workState(l, now)

  return now.background.length > 0 || (now.tasks ?? []).length > 0 || state === 'agents' || state === 'tasks' || (state === 'working' && l.steps.some(s => s.status === 'in_progress' && s.cleared !== true))
}

// Started from the pane's drawing when a step should pulse; each tick stops it once nothing does.
export function startPulse($: EngineInterface): void {
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
export function startTick($: EngineInterface): void {
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
export const serially = (op: () => Promise<void>): Promise<void> => {
  const run = fade.queue.then(op)
  fade.queue = run.catch(() => undefined)

  return run
}

// Lights the rows a jump lands on and fades them out; a new jump puts out the last one first.
// A fade step of an older jump finds a newer generation and leaves the rows to it.
export async function flashRows($: EngineInterface, ids: string[]): Promise<void> {
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
export async function jump($: EngineInterface, ids: string[], block: 'start' | 'end', key?: string, instance?: string): Promise<void> {
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
export function withdraw($: EngineInterface, id: number, drawnFor: string | undefined): Promise<void> {
  return pressOwned($, async token => {
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
}

// Called from a prompt redraw, which only draws: the cheap viewport test runs here, and the
// store read and the open run from a timer, where state may be written.
export async function scheduleAutoOpen($: EngineInterface, viewport: { columns?: number; isFullscreen?: boolean } | undefined): Promise<void> {
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





export async function renderRestore($: EngineInterface, ui: ReturnType<EngineInterface['ui']['resolve']>, r: Restore, label: (id: number) => string): Promise<RenderElement> {
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
export function clearQuestions($: EngineInterface): Promise<void> {
  return pressOwned($, async token => {
  await updateLedger($, cur => {
    assertOwner(token, cur)
    return clearQuestionRows(cur)
  })
  await publishGate($, token)
  await saveLedger($, token)
  $.ui.toast('track: questions cleared; open ones are withdrawn on your next prompt.')
})
}

export function clearSteps($: EngineInterface): Promise<void> {
  return pressOwned($, async token => {
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
}

export async function openPane($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS, rows: PANE_ROWS })
  await update($, pane, p => ({ ...p, isOpen: opened.isPlaced }))
  if (!opened.isPlaced) {
    $.ui.toast(`track: the pane did not open — ${opened.reason}`)
  }

  return opened.isPlaced
}

export async function reorderTrackedSteps($: EngineInterface, ids: unknown, token?: OwnerToken): Promise<{ result: string }> {
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
