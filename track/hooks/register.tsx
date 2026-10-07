import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { Activity, Ledger, Pane, Prompt, Question, ScrollAt, Step, Turn } from '../types'

const PANE = 'track'
// The pane's name: its tab label, and its first line, since a lone pane shows no tab.
const TITLE = 'Session Tracker'
const PANE_COLUMNS = 48
// Rows the pane asks for when it sits inline above the prompt (main screen or narrow terminal).
const PANE_ROWS = 16
// The rewind check a prompt-hint redraw schedules: run after this delay, at most once per gap.
// Module memory, not $.state: a reload only resets the debounce.
const REWIND_CHECK_DELAY_MS = 1000
const REWIND_CHECK_GAP_MS = 3000
const rewindCheck = { isScheduled: false, lastAt: -Infinity }
// The built-in diff panel's rule, less its git condition (the tracker does not need git, and a
// session often starts outside a repository): it opens by itself only from this width, in the
// fullscreen layout, and never after the person closed it by hand.
const AUTO_OPEN_MIN_COLUMNS = 144
const AUTO_OPEN_DELAY_MS = 50
const autoOpen = { isScheduled: false }
// Saved registers kept across sessions, the newest first; older buckets are deleted. The store
// holds 4 MiB of JSON in all, so the buckets keep under STORE_BUDGET characters together, which
// leaves room for the index and the closed-by-hand flag.
const MAX_SESSIONS = 20
const STORE_BUDGET = 3 * 1024 * 1024
// The store key of the buckets' index: per session id, when its bucket was saved and its size.
const SAVED_INDEX = 'saved'
const TRACK_QUESTION = 'mcp__track__track_question'
const MARK_ANSWERED = 'mcp__track__mark_answered'
const MARK_STEP = 'mcp__track__mark_step'
const TRACK_STEPS = 'mcp__track__track_steps'
const RESTORE_STEPS = 'mcp__track__restore_steps'
// A Claude Code session id; restore_steps reads only the store key of a real one.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_STEPS = 300
const MAX_PLAN_STEPS = 30
// paused: started, then parked; waiting: needs the person's answer.
const STEP_STATUSES = ['pending', 'in_progress', 'completed', 'paused', 'waiting'] as const
const QUESTION_STATUSES = ['open', 'answered', 'deferred'] as const

// Caps: heads are short, lists are bounded, so the ledger stays small in $.state and $.store.
// Long enough to keep a question whole; the pane wraps it rather than cutting it.
const HEAD_CHARS = 200
const MAX_PROMPTS = 200
const MAX_QUESTIONS = 200
const HOTKEYS = 9
// Rows sit this many columns in under their section header, questions and steps alike.
const ROW_INDENT = 2

// How many open questions the per-turn context row names.
const OPEN_LISTED = 5

// A jump lights the row it lands on, then fades it: the background at each level, brightest
// last, held FLASH_HOLD_MS at full and stepped down every FLASH_STEP_MS.
const FLASH_SHADES = ['#2b2a1e', '#4a4120', '#6e5a1c'] as const
const FLASH_HOLD_MS = 1200
const FLASH_STEP_MS = 250
// The fade's own timers, a generation per jump, and one queue every flash and lit write runs
// through in order, so a fade step already under way cannot clear a newer jump's lit list.
// Module memory, as a reload only cuts a fade short; session.start puts out what is left.
const fade = { timers: [] as Timer[], generation: 0, queue: Promise.resolve() as Promise<void> }

// The standing rule, sent once per request as a byte-stable system-prompt section.
// The steps instruction, one wording for the standing rule, the per-prompt line and the tool.
const STEPS =
  'For work of more than one step (a skill or slash command such as /retro, a plan, a multi-step task), call mcp__track__track_steps with the steps before the first one; when new work joins a running plan (review comments, a follow-up), call it with `after` set to the id of the step the new ones follow. Mark each step with mcp__track__mark_step as you go: paused when you park it, waiting when it needs the user\'s answer.'

const RULE = [
  'track: if the user\'s prompt is a question, call mcp__track__track_question with a one-line summary before answering',
  '(one call per distinct question). Write the answer, then call mcp__track__mark_answered with status "answered",',
  `or "deferred" with a note if it must wait. ${STEPS}`,
].join(' ')

// An organization's managed plugin can bypass prompt.compose (the debug log then reads "track:
// prompt.compose bypassed by <plugin>"), and a /retro ran its steps unlisted. While the rule has
// not reached the model this session, each prompt that can start work carries the steps
// instruction beside it.
const STEPS_LINE = `track: ${STEPS} If the prompt asks a question, call mcp__track__track_question before answering.`

// The banner pinned at the bottom of the pane: what the session is doing, in one colored line.
const BANNERS = {
  working: { text: ' Working ', color: 'suggestion' },
  agents: { text: ' Waiting on agents ', color: 'warning' },
  you: { text: ' Waiting on you ', color: 'permission' },
  done: { text: ' Safe to close ', color: 'success' },
} as const
// The step in progress breathes while work runs: one phase every PULSE_MS, a
// spinner and grey shades while the main session works, an hourglass and amber shades while it
// waits on agents. The phase is $.state, so each tick redraws the pane alone.
const PULSE_MS = 400
const PULSE_PHASES = 12
const SPINNER = ['◐', '◓', '◑', '◒'] as const
const GREY_SHADES = ['#5f6670', '#7a828c', '#979fa9', '#b4bcc6', '#979fa9', '#7a828c'] as const
const AMBER_SHADES = ['#7a5410', '#9a6c16', '#bb861d', '#dba126', '#bb861d', '#9a6c16'] as const
const pulsing: { timer?: Timer } = {}

// The pane's layout: the title pinned at the top, the banner and footer pinned at the bottom,
// and between them Questions and Steps, each a fixed region that scrolls alone. Questions get
// about a third of the room; room one side does not need goes to the other. `regions` is where the last drawing put each region, for routing a wheel tick.
const QUESTION_SHARE = 0.35
// Columns a question row spends on its dot, its [ Q ] [ A ] buttons and ✕.
const QUESTION_CHROME = 18
// Columns between the items of a header or bar; a narrow pane wraps between items, never inside one.
const HEADER_GAP = 2
const HINT = '/track hides · ctrl+x x closes for good'
const NO_QUESTIONS = '  none yet — the model adds a question with track_question'
const NO_STEPS = '  none yet — tasks and approved plan steps appear here'
const ALL_CLEARED = '  all cleared'
const regions = { qTop: 0, qBottom: 0, sTop: 0, sBottom: 0, qStart: 0, sStart: 0, qLast: 0, sLast: 0, last: 'steps' as 'questions' | 'steps' }
// Fast wheel ticks are summed and written once per SCROLL_FLUSH_MS, so a quick flick costs one
// state write and one redraw, not one per tick (one write per tick made the pane lag).
const SCROLL_FLUSH_MS = 30
const pendingScroll: { questions: number; steps: number; timer?: Timer } = { questions: 0, steps: 0 }
// A stored position never runs past the last one that shows anything (observed: 733 for 20 steps).
const clampTo = (last: number, value: number): number => Math.min(last, Math.max(0, value))

// The rows from `start` whose lines fit `rows`: [start, end).
const windowOf = (lines: number[], rows: number, start: number): [number, number] => {
  let end = start
  let used = 0
  while (rows > 0 && end < lines.length && used + (lines[end] ?? 1) <= rows) {
    used += lines[end] ?? 1
    end++
  }

  return [start, rows > 0 && end === start && start < lines.length ? start + 1 : end]
}

// The first row from which the list's last rows fill `rows`.
const lastStart = (lines: number[], rows: number): number => {
  let start = lines.length
  let used = 0
  while (start > 0 && used + (lines[start - 1] ?? 1) <= rows) {
    used += lines[start - 1] ?? 1
    start--
  }

  return Math.min(start, Math.max(0, lines.length - 1))
}

// The newest `max` rows. Room is made from the oldest rows already cleared, then the oldest done
// ones; an open question or an unfinished step goes only when no spent row is left.
const capRows = <T extends { cleared?: true }>(rows: T[], max: number, isDone: (row: T) => boolean): T[] => {
  let excess = rows.length - max
  if (excess <= 0) {
    return rows
  }
  const dropped = new Set<T>()
  for (const isSpent of [(row: T) => row.cleared === true, isDone, () => true]) {
    for (const row of rows) {
      if (excess > 0 && !dropped.has(row) && isSpent(row)) {
        dropped.add(row)
        excess--
      }
    }
  }

  return rows.filter(row => !dropped.has(row))
}

const capSteps = (steps: Step[]): Step[] => capRows(steps, MAX_STEPS, s => s.status === 'completed')

// Lines `text` takes word-wrapped at `width` columns, as the terminal wraps it: a word that does
// not fit starts a new line, and a word longer than a line is broken.
const wrappedLines = (text: string, width: number): number => {
  let lines = 1
  let used = 0
  for (const word of text.split(' ')) {
    if (used > 0 && used + 1 + word.length <= width) {
      used += 1 + word.length
    } else if (word.length > 0) {
      const extra = Math.floor((word.length - 1) / width)
      lines += (used > 0 ? 1 : 0) + extra
      used = word.length - extra * width
    }
  }

  return lines
}

// Rows a header or bar takes when its items wrap at `width`: each item stays whole, `gap` apart.
const flowRows = (items: number[], width: number, gap: number): number => {
  let rows = 1
  let used = 0
  for (const item of items.filter(w => w > 0)) {
    if (used > 0 && used + gap + item > width) {
      rows++
      used = item
    } else {
      used = used === 0 ? item : used + gap + item
    }
  }

  return rows
}

// The columns a button takes: the engine draws a hotkey button as "q: label".
const buttonWidth = (hotkey: string, label: string): number => hotkey.length + 2 + label.length

// A row's text, cut with an ellipsis to the lines it may take: for a row taller than its whole
// region, whose last lines no scroll could reach.
const fitLines = (text: string, width: number, lines: number): string => {
  const most = Math.max(1, lines)
  if (wrappedLines(text, width) <= most) {
    return text
  }
  let cut = Math.max(1, width * most - 1)
  while (cut > 1 && wrappedLines(`${text.slice(0, cut).trimEnd()}…`, width) > most) {
    cut--
  }

  return `${text.slice(0, cut).trimEnd()}…`
}

const hidden = (above: number, below: number): string =>
  [above > 0 ? `↑${above}` : '', below > 0 ? `↓${below}` : ''].filter(Boolean).join(' ')

// A background task's id in its notification text.
const TASK_ID = /<task-id>([^<]+)<\/task-id>/g

const EMPTY_LEDGER: Ledger = { v: 1, nextQuestionId: 1, prompts: [], questions: [], steps: [] }

const ledger = atom({ plugin: 'track', key: 'ledger' } as const, EMPTY_LEDGER)
const turn = atom({ plugin: 'track', key: 'turn' } as const, { currentId: null, gatedTurnId: null } as Turn)
const pane = atom({ plugin: 'track', key: 'pane' } as const, { isOpen: false, hidden: false, closedByPerson: false } as Pane)
// One level per transcript row (by its requestId, or `text:` and a key for an answer's text):
// 0 unlit, up to FLASH_SHADES.length at full. `lit` names the rows a jump lit.
const flash = atom({ plugin: 'track', key: 'flash' } as const, 0)
const lit = atom({ plugin: 'track', key: 'lit' } as const, [] as string[])
const IDLE: Activity = { isWorking: false, agentCalls: [], askCalls: [], background: [] }
const activity = atom({ plugin: 'track', key: 'activity' } as const, IDLE)
const pulse = atom({ plugin: 'track', key: 'pulse' } as const, 0)
// Each region's first shown row; null follows the news (the newest question, the step at work).
const scrollAt = atom({ plugin: 'track', key: 'scroll' } as const, { questions: null, steps: null } as ScrollAt)

// The transcript draws a prompt row under the stored row's id with its last group zeroed
// (observed on 2.1.289, see image-thumbs), so both sides key on the first four groups.
// The UserMessage render later writes the real requestId over this provisional key.
const rowKey = (id: string): string => id.split('-').slice(0, 4).join('-')

// The first line of a prompt, without image tags, cut to HEAD_CHARS.
const headOf = (text: string): string => {
  const line = text.replace(/\[Image #\d+\]/g, '').trim().split('\n')[0] ?? ''

  return line.length > HEAD_CHARS ? `${line.slice(0, HEAD_CHARS - 1)}…` : line
}

const truncate = (text: string, width: number): string =>
  text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text

// Ring glyph for a completion fraction; `○ —` when there is nothing to count.
const ring = (done: number, total: number): string => {
  if (total === 0) return '○ —'
  const pct = Math.round((100 * done) / total)
  const glyph = pct >= 100 ? '●' : pct >= 75 ? '◕' : pct >= 50 ? '◑' : pct >= 25 ? '◔' : '○'

  return `${glyph} ${done} of ${total} · ${pct}%`
}

// A title for matching: lowercase, without a leading number or checkbox, punctuation, or
// repeated spaces. A Task links to the plan step whose normalized title is the same.
const norm = (title: string): string =>
  title
    .toLowerCase()
    .replace(/^\s*(?:\d+[.)]|[-*+]\s*\[[ x]\])\s*/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()

// The steps of an approved plan: top-level numbered lines and checkbox lines, outside code
// fences. Plain bullets and prose are context, not steps. `[x]` marks a step done.
const parsePlan = (plan: string): Step[] => {
  const steps: Step[] = []
  let inFence = false
  for (const line of plan.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    const match = inFence ? null : /^(?:\d+[.)]|[-*+]\s*\[([ xX])\])\s+(.+)$/.exec(line)
    if (match !== null && steps.length < MAX_PLAN_STEPS) {
      steps.push({
        id: `plan:${steps.length + 1}`,
        source: 'plan',
        subject: headOf(match[2] ?? ''),
        status: match[1] === 'x' || match[1] === 'X' ? 'completed' : 'pending',
      })
    }
  }

  return steps
}

const statusGlyph = (q: Question): string => (q.status === 'answered' ? '●' : q.status === 'deferred' ? '◌' : '○')

const shade = (level: number): string | undefined => (level > 0 ? FLASH_SHADES[Math.min(level, FLASH_SHADES.length) - 1] : undefined)

const light = ($: EngineInterface, id: string, level: number) => update($, memberOf(flash, { requestId: id }), () => level)

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const isDefined = <T,>(value: T | undefined): value is T => value !== undefined

// `{ [key]: value }` when value is a string, else nothing: an optional text field of a saved row.
const textField = <K extends string>(key: K, value: unknown): Partial<Record<K, string>> =>
  typeof value === 'string' ? ({ [key]: value } as Record<K, string>) : {}

// What the session is doing: the person's question dialog first, then agents, then the turn;
// after the turn, running background work, then anything still open, else safe to close.
const sessionState = (l: Ledger, now: Activity): keyof typeof BANNERS => {
  const unfinished = l.questions.some(q => q.status === 'open' || q.status === 'deferred') || l.steps.some(s => s.status !== 'completed')
  if (now.askCalls.length > 0) return 'you'
  if (now.agentCalls.length > 0) return 'agents'
  if (now.isWorking) return 'working'
  if (now.background.length > 0) return 'agents'

  return unfinished ? 'you' : 'done'
}

// Waiting on agents always pulses (the banner blinks amber); the main session's work pulses only
// the step in progress, so with none there is nothing to animate.
const isPulsing = (l: Ledger, now: Activity): boolean => {
  const state = sessionState(l, now)

  return state === 'agents' || (state === 'working' && l.steps.some(s => s.status === 'in_progress' && s.cleared !== true))
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
const jump = async ($: EngineInterface, ids: string[], block: 'start' | 'end'): Promise<void> => {
  const target = { to: { requestId: ids[0] as string }, block }
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

// $.session.messages() answers at most this many entries; past it, older tool calls look
// absent though they are not, so the rewind check does nothing.
const MESSAGES_CAP = 4096

// /rewind raises no event, so detect it from the transcript: a question whose
// track_question call is gone was asked in a rewound turn, and an answer whose
// mark_answered call is gone was rewound. Only work since the last compaction is judged,
// since compaction removes old tool calls as well.
const dropRewound = async ($: EngineInterface): Promise<void> => {
  const l = await read($, ledger)
  const since = l.compactedAt ?? 0
  const judged = (q: Question) =>
    (q.trackedBy !== undefined && q.at > since) || (q.answerRequestId !== undefined && (q.answeredAt ?? 0) > since)
  if (!l.questions.some(judged)) {
    return
  }
  const messages = await $.session.messages()
  if (!Array.isArray(messages) || messages.length >= MESSAGES_CAP) {
    return
  }
  const present = new Set(messages.flatMap(m => m.toolUses.map(u => u.tool_use_id)))
  const isRewound = (q: Question) => q.trackedBy !== undefined && q.at > since && !present.has(q.trackedBy)
  const answerRewound = (q: Question) =>
    q.answerRequestId !== undefined && (q.answeredAt ?? 0) > since && !present.has(q.answerRequestId)
  if (!l.questions.some(q => isRewound(q) || answerRewound(q))) {
    return
  }
  await update<Ledger>($, ledger, cur => ({
    ...cur,
    questions: cur.questions
      .filter(q => !isRewound(q))
      .map(q => {
        if (!answerRewound(q)) return q
        const { answerRequestId: _a, answeredAt: _t, note: _n, answerKey: _k, ...rest } = q

        return { ...rest, status: 'open' as const }
      }),
  }))
}

// ✕ on a question: it leaves the ledger and both counts, and the next prompt tells the
// model not to answer it. The Stop gate stops holding the turn for it, as it is gone.
const withdraw = async ($: EngineInterface, id: number): Promise<void> => {
  const q = (await read($, ledger)).questions.find(one => one.id === id)
  if (q === undefined) {
    return
  }
  await update<Ledger>($, ledger, cur => ({
    ...cur,
    questions: cur.questions.filter(one => one.id !== id),
    withdrawn: [...(cur.withdrawn ?? []), { id, head: q.head }],
  }))
  $.ui.toast(`track: Q${id} removed; the model is told on your next prompt.`)
}

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
      const closedByPerson = (await $.store.get('closedByPerson')) === true
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

type SavedIndex = Record<string, { at: number; bytes: number }>

// Every saved bucket with its time and size. Two sessions saving at once can each write the index
// without the other's entry; a bucket the index does not list is read once for both, so it is
// pruned by its age like the rest and never kept for good.
const savedIndex = async ($: EngineInterface): Promise<SavedIndex> => {
  const keys = await $.store.keys()
  const raw = await $.store.get(SAVED_INDEX)
  const listed = typeof raw === 'object' && raw !== null ? (raw as Record<string, { at?: unknown; bytes?: unknown } | null>) : {}
  const index: SavedIndex = {}
  for (const key of keys.filter(k => k.startsWith('s:'))) {
    const id = key.slice(2)
    const row = listed[id]
    if (typeof row?.at === 'number' && typeof row.bytes === 'number') {
      index[id] = { at: row.at, bytes: row.bytes }
      continue
    }
    const bucket = (await $.store.get(key)) as { savedAt?: unknown } | undefined
    index[id] = { at: typeof bucket?.savedAt === 'number' ? bucket.savedAt : 0, bytes: JSON.stringify(bucket ?? null).length }
  }
  // The list an earlier version kept: the buckets themselves now say the same.
  if (keys.includes('sessions')) {
    await $.store.delete('sessions')
  }

  return index
}

// The register survives the process: one bucket per session id. The oldest buckets go before the
// new one is written, since a write that takes the store past 4 MiB is refused. A failed save is
// logged and never throws, so the turn and a /clear go on.
const saveLedger = async ($: EngineInterface): Promise<void> => {
  try {
    const id = await $.session.id()
    const bucket = { v: 1, savedAt: Date.now(), ledger: await read($, ledger) }
    const bytes = JSON.stringify(bucket).length
    const others = Object.entries(await savedIndex($))
      .filter(([other]) => other !== id)
      .sort(([, a], [, b]) => b.at - a.at)
    const kept: SavedIndex = {}
    let used = bytes
    let isFull = false
    for (const [other, row] of others) {
      isFull = isFull || Object.keys(kept).length + 1 >= MAX_SESSIONS || used + row.bytes > STORE_BUDGET
      if (isFull) {
        await $.store.delete(`s:${other}`)
      } else {
        kept[other] = row
        used += row.bytes
      }
    }
    await $.store.set(`s:${id}`, bucket)
    await $.store.set(SAVED_INDEX, { ...kept, [id]: { at: bucket.savedAt, bytes } })
  } catch (error) {
    $.ui.log(`track: save failed: ${reason(error)}`, { to: 'debug' })
  }
}

// A saved prompt or question as a fresh row, or undefined when the row is not one.
const savedPrompt = (row: unknown): Prompt | undefined => {
  if (typeof row !== 'object' || row === null) {
    return undefined
  }
  const r = row as Record<string, unknown>
  if (typeof r.rowKey !== 'string' || typeof r.head !== 'string' || typeof r.at !== 'number') {
    return undefined
  }

  return { rowKey: r.rowKey, head: headOf(r.head), at: r.at, turnId: typeof r.turnId === 'string' ? r.turnId : null, ...textField('requestId', r.requestId) }
}

const savedQuestion = (row: unknown): Question | undefined => {
  if (typeof row !== 'object' || row === null) {
    return undefined
  }
  const r = row as Record<string, unknown>
  const status = QUESTION_STATUSES.find(one => one === r.status)
  if (typeof r.id !== 'number' || typeof r.head !== 'string' || typeof r.at !== 'number' || status === undefined) {
    return undefined
  }

  return {
    id: r.id,
    head: headOf(r.head),
    at: r.at,
    turnId: typeof r.turnId === 'string' ? r.turnId : null,
    status,
    ...textField('rowKey', r.rowKey),
    ...textField('askedRequestId', r.askedRequestId),
    ...textField('answerRequestId', r.answerRequestId),
    ...textField('answerKey', r.answerKey),
    ...textField('trackedBy', r.trackedBy),
    ...(typeof r.note === 'string' && { note: r.note.slice(0, HEAD_CHARS) }),
    ...(typeof r.answeredAt === 'number' && { answeredAt: r.answeredAt }),
    ...(r.cleared === true && { cleared: true as const }),
  }
}

// A saved step as a fresh Step, or undefined when the row is not one: restore_steps reads rows
// another session saved, and copies only the fields a step has.
const savedStep = (row: unknown): Step | undefined => {
  if (typeof row !== 'object' || row === null) {
    return undefined
  }
  const r = row as Record<string, unknown>
  const source = (['task', 'todo', 'plan'] as const).find(one => one === r.source)
  const status = STEP_STATUSES.find(one => one === r.status)
  if (typeof r.id !== 'string' || typeof r.subject !== 'string' || source === undefined || status === undefined) {
    return undefined
  }

  return {
    id: r.id,
    source,
    subject: headOf(r.subject),
    status,
    ...(typeof r.taskId === 'string' ? { taskId: r.taskId } : {}),
    ...(r.cleared === true ? { cleared: true as const } : {}),
  }
}

// A saved bucket's register, or undefined when it is not one of this version: a resume reads what
// an earlier version or a damaged store left. Only well-formed rows are kept, and the next
// question id stays above every id kept or withdrawn.
const savedLedger = (raw: unknown): Ledger | undefined => {
  const bucket = raw as { v?: unknown; ledger?: Record<string, unknown> | null } | undefined
  const l = bucket?.ledger
  if (bucket?.v !== 1 || typeof l !== 'object' || l === null) {
    return undefined
  }
  const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  const questions = rows(l.questions).map(savedQuestion).filter(isDefined).slice(-MAX_QUESTIONS)
  const withdrawn = rows(l.withdrawn).filter(
    (w): w is { id: number; head: string } => typeof (w as { id?: unknown })?.id === 'number' && typeof (w as { head?: unknown })?.head === 'string',
  )
  const top = Math.max(0, ...questions.map(q => q.id), ...withdrawn.map(w => w.id))

  return {
    v: 1,
    nextQuestionId: Math.max(top + 1, typeof l.nextQuestionId === 'number' ? l.nextQuestionId : 1),
    prompts: rows(l.prompts).map(savedPrompt).filter(isDefined).slice(-MAX_PROMPTS),
    questions,
    steps: rows(l.steps).map(savedStep).filter(isDefined).slice(-MAX_STEPS),
    ...(withdrawn.length > 0 && { withdrawn }),
    ...(typeof l.compactedAt === 'number' && { compactedAt: l.compactedAt }),
  }
}

// Clear all, per section. Unlike Clear completed, the rows leave and the ring restarts. Open
// and deferred questions are withdrawn, so the model is told not to answer them; ids go on
// counting up, so a later Q<n> never reuses one the model saw.
const clearQuestions = async ($: EngineInterface): Promise<void> => {
  await update<Ledger>($, ledger, cur => ({
    ...cur,
    questions: [],
    withdrawn: [
      ...(cur.withdrawn ?? []),
      ...cur.questions.filter(q => q.status !== 'answered').map(q => ({ id: q.id, head: q.head })),
    ],
  }))
  $.ui.toast('track: questions cleared; open ones are withdrawn on your next prompt.')
}

const clearSteps = async ($: EngineInterface): Promise<void> => {
  await update<Ledger>($, ledger, cur => ({ ...cur, steps: [] }))
  $.ui.toast('track: steps cleared.')
}

const openPane = async ($: EngineInterface): Promise<boolean> => {
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS, rows: PANE_ROWS })
  await update($, pane, p => ({ ...p, isOpen: opened.isPlaced }))
  if (!opened.isPlaced) {
    $.ui.toast(`track: the pane did not open — ${opened.reason}`)
  }

  return opened.isPlaced
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Like /btw: typed while a turn runs, /track acts at once instead of waiting for the turn to
    // end, and the toggle answers with no text, so the session gets no row.
    await $.command.register({
      name: 'track',
      description: 'Show or hide the track pane: questions asked, where answered, and the steps',
      argumentHint: '[status]',
      immediate: true,
    })
    await $.tool.register({
      name: 'track_question',
      description:
        'Register the user\'s current prompt as a question in the track pane. Call it once per distinct question, before answering, with a one-line summary. Returns the question id to pass to mark_answered.',
      inputSchema: {
        type: 'object',
        properties: { summary: { type: 'string', description: 'One line, under 80 characters, restating the question' } },
        required: ['summary'],
      },
    })
    await $.tool.register({
      name: 'mark_answered',
      description:
        'Mark a tracked question answered or deferred. Call it right after writing the answer, so the jump lands under the answer text. status "deferred" needs a note saying what it waits for.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'The question id returned by track_question' },
          status: { type: 'string', enum: ['answered', 'deferred'] },
          note: { type: 'string', description: 'For deferred: what the answer waits for' },
        },
        required: ['id', 'status'],
      },
    })

    await $.tool.register({
      name: 'track_steps',
      description: `Show steps in the track pane. ${STEPS} Without after, the steps replace the plan and get ids plan:1, plan:2, …; with after, they are inserted and get the next free plan ids. Not needed for TaskCreate tasks or an approved plan-mode plan: those appear on their own.`,
      inputSchema: {
        type: 'object',
        properties: {
          steps: { type: 'array', items: { type: 'string' }, description: 'Step titles, in order, each one line' },
          after: { type: 'string', description: 'Insert after this step id (plan:2, task:7, ...) and keep the plan' },
        },
        required: ['steps'],
      },
    })
    await $.tool.register({
      name: 'restore_steps',
      description:
        'After a handoff (a /clear that seeds a fresh session), copy the previous session\'s steps into this session\'s track pane, in order, with their ids and statuses; its questions are not copied. from_session is the previous session id (the handoff brief\'s session: field). Refuses when this session already has steps, unless replace is true.',
      inputSchema: {
        type: 'object',
        properties: {
          from_session: { type: 'string', description: 'The previous session id' },
          replace: { type: 'boolean', description: 'Replace the steps this session already has' },
        },
        required: ['from_session'],
      },
    })
    await $.tool.register({
      name: 'mark_step',
      description:
        'Set a step\'s status in the track pane as you work: in_progress when you start it, completed when done, paused when you park it unfinished, waiting when it needs the user\'s answer. Ids: plan:1, plan:2, … (from track_steps or the approved plan), task:<taskId>, todo:<the todo text, lowercased>. For Tasks, TaskUpdate does this already.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, status: { type: 'string', enum: [...STEP_STATUSES] } },
        required: ['id', 'status'],
      },
    })

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

  // Every typed prompt is recorded before the model runs: its provisional row key and a short head.
  // A subagent's prompt row carries agentId and is not the person's.
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }
    const text = e.message.content.map(block => (block.type === 'text' ? String(block.text) : '')).join('\n')
    const head = headOf(text)
    if (head === '' || head.startsWith('/')) {
      return next(e)
    }
    const prompt: Prompt = { rowKey: rowKey(e.uuid), head, turnId: null, at: Date.now() }
    await update($, ledger, l => ({ ...l, prompts: [...l.prompts, prompt].slice(-MAX_PROMPTS) }))

    return next(e)
  })

  // The model's last text row, by its row key: the answer a mark_answered call follows. The
  // engine draws an assistant row under its uuid with the last group zeroed, as a prompt row.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const hasText = e.message.content.some(block => block.type === 'text' && String(block.text).trim() !== '')
    if (e.agentId === undefined && hasText) {
      const t = await read($, turn)
      await update($, turn, cur => ({ ...cur, lastText: { row: rowKey(e.uuid), turnId: t.currentId } }))
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, turn, t => ({ ...t, currentId: e.turnId }))
    await update($, activity, a => ({ ...a, isWorking: true }))
    await update($, ledger, l => ({
      ...l,
      prompts: l.prompts.map(p => (p.turnId === null ? { ...p, turnId: e.turnId } : p)),
      questions: l.questions.map(q => (q.turnId === null ? { ...q, turnId: e.turnId } : q)),
    }))

    return next(e)
  })

  // The standing rule: one byte-stable system-prompt section, appended last (scope `session`),
  // so the prompt cache holds across turns. Everything that changes per turn goes in the
  // prompt.submit context row instead.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    // The rule reaches the model this session, so prompts need not carry the steps line.
    if ((await read($, turn)).composeSeen !== true) {
      await update($, turn, t => ({ ...t, composeSeen: true as const }))
    }

    return { sections: [...composed.sections, { id: 'track:rule', text: RULE, scope: 'session' as const }] }
  })

  // The per-turn reminder: a short row beside the prompt, only while something is open.
  on('prompt.submit', async ($, e, next) => {
    // A finished background task or agent says so in its notification: it leaves the banner.
    if (e.origin?.kind === 'task-notification') {
      const done = [...e.text.matchAll(TASK_ID)].map(m => m[1])
      if (done.length > 0) {
        await update($, activity, a => ({ ...a, background: a.background.filter(id => !done.includes(id)) }))
      }
    }
    await dropRewound($)
    const typed = e.origin?.kind === 'composer'
    // A plugin's prompt (Plannotator's review comments) can add work to a running plan.
    const fromPlugin = e.origin?.kind === 'plugin'
    const needsSteps = (typed || fromPlugin) && (await read($, turn)).composeSeen !== true
    if (e.text.trim().startsWith('/')) {
      // /track and the built-in commands reach no main-loop work: nothing rides on them, and a
      // withdrawn question waits for a prompt the model reads. A skill's slash command reaches the
      // model and starts work, so it carries what a typed prompt carries.
      const name = /^\/([^\s]+)/.exec(e.text.trim())?.[1] ?? ''
      if (name === 'track' || (await $.command.list()).some(c => c.name === name && c.source === 'builtin')) {
        return next(e)
      }
    }
    const lines: string[] = needsSteps ? [STEPS_LINE] : []
    const l = await read($, ledger)
    // A question the user withdrew with ✕ is told to the model once, on whatever prompt it reads next.
    const withdrawn = l.withdrawn ?? []
    if (withdrawn.length > 0) {
      const named = withdrawn.map(w => `Q${w.id} "${truncate(w.head, 60)}"`).join(', ')
      lines.push(`track: the user withdrew ${named}; do not answer ${withdrawn.length > 1 ? 'them' : 'it'}.`)
      await update<Ledger>($, ledger, cur => ({ ...cur, withdrawn: [] }))
    }
    const open = l.questions.filter(q => q.status === 'open' || q.status === 'deferred')
    const stepsLeft = l.steps.filter(s => s.status !== 'completed').length
    if (!(typed || fromPlugin) || (open.length === 0 && stepsLeft === 0)) {
      return lines.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...lines] })
    }
    const listed = open
      .slice(-OPEN_LISTED)
      .map(q => `Q${q.id} "${truncate(q.head, 60)}"${q.status === 'deferred' ? ' (deferred)' : ''}`)
      .join(', ')
    const done = l.steps.length - stepsLeft
    // The step still marked in progress, named: an approval and a new request once left a step
    // pulsing, because nothing told the model it was open.
    const busy = l.steps.filter(s => s.status === 'in_progress' && s.cleared !== true)
    const them = busy.length > 1 ? 'them' : 'it'
    const inProgress =
      busy.length === 0
        ? ''
        : ` In progress: ${busy.map(s => `${s.id} "${truncate(s.subject, 60)}"`).join(', ')}; if this prompt finishes, replaces or drops ${them}, mark ${them} with mcp__track__mark_step first.`
    const line = `track: open ${listed || 'none'}${open.length > OPEN_LISTED ? ` (+${open.length - OPEN_LISTED} more)` : ''}; steps ${done} of ${l.steps.length} done.${inProgress} Mark a question with mcp__track__mark_answered when you answer it.`

    return next({ ...e, context: [...(e.context ?? []), ...lines, line] })
  })

  // The gate: after the settings Stop hooks have run (and only when none of them blocked),
  // hold the turn once when a question the model tracked this turn is still open. The catch
  // replays the chain, so a failure here can never add or erase a block.
  on('classic.Stop', async ($, e, next) => {
    const below = await next(e)
    // Stop lists the background work still in flight: a task whose notification never came
    // (killed, or lost) leaves the banner here.
    if (e.agent_id === undefined && Array.isArray(e.background_tasks)) {
      const inFlight = e.background_tasks.map(task => task.id)
      await update($, activity, a => ({ ...a, background: inFlight }))
    }
    if (below.block !== undefined || e.stop_hook_active || e.agent_id !== undefined) {
      return below
    }
    const t = await read($, turn)
    if (t.currentId === null || t.gatedTurnId === t.currentId) {
      return below
    }
    const l = await read($, ledger)
    const open = l.questions.filter(q => q.status === 'open' && q.turnId === t.currentId)
    if (open.length === 0) {
      return below
    }
    await update($, turn, cur => ({ ...cur, gatedTurnId: t.currentId }))
    const first = open[0] as Question
    const rest = open.length > 1 ? ` (${open.length - 1} more open: ${open.slice(1).map(q => `Q${q.id}`).join(', ')})` : ''

    return {
      ...below,
      block: `track: Q${first.id} "${first.head}" from this turn is still open${rest}. If you answered it, call mcp__track__mark_answered({ id: ${first.id}, status: "answered" }); if it must wait, status "deferred" with a note. Then finish.`,
    }
  }).catch(($, e, next) => next(e))

  // Compaction removes old tool calls from the transcript; record when, so the rewind check
  // never mistakes compacted questions for rewound ones.
  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    if (e.agentId === undefined && !('skip' in compacted)) {
      await update<Ledger>($, ledger, l => ({ ...l, compactedAt: Date.now() }))
    }

    return compacted
  })

  // Each finished main-loop turn saves the ledger, so /resume finds it.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, activity, a => ({ ...a, isWorking: false, agentCalls: [], askCalls: [] }))
    } else {
      // A background agent's loop ended.
      const agentId = e.agentId
      await update($, activity, a => ({ ...a, background: a.background.filter(id => id !== agentId) }))
    }
    const done = await next(e)
    if (e.agentId === undefined) {
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
    if (e.surface !== 'terminal' || e.props.origin.kind !== 'composer') {
      return drawn
    }
    // A jump to this prompt lights it, fading back over FLASH_HOLD_MS and the steps after it.
    const level = await read($, memberOf(flash, e))
    const { Box } = $.ui.resolve(e)
    const row = level > 0 ? <Box backgroundColor={shade(level)}>{drawn}</Box> : drawn
    const l = await read($, ledger)
    const key = rowKey(e.requestId)
    const isLinked = (requestId: string | undefined) => requestId === e.requestId
    const stale = l.prompts.some(p => p.rowKey === key && !isLinked(p.requestId)) || l.questions.some(q => q.rowKey === key && !isLinked(q.askedRequestId))
    if (!stale) {
      return row
    }
    $.clock.after(0, () => {
      void update($, ledger, cur => ({
        ...cur,
        prompts: cur.prompts.map(p => (p.rowKey === key ? { ...p, requestId: e.requestId } : p)),
        questions: cur.questions.map(q => (q.rowKey === key ? { ...q, askedRequestId: e.requestId } : q)),
      }))
    })

    return row
  })

  on('tool.call', { tool: TRACK_QUESTION }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'track: a subagent cannot track questions for the user.' }
    }
    const summary = headOf(String(e.summary ?? ''))
    if (summary === '') {
      return { deny: 'track: summary is required.' }
    }
    let minted: Question | undefined
    await update($, ledger, l => {
      const last = l.prompts.at(-1)
      minted = {
        id: l.nextQuestionId,
        head: summary,
        at: Date.now(),
        ...(last?.rowKey !== undefined && { rowKey: last.rowKey }),
        ...(last?.requestId !== undefined && { askedRequestId: last.requestId }),
        ...(e.tool_use_id !== undefined && { trackedBy: e.tool_use_id }),
        turnId: last?.turnId ?? null,
        status: 'open',
      }

      const questions = capRows([...l.questions, minted], MAX_QUESTIONS, q => q.status === 'answered')

      return { ...l, nextQuestionId: l.nextQuestionId + 1, questions }
    })
    const t = await read($, turn)
    if (minted !== undefined && minted.turnId === null && t.currentId !== null) {
      const id = minted.id
      await update($, ledger, l => ({ ...l, questions: l.questions.map(q => (q.id === id ? { ...q, turnId: t.currentId } : q)) }))
    }

    // The Questions region follows the newest question again.
    await update($, scrollAt, cur => ({ ...cur, questions: null }))

    // A plugin tool's result is text (or content blocks), never a bare object.
    return { result: `Tracked as Q${minted?.id}: ${summary}. After answering, call mcp__track__mark_answered({ id: ${minted?.id}, status: "answered" }).` }
  })

  on('tool.call', { tool: MARK_ANSWERED }, async ($, e) => {
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
    // The answer's text row: the last text the model wrote in this turn, if any.
    const t = await read($, turn)
    const answerKey = status === 'answered' && t.lastText !== undefined && t.lastText.turnId === t.currentId ? t.lastText.row : undefined
    await update<Ledger>($, ledger, cur => ({
      ...cur,
      questions: cur.questions.map(({ answerKey: _old, ...q }) =>
        q.id === id
          ? {
              ...q,
              status,
              answeredAt: Date.now(),
              ...(note !== undefined && { note }),
              ...(e.tool_use_id !== undefined && { answerRequestId: e.tool_use_id }),
              ...(answerKey !== undefined && { answerKey }),
            }
          : { ...q, ...(_old !== undefined && { answerKey: _old }) },
      ),
    }))

    return { result: `Q${id} marked ${status}.` }
  })

  // Steps come from the model's own tools, read after each call succeeds. A subagent's
  // calls are its own work, not the session's steps.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const task = (ran.result as { task?: { id?: unknown } } | undefined)?.task
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true || task?.id === undefined) {
      return ran
    }
    const taskId = String(task.id)
    const subject = headOf(String(e.subject ?? ''))
    await update<Ledger>($, ledger, cur => {
      const plan = cur.steps.find(s => s.source === 'plan' && s.taskId === undefined && norm(s.subject) === norm(subject))
      if (plan !== undefined) {
        return { ...cur, steps: cur.steps.map(s => (s.id === plan.id ? { ...s, taskId } : s)) }
      }
      const step: Step = {
        id: `task:${taskId}`,
        source: 'task',
        subject,
        status: 'pending',
        taskId,
        ...(e.tool_use_id !== undefined && { createdRequestId: e.tool_use_id }),
      }

      return { ...cur, steps: capSteps([...cur.steps, step]) }
    })

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    const status = e.status
    const failed = (ran.result as { success?: unknown } | undefined)?.success === false
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true || failed || status === undefined) {
      return ran
    }
    const taskId = String(e.taskId)
    await update<Ledger>($, ledger, cur => ({
      ...cur,
      steps:
        status === 'deleted'
          ? // A deleted Task leaves; a plan step it was linked to stays, unlinked.
            cur.steps
              .filter(s => !(s.source === 'task' && s.taskId === taskId))
              .map(s => {
                if (s.taskId !== taskId) return s
                const { taskId: _unlinked, ...plan } = s

                return plan
              })
          : cur.steps.map(s => (s.taskId === taskId ? { ...s, status } : s)),
    }))

    return ran
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    const todos = (ran.result as { newTodos?: Array<{ content: string; status: Step['status'] }> } | undefined)?.newTodos
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true || todos === undefined) {
      return ran
    }
    // Two todos whose titles normalize alike get #2, #3 after the id, so mark_step reaches each.
    const seen = new Map<string, number>()
    const rows: Step[] = todos.map(t => {
      const base = `todo:${norm(t.content)}`
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)

      return { id: n === 1 ? base : `${base}#${n}`, source: 'todo', subject: headOf(t.content), status: t.status }
    })
    await update<Ledger>($, ledger, cur => ({ ...cur, steps: capSteps([...cur.steps.filter(s => s.source !== 'todo'), ...rows]) }))

    return ran
  })

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    const result = ran.result as { plan?: unknown; isAgent?: unknown } | undefined
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true || typeof result?.plan !== 'string' || result.isAgent === true) {
      return ran
    }
    const steps = parsePlan(result.plan)
    if (steps.length > 0) {
      await update<Ledger>($, ledger, cur => ({ ...cur, steps: capSteps([...cur.steps.filter(s => s.source !== 'plan'), ...steps]) }))
    }

    return ran
  })

  // The banner's inputs: an Agent call in flight, a background agent or shell task, a question
  // dialog for the person. A subagent's own calls are its work, not the session's.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }
    const callId = e.tool_use_id
    await update($, activity, a => ({ ...a, agentCalls: [...a.agentCalls, callId] }))
    try {
      const ran = await next(e)
      const launched = ran.result as { status?: unknown; agentId?: unknown } | undefined
      if (launched?.status === 'async_launched' && typeof launched.agentId === 'string') {
        const agentId = launched.agentId
        await update($, activity, a => ({ ...a, background: [...a.background.filter(id => id !== agentId), agentId] }))
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
    const ran = await next(e)
    const taskId = (ran.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId
    if (e.agentId === undefined && typeof taskId === 'string') {
      await update($, activity, a => ({ ...a, background: [...a.background.filter(id => id !== taskId), taskId] }))
    }

    return ran
  })

  // A plan laid out in chat: its steps replace any earlier plan's, as a new approved plan does.
  on('tool.call', { tool: TRACK_STEPS }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'track: a subagent cannot set the session\'s steps.' }
    }
    await update($, scrollAt, cur => ({ ...cur, steps: null }))
    const titles = (Array.isArray(e.steps) ? e.steps : []).map(t => headOf(String(t))).filter(t => t !== '').slice(0, MAX_PLAN_STEPS)
    if (titles.length === 0) {
      return { result: 'No steps given: pass steps as an array of one-line titles.' }
    }
    const after = typeof e.after === 'string' && e.after !== '' ? e.after : undefined
    if (after !== undefined) {
      // New work joins a running plan: insert after that step, ids after the highest plan id. The
      // ids are taken inside the write, so two calls in flight never take the same ones.
      const l = await read($, ledger)
      if (!l.steps.some(s => s.id === after)) {
        return { result: `No step ${after}. Known steps: ${l.steps.map(s => s.id).join(', ') || 'none'}.` }
      }
      let added: Step[] = []
      await update<Ledger>($, ledger, cur => {
        const top = Math.max(0, ...cur.steps.map(s => Number(/^plan:(\d+)$/.exec(s.id)?.[1] ?? 0)))
        added = titles.map((subject, k) => ({ id: `plan:${top + k + 1}`, source: 'plan', subject, status: 'pending' }))
        const i = cur.steps.findIndex(s => s.id === after)
        const steps = i < 0 ? [...cur.steps, ...added] : [...cur.steps.slice(0, i + 1), ...added, ...cur.steps.slice(i + 1)]

        return { ...cur, steps: capSteps(steps) }
      })

      return { result: `Inserted after ${after}: ${added.map(s => `${s.id} ${s.subject}`).join('; ')}. Mark each with mcp__track__mark_step as you go.` }
    }
    const steps: Step[] = titles.map((subject, i) => ({ id: `plan:${i + 1}`, source: 'plan', subject, status: 'pending' }))
    await update<Ledger>($, ledger, cur => ({ ...cur, steps: capSteps([...cur.steps.filter(s => s.source !== 'plan'), ...steps]) }))

    return { result: `Tracking ${steps.length} steps: ${steps.map(s => `${s.id} ${s.subject}`).join('; ')}. Mark each with mcp__track__mark_step as you go.` }
  })

  // A handoff seeds a fresh session, whose pane starts empty. One call copies the old session's
  // steps from the store, keyed by its session id; its questions stay behind.
  // Steps already in the pane are kept unless the call asks to replace them. Task ids start again
  // in every session, so a restored step keeps no link to the old session's Task, and a Task step
  // takes a restored: id, leaving task:<n> to the new session's own Task.
  on('tool.call', { tool: RESTORE_STEPS }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'track: a subagent cannot set the session\'s steps.' }
    }
    const from = typeof e.from_session === 'string' ? e.from_session : ''
    if (!SESSION_ID.test(from)) {
      return { deny: `track: "${truncate(from, 60)}" is not a session id; nothing changed.` }
    }
    const saved = (await $.store.get(`s:${from}`)) as { ledger?: { steps?: unknown } } | undefined
    const rows = Array.isArray(saved?.ledger?.steps) ? (saved.ledger.steps as unknown[]) : []
    const steps = rows
      .map(savedStep)
      .filter(isDefined)
      .map(({ taskId: _old, ...s }) => (s.source === 'task' && !s.id.startsWith('restored:') ? { ...s, id: `restored:${s.id}` } : s))
      .slice(-MAX_STEPS)
    if (steps.length === 0) {
      return { deny: `track: No saved steps for session ${from}; nothing changed.` }
    }
    const refusal = (count: number) => `track: this session already has ${count} steps; nothing changed. Pass replace: true to replace them.`
    const current = await read($, ledger)
    if (current.steps.length > 0 && e.replace !== true) {
      return { deny: refusal(current.steps.length) }
    }
    // Checked again inside the write: a second call in flight finds the first one's steps.
    let had = 0
    await update<Ledger>($, ledger, cur => {
      had = e.replace === true ? 0 : cur.steps.length

      return had > 0 ? cur : { ...cur, steps }
    })
    if (had > 0) {
      return { deny: refusal(had) }
    }
    await update($, scrollAt, cur => ({ ...cur, steps: null }))
    const shown = steps.filter(s => s.cleared !== true)
    const at = shown.findIndex(s => s.status === 'in_progress')
    const where = at < 0 ? 'None in progress.' : `In progress: S${at + 1} ${shown[at]?.subject}.`

    return { result: `Restored ${steps.length} steps from session ${from}. ${where}` }
  })

  on('tool.call', { tool: MARK_STEP }, async ($, e) => {
    if (e.agentId !== undefined) {
      return { deny: 'track: a subagent cannot mark the session\'s steps.' }
    }
    const id = String(e.id)
    const status = STEP_STATUSES.find(one => one === e.status)
    const l = await read($, ledger)
    if (status === undefined || !l.steps.some(s => s.id === id)) {
      return { result: `No change. Known steps: ${l.steps.map(s => `${s.id} (${s.status})`).join(', ') || 'none'}.` }
    }
    await update<Ledger>($, ledger, cur => ({ ...cur, steps: cur.steps.map(s => (s.id === id ? { ...s, status } : s)) }))

    return { result: `Step ${id} marked ${status}.` }
  })

  on('command.run', { command: 'track' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'status') {
      const l = await read($, ledger)
      const open = l.questions.filter(q => q.status === 'open').map(q => `Q${q.id} ${q.head}`)

      return { text: `track: ${l.questions.length} questions (${open.length} open), ${l.steps.length} steps.${open.length > 0 ? `\nOpen: ${open.join('; ')}` : ''}` }
    }
    const p = await read($, pane)
    if (p.isOpen) {
      await $.ui.close({ id: PANE })
      await update($, pane, cur => ({ ...cur, isOpen: false, hidden: true }))
      $.ui.toast('track: pane hidden for this session; /track shows it again.')

      return {}
    }
    await update($, pane, cur => ({ ...cur, hidden: false, closedByPerson: false }))
    await $.store.set('closedByPerson', false)
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
        await $.store.set('closedByPerson', true)
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
      const restored = savedLedger(await $.store.get(`s:${e.session_id}`))
      if (restored !== undefined) {
        await update<Ledger>($, ledger, () => restored)
      }
    }

    return next(e)
  }).catch(($, e, next) => {
    $.ui.log(`track: resume failed: ${reason(next.error)}`, { to: 'debug' })

    return next(e)
  })

  // Save the ledger at the end of the session; /clear starts a fresh one.
  on('session.end', async ($, e, next) => {
    await saveLedger($)
    if (e.reason === 'clear') {
      await update<Ledger>($, ledger, () => EMPTY_LEDGER)
      await update($, turn, () => ({ currentId: null, gatedTurnId: null }))
      await update($, activity, () => IDLE)
    }

    return next(e)
  })

  // The model's bookkeeping calls stay quiet in the transcript: track_question, track_steps and
  // restore_steps draw nothing, mark_answered draws one dim line, which is also where "jump to
  // answer" lands.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool === TRACK_QUESTION || e.props.tool === TRACK_STEPS || e.props.tool === RESTORE_STEPS) {
      const { Box } = $.ui.resolve(e)

      return <Box />
    }
    if (e.props.tool === MARK_STEP) {
      const { Text } = $.ui.resolve(e)
      const input = (e.props.input ?? {}) as { id?: unknown; status?: unknown }
      const status = STEP_STATUSES.find(one => one === input.status) ?? 'pending'
      const glyph = status === 'completed' ? '✓' : status === 'in_progress' ? '◧' : status === 'paused' ? '⏸' : status === 'waiting' ? '◆' : '◻'
      // Named as the pane names it, S<n> and the title: an id such as plan:10 can sit third in
      // the pane after an insert, and was read as S10.
      const id = String(input.id ?? '?')
      const shown = (await read($, ledger)).steps.filter(s => s.cleared !== true)
      const at = shown.findIndex(s => s.id === id)
      const step = shown[at]
      const name = step === undefined ? id : `S${at + 1} ${truncate(step.subject, 60)}`

      return <Text dimColor>{`${glyph} ${name} ${status.replace('_', ' ')}`}</Text>
    }
    if (e.props.tool === MARK_ANSWERED) {
      const { Text } = $.ui.resolve(e)
      const input = (e.props.input ?? {}) as { id?: unknown; status?: unknown }
      const status = input.status === 'deferred' ? 'deferred' : 'answered'
      const level = await read($, memberOf(flash, e))
      const label = `✓ Q${String(input.id ?? '?')} ${status}`

      return level > 0 ? <Text backgroundColor={shade(level)}>{` ${label} `}</Text> : <Text dimColor>{label}</Text>
    }

    return next(e)
  })

  // The answer's text row, lit with its ✓ row by a jump to the answer. Each row reads only the
  // level kept under its own row key, so a jump redraws the lit row alone.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const level = await read($, memberOf(flash, { requestId: rowKey(e.requestId) }))
    if (level === 0) {
      return next(e)
    }
    const { Box } = $.ui.resolve(e)

    return <Box backgroundColor={shade(level)}>{await next(e)}</Box>
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if ([TRACK_QUESTION, MARK_ANSWERED, TRACK_STEPS, MARK_STEP, RESTORE_STEPS].includes(e.props.tool)) {
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
    const phase = await read($, pulse)
    if (pulsing.timer === undefined && isPulsing(l, now)) {
      startPulse($)
    }
    const width = Math.max(20, e.props.bodyColumns)
    const bodyRows = Math.max(8, e.props.scroll.bodyRows)
    const at = await read($, scrollAt)
    const titleLabel = ` ${TITLE.toUpperCase()} `
    const titleSide = Math.max(2, Math.floor((width - titleLabel.length) / 2))
    // Every uncleared row is listed in both placements; the pane body scrolls, so older rows
    // stay reachable above the newest (track_question scrolls the newest into view).
    // The rings count the rows shown: a cleared row leaves its ring too. A deferred answer still
    // waits, so it is not done, and clear completed keeps it.
    const questions = l.questions.filter(q => q.cleared !== true)
    const qDone = questions.filter(q => q.status === 'answered').length
    const steps = l.steps.filter(s => s.cleared !== true)
    const sDone = steps.filter(s => s.status === 'completed').length
    const clearCompleted = () =>
      void update($, ledger, cur => ({
        ...cur,
        questions: cur.questions.map(q => (q.status === 'answered' ? { ...q, cleared: true as const } : q)),
        steps: cur.steps.map(s => (s.status === 'completed' ? { ...s, cleared: true as const } : s)),
      }))
    // The steps' two clear controls, above the steps and again below them. Both sit outside the
    // scrolling region, so a scroll never moves them. The copies share hotkeys: the engine lets the
    // later one win, and both do the same thing. Each is an item of its own, so a narrow pane wraps
    // between them instead of cutting one.
    // A header or bar item keeps its width; the header wraps between items.
    const item = (key: string, child: RenderElement) => (
      <Box key={key} flexShrink={0}>
        {child}
      </Box>
    )
    const clearButtons = (suffix: '' | '-bottom') => [
      ...(l.steps.length > 0
        ? [item(`item-clear-steps${suffix}`, <Button key={`clear-steps${suffix}`} plain dimColor hotkey="s" label="clear all" onPress={() => clearSteps($)} />)]
        : []),
      item(`item-clear-completed${suffix}`, <Button key={`clear-completed${suffix}`} plain dimColor hotkey="c" label="clear completed" onPress={clearCompleted} />),
    ]
    const clearWidths = [l.steps.length > 0 ? buttonWidth('s', 'clear all') : 0, buttonWidth('c', 'clear completed')]

    const state = sessionState(l, now)
    const shown = BANNERS[state]
    const qRing = ring(qDone, questions.length)
    const sRing = ring(sDone, steps.length)
    const qEmpty = l.questions.length === 0 ? NO_QUESTIONS : ALL_CLEARED
    const sEmpty = l.steps.length === 0 ? NO_STEPS : ALL_CLEARED

    // The layout: the title, the two headers, the separator, the bottom bar and the banner take
    // fixed rows, a header or the bar as many as its items wrap onto; the two regions share the
    // room left, measured in wrapped lines.
    const roomy = bodyRows >= 16
    const titleRows = roomy ? 2 : 1
    const bottomRows = flowRows([...clearWidths, HINT.length], width, HEADER_GAP)
    const qButtons = [l.questions.length > 0 ? buttonWidth('q', 'clear all') : 0]
    const sButtons = l.steps.length > 0 ? clearWidths : []
    const qWidth = Math.max(8, width - ROW_INDENT - 2 - QUESTION_CHROME)
    const sWidth = Math.max(8, width - ROW_INDENT - 2)
    const qLines = questions.map(q => wrappedLines(`Q${q.id} ${q.head}`, qWidth))
    const sLines = steps.map((s, i) => wrappedLines(`S${i + 1} ${s.subject}`, sWidth))
    const needQ = questions.length > 0 ? qLines.reduce((a, b) => a + b, 0) : wrappedLines(qEmpty, width)
    const needS = steps.length > 0 ? sLines.reduce((a, b) => a + b, 0) : wrappedLines(sEmpty, width)
    const atWork = steps.findIndex(s => s.status !== 'completed')
    const fit = (qArrows: string, sArrows: string) => {
      const qHead = flowRows(['Questions'.length, qRing.length, ...qButtons, qArrows.length], width, HEADER_GAP)
      const sHead = flowRows(['Steps'.length, sRing.length, ...sButtons, sArrows.length], width, HEADER_GAP)
      const room = Math.max(0, bodyRows - (titleRows + qHead + 1 + sHead + (roomy ? 1 : 0) + bottomRows + 1))
      let qRows = Math.min(needQ, room, Math.max(1, Math.round(room * QUESTION_SHARE)))
      let sRows = Math.max(0, room - qRows)
      if (needS < sRows) {
        qRows = Math.min(needQ, qRows + sRows - needS)
        sRows = needS
      }
      // Where each region starts: the newest questions, the step at work with one done row above.
      const qLast = lastStart(qLines, qRows)
      const sLast = lastStart(sLines, sRows)
      const [qStart, qEnd] = windowOf(qLines, qRows, Math.min(at.questions ?? qLast, qLast))
      const [sStart, sEnd] = windowOf(sLines, sRows, Math.min(at.steps ?? (atWork < 0 ? sLast : Math.max(0, atWork - 1)), sLast))

      return { qHead, sHead, qRows, sRows, qLast, sLast, qStart, qEnd, sStart, sEnd }
    }
    // The rows out of view, as arrows in each header. The arrows can wrap the header onto one more
    // row, which takes a row from the regions, so the layout is fitted again with them.
    const arrowsOf = (f: ReturnType<typeof fit>) => [hidden(f.qStart, questions.length - f.qEnd), hidden(f.sStart, steps.length - f.sEnd)] as const
    const first = fit('', '')
    const [qFirst, sFirst] = arrowsOf(first)
    const fitted = qFirst === '' && sFirst === '' ? first : fit(qFirst, sFirst)
    const { qHead, sHead, qRows, sRows, qLast, sLast, qStart, qEnd, sStart, sEnd } = fitted
    const [qHidden, sHidden] = arrowsOf(fitted)
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
    // Background agents show in the banner while the main turn runs too: the session works and
    // waits on them at once. Waiting on agents blinks amber.
    const running = now.background.length
    const bannerText =
      running === 0 || (state !== 'agents' && state !== 'working')
        ? shown.text
        : state === 'agents'
          ? `${shown.text.trimEnd()} (${running}) `
          : `${shown.text.trimEnd()} · agents (${running}) `
    const bannerColor = state === 'agents' ? AMBER_SHADES[phase % AMBER_SHADES.length] : shown.color

    return (
      <Box flexDirection="column" height={bodyRows} overflow="hidden">
        {/* The title as a centered header bar, rules filling the width. */}
        <Box key="title" flexDirection="row" justifyContent="center" marginBottom={roomy ? 1 : 0}>
          <Text dimColor>{'─'.repeat(titleSide)}</Text>
          <Text bold color="claude">
            {titleLabel}
          </Text>
          <Text dimColor>{'─'.repeat(Math.max(2, width - titleLabel.length - titleSide))}</Text>
        </Box>
        <Box key="questions-header" flexDirection="row" flexWrap="wrap" columnGap={HEADER_GAP}>
          {item('questions-word', <Text bold>Questions</Text>)}
          {item('questions-ring', <Text color={qDone === questions.length && questions.length > 0 ? 'success' : 'warning'}>{qRing}</Text>)}
          {/* The engine draws "q: label", so the gap is the header's, not padding in the label. */}
          {l.questions.length > 0 && item('questions-clear', <Button key="clear-questions" plain dimColor hotkey="q" label="clear all" onPress={() => clearQuestions($)} />)}
          {qHidden !== '' && item('questions-hidden', <Text dimColor>{qHidden}</Text>)}
        </Box>
        <Box key="questions" flexDirection="column" height={qRows} overflow="hidden">
        {questions.length === 0 && (
          <Text dimColor wrap="wrap">
            {qEmpty}
          </Text>
        )}
        {questions.slice(qStart, qEnd).map((q, shownAt) => {
          const index = qStart + shownAt
          // The question is text, green once answered (a Button takes no color, so the question
          // is not one); the jumps are short buttons, [ Q ] to the prompt and [ A ] to the answer,
          // the answer in the primary style. An answered row puts its digit hotkey on [ A ], an
          // open row on [ Q ].
          const hotkey = index < HOTKEYS ? String(index + 1) : undefined
          const answered = q.status === 'answered'
          const color = answered ? 'success' : undefined
          // A link to another prompt's row (stored by an older version) offers no jump.
          const askedAt = q.askedRequestId !== undefined && (q.rowKey === undefined || rowKey(q.askedRequestId) === q.rowKey) ? q.askedRequestId : undefined
          const answerAt = q.answerRequestId

          // The dot is a column of its own and the question a wrapping column beside it, so a
          // long question is shown whole and its next lines align with the text, not the dot.
          return (
            <Box key={`row-q-${q.id}`} flexDirection="row" columnGap={1} marginLeft={ROW_INDENT}>
              <Text color={color} dimColor={q.status === 'deferred'}>
                {statusGlyph(q)}
              </Text>
              <Box flexShrink={1}>
                <Text color={color} dimColor={q.status === 'deferred'} wrap="wrap">
                  {fitLines(`Q${q.id} ${q.head}`, qWidth, qRows)}
                </Text>
              </Box>
              {askedAt !== undefined && (
                <Button key={`q-${q.id}`} hotkey={answered ? undefined : hotkey} label="Q" onPress={() => jump($, [askedAt], 'start')} />
              )}
              {answerAt !== undefined && (
                <Button
                  key={`a-${q.id}`}
                  variant="primary"
                  hotkey={answered ? hotkey : undefined}
                  label="A"
                  onPress={() => jump($, q.answerKey !== undefined ? [answerAt, q.answerKey] : [answerAt], 'end')}
                />
              )}
              {q.status === 'deferred' && <Text dimColor>(deferred)</Text>}
              <Button key={`del-${q.id}`} plain dimColor label="✕" onPress={() => withdraw($, q.id)} />
            </Box>
          )
        })}
        </Box>
        <Text dimColor>{'─'.repeat(Math.max(10, width))}</Text>
        <Box key="steps-header" flexDirection="row" flexWrap="wrap" columnGap={HEADER_GAP}>
          {item('steps-word', <Text bold>Steps</Text>)}
          {item('steps-ring', <Text color={sDone === steps.length && steps.length > 0 ? 'success' : 'warning'}>{sRing}</Text>)}
          {l.steps.length > 0 && clearButtons('')}
          {sHidden !== '' && item('steps-hidden', <Text dimColor>{sHidden}</Text>)}
        </Box>
        <Box key="steps" flexDirection="column" height={sRows} overflow="hidden">
        {steps.length === 0 && (
          <Text dimColor wrap="wrap">
            {sEmpty}
          </Text>
        )}
        {/* Steps read like questions: the same dots (○ pending, ◐ in progress, ● done), the
            same left edge, a number S<n> by position, and green once done. */}
        {steps.slice(sStart, sEnd).map((s, shownAt) => {
          const index = sStart + shownAt
          const color = s.status === 'completed' ? 'success' : undefined
          // The step in progress shows who is on it: a grey spinner for the main session, an amber
          // hourglass for agents, a still purple mark when it waits on the person.
          const look =
            s.status === 'paused'
              ? { glyph: '⏸', glyphColor: 'subtle', textColor: 'subtle' }
              : s.status === 'waiting'
                ? { glyph: '◆', glyphColor: 'permission', textColor: undefined }
                : s.status !== 'in_progress'
              ? { glyph: s.status === 'completed' ? '●' : '○', glyphColor: color, textColor: color }
              : state === 'working'
                ? { glyph: SPINNER[phase % SPINNER.length], glyphColor: GREY_SHADES[phase % GREY_SHADES.length], textColor: GREY_SHADES[phase % GREY_SHADES.length] }
                : state === 'agents'
                  ? { glyph: '⧗', glyphColor: AMBER_SHADES[phase % AMBER_SHADES.length], textColor: AMBER_SHADES[phase % AMBER_SHADES.length] }
                  : state === 'you'
                    ? { glyph: '◆', glyphColor: 'permission', textColor: undefined }
                    : { glyph: '◐', glyphColor: undefined, textColor: undefined }

          return (
            <Box key={`row-s-${s.id}`} flexDirection="row" columnGap={1} marginLeft={ROW_INDENT}>
              <Text color={look.glyphColor}>{look.glyph}</Text>
              <Box flexShrink={1}>
                <Text color={look.textColor} wrap="wrap">
                  {fitLines(`S${index + 1} ${s.subject}`, sWidth, sRows)}
                </Text>
              </Box>
            </Box>
          )
        })}
        </Box>
        <Box flexGrow={1} />
        <Box key="bottom-bar" flexDirection="row" flexWrap="wrap" columnGap={HEADER_GAP} marginTop={roomy ? 1 : 0}>
          {clearButtons('-bottom')}
          {item('hint', <Text dimColor>{HINT}</Text>)}
        </Box>
        {/* The banner, pinned at the bottom: its color across the whole width, its words centered. */}
        <Box key="banner" width={width} justifyContent="center" backgroundColor={bannerColor}>
          <Text color="inverseText" bold>
            {bannerText}
          </Text>
        </Box>
      </Box>
    )
  })
}
