import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ledger, Pane, Prompt, Question, Step, Turn } from '../types'

const PANE = 'track'
const PANE_COLUMNS = 48
// Rows the pane asks for when it sits inline above the prompt (main screen or narrow terminal).
const PANE_ROWS = 16
// The newest question is scrolled into view after the redraw that draws it.
const SCROLL_AFTER_MS = 150
// The rewind check a prompt-hint redraw schedules: run after this delay, at most once per gap.
// Module memory, not $.state: a reload only resets the debounce.
const REWIND_CHECK_DELAY_MS = 1000
const REWIND_CHECK_GAP_MS = 3000
const rewindCheck = { isScheduled: false, lastAt: -Infinity }
// The built-in diff panel's rule: it opens by itself only from this width, in the fullscreen
// layout, in a git repository, and never after the person closed it by hand.
const AUTO_OPEN_MIN_COLUMNS = 144
const AUTO_OPEN_DELAY_MS = 50
const autoOpen = { isScheduled: false }
// Saved ledgers kept across sessions, newest first; older buckets are deleted.
const MAX_SESSIONS = 20
const TRACK_QUESTION = 'mcp__track__track_question'
const MARK_ANSWERED = 'mcp__track__mark_answered'
const MARK_STEP = 'mcp__track__mark_step'
const MAX_STEPS = 300
const MAX_PLAN_STEPS = 30
const STEP_STATUSES = ['pending', 'in_progress', 'completed'] as const

// Caps: heads are short, lists are bounded, so the ledger stays small in $.state and $.store.
const HEAD_CHARS = 80
const MAX_PROMPTS = 200
const MAX_QUESTIONS = 200
const HOTKEYS = 9

// How many open questions the per-turn context row names.
const OPEN_LISTED = 5

// The standing rule, sent once per request as a byte-stable system-prompt section.
const RULE = [
  'track: if the user\'s prompt is a question, call mcp__track__track_question with a one-line summary before answering',
  '(one call per distinct question). Write the answer, then call mcp__track__mark_answered with status "answered",',
  'or "deferred" with a note if it must wait. For work of more than one step, create the steps with TaskCreate and',
  'keep their status current; mcp__track__mark_step overrides a step the tracker shows wrong.',
].join(' ')

const EMPTY_LEDGER: Ledger = { v: 1, nextQuestionId: 1, prompts: [], questions: [], steps: [] }

const ledger = atom({ plugin: 'track', key: 'ledger' } as const, EMPTY_LEDGER)
const turn = atom({ plugin: 'track', key: 'turn' } as const, { currentId: null, gatedTurnId: null } as Turn)
const pane = atom({ plugin: 'track', key: 'pane' } as const, { isOpen: false, hidden: false, closedByPerson: false } as Pane)

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

// Scrolls the transcript to a row. Allowed only while answering the person's own input,
// which a Button press is; anything else answers `deny`, shown as a toast.
const jump = async ($: EngineInterface, requestId: string, block: 'start' | 'end'): Promise<void> => {
  const moved = await $.ui.scroll({ to: { requestId }, block })
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
  const since = (await read($, turn)).compactedAt ?? 0
  const l = await read($, ledger)
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
        const { answerRequestId: _a, answeredAt: _t, note: _n, ...rest } = q

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
// store read, the git read and the open run from a timer, where state may be written.
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
      const inRepo = !closedByPerson && (await $.session.repo()) !== null
      if (closedByPerson || !inRepo) {
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

// The ledger survives the process: one bucket per session id, the newest MAX_SESSIONS kept.
const saveLedger = async ($: EngineInterface): Promise<void> => {
  const id = await $.session.id()
  await $.store.set(`s:${id}`, { v: 1, savedAt: Date.now(), ledger: await read($, ledger) })
  const known = await $.store.get('sessions')
  const sessions = [id, ...(Array.isArray(known) ? known.filter((s): s is string => typeof s === 'string' && s !== id) : [])]
  for (const old of sessions.slice(MAX_SESSIONS)) {
    await $.store.delete(`s:${old}`)
  }
  await $.store.set('sessions', sessions.slice(0, MAX_SESSIONS))
}

const openPane = async ($: EngineInterface): Promise<boolean> => {
  const opened = await $.ui.open({ id: PANE, title: 'Track', columns: PANE_COLUMNS, rows: PANE_ROWS })
  await update($, pane, p => ({ ...p, isOpen: opened.isPlaced }))
  if (!opened.isPlaced) {
    $.ui.toast(`track: the pane did not open — ${opened.reason}`)
  }

  return opened.isPlaced
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A pane asked for by code below 144 columns waits unseen; drop any such leftover.
    await $.ui.close({ id: PANE })
    await $.command.register({
      name: 'track',
      description: 'Show or hide the track pane: questions asked, where answered, and the steps',
      argumentHint: '[status]',
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

    // Left deferred behind ToolSearch: an override the model rarely needs.
    await $.tool.register({
      name: 'mark_step',
      description:
        'Correct a step the track pane shows wrong. Ids: plan:1, plan:2, … in the order of the approved plan; task:<taskId> for a Task; todo:<the todo text, lowercased>. Prefer TaskUpdate for Tasks.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, status: { type: 'string', enum: [...STEP_STATUSES] } },
        required: ['id', 'status'],
      },
    })

    return next(e)
  })

  // The two per-turn tools stay in the model's tool list; a deferred tool costs a ToolSearch round trip.
  on('tool.describe', { tool: 'mcp__track__track_question' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: 'mcp__track__mark_answered' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

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

  on('turn.start', async ($, e, next) => {
    await update($, turn, t => ({ ...t, currentId: e.turnId }))
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

    return { sections: [...composed.sections, { id: 'track:rule', text: RULE, scope: 'session' as const }] }
  })

  // The per-turn reminder: a short row beside the prompt, only while something is open.
  on('prompt.submit', async ($, e, next) => {
    await dropRewound($)
    if (e.text.trim().startsWith('/')) {
      return next(e)
    }
    const lines: string[] = []
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
    if (e.origin?.kind !== 'composer' || (open.length === 0 && stepsLeft === 0)) {
      return lines.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...lines] })
    }
    const listed = open
      .slice(-OPEN_LISTED)
      .map(q => `Q${q.id} "${truncate(q.head, 60)}"${q.status === 'deferred' ? ' (deferred)' : ''}`)
      .join(', ')
    const done = l.steps.length - stepsLeft
    const line = `track: open ${listed || 'none'}${open.length > OPEN_LISTED ? ` (+${open.length - OPEN_LISTED} more)` : ''}; steps ${done} of ${l.steps.length} done. Mark a question with mcp__track__mark_answered when you answer it.`

    return next({ ...e, context: [...(e.context ?? []), ...lines, line] })
  })

  // The gate: after the settings Stop hooks have run (and only when none of them blocked),
  // hold the turn once when a question the model tracked this turn is still open. The catch
  // replays the chain, so a failure here can never add or erase a block.
  on('classic.Stop', async ($, e, next) => {
    const below = await next(e)
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
      await update($, turn, t => ({ ...t, compactedAt: Date.now() }))
    }

    return compacted
  })

  // An interrupted turn leaves its questions open and tags them, so the pane shows why.
  // Each finished main-loop turn also saves the ledger, so /resume finds it.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'aborted') {
      await update($, ledger, l => ({
        ...l,
        questions: l.questions.map(q => (q.status === 'open' && q.turnId === e.turnId ? { ...q, interrupted: true as const } : q)),
      }))
    }
    const done = await next(e)
    if (e.agentId === undefined) {
      await saveLedger($)
    }

    return done
  })

  // The drawn row's requestId is the authoritative jump target: match it to the prompt by row
  // key, else to the first prompt still without one (rows render in append order). State is
  // written after the draw, from a timer, because a write during a render is refused.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal' || e.props.origin.kind !== 'composer') {
      return row
    }
    const l = await read($, ledger)
    const key = rowKey(e.requestId)
    const target = l.prompts.find(p => p.requestId === undefined && p.rowKey === key) ?? l.prompts.find(p => p.requestId === undefined)
    if (target === undefined || target.requestId === e.requestId) {
      return row
    }
    $.clock.after(0, () => {
      void update($, ledger, cur => ({
        ...cur,
        prompts: cur.prompts.map(p => (p.rowKey === target.rowKey && p.requestId === undefined ? { ...p, requestId: e.requestId } : p)),
        questions: cur.questions.map(q => (q.rowKey === target.rowKey && q.askedRequestId === undefined ? { ...q, askedRequestId: e.requestId } : q)),
      }))
    })

    return row
  })

  on('tool.call', { tool: 'mcp__track__track_question' }, async ($, e) => {
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
      const t = { currentId: null as string | null }
      minted = {
        id: l.nextQuestionId,
        head: summary,
        at: Date.now(),
        ...(last?.rowKey !== undefined && { rowKey: last.rowKey }),
        ...(last?.requestId !== undefined && { askedRequestId: last.requestId }),
        ...(e.tool_use_id !== undefined && { trackedBy: e.tool_use_id }),
        turnId: last?.turnId ?? t.currentId,
        status: 'open',
      }

      return { ...l, nextQuestionId: l.nextQuestionId + 1, questions: [...l.questions, minted].slice(-MAX_QUESTIONS) }
    })
    const t = await read($, turn)
    if (minted !== undefined && minted.turnId === null && t.currentId !== null) {
      const id = minted.id
      await update($, ledger, l => ({ ...l, questions: l.questions.map(q => (q.id === id ? { ...q, turnId: t.currentId } : q)) }))
    }

    // Keep the newest question in view; older ones stay above it, reachable by scrolling.
    if (minted !== undefined && (await read($, pane)).isOpen) {
      const key = `row-q-${minted.id}`
      $.clock.after(SCROLL_AFTER_MS, () => {
        void $.ui.scroll({ in: PANE, to: { key }, block: 'nearest' }).then(moved => {
          if (moved.deny !== undefined) $.ui.log(`track: newest question not scrolled into view: ${moved.deny}`, { to: 'debug' })
        })
      })
    }

    // A plugin tool's result is text (or content blocks), never a bare object.
    return { result: `Tracked as Q${minted?.id}: ${summary}. After answering, call mcp__track__mark_answered({ id: ${minted?.id}, status: "answered" }).` }
  })

  on('tool.call', { tool: 'mcp__track__mark_answered' }, async ($, e) => {
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
    await update<Ledger>($, ledger, cur => ({
      ...cur,
      questions: cur.questions.map(q =>
        q.id === id
          ? {
              ...q,
              status,
              answeredAt: Date.now(),
              ...(note !== undefined && { note }),
              ...(e.tool_use_id !== undefined && { answerRequestId: e.tool_use_id }),
            }
          : q,
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

      return { ...cur, steps: [...cur.steps, step].slice(-MAX_STEPS) }
    })

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    const status = e.status
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true || status === undefined) {
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
    const rows: Step[] = todos.map(t => ({ id: `todo:${norm(t.content)}`, source: 'todo', subject: headOf(t.content), status: t.status }))
    await update<Ledger>($, ledger, cur => ({ ...cur, steps: [...cur.steps.filter(s => s.source !== 'todo'), ...rows].slice(-MAX_STEPS) }))

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
      await update<Ledger>($, ledger, cur => ({ ...cur, steps: [...cur.steps.filter(s => s.source !== 'plan'), ...steps].slice(-MAX_STEPS) }))
    }

    return ran
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

      return { text: 'Track pane hidden for this session. /track shows it again.' }
    }
    await update($, pane, cur => ({ ...cur, hidden: false, closedByPerson: false }))
    await $.store.set('closedByPerson', false)
    const placed = await openPane($)

    return { text: placed ? 'Track pane opened.' : 'Track pane could not be placed.' }
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
      const saved = (await $.store.get(`s:${e.session_id}`)) as { ledger?: Ledger } | undefined
      if (saved?.ledger !== undefined && Array.isArray(saved.ledger.questions)) {
        const restored = saved.ledger
        await update<Ledger>($, ledger, () => restored)
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Save the ledger at the end of the session; /clear starts a fresh one.
  on('session.end', async ($, e, next) => {
    await saveLedger($)
    if (e.reason === 'clear') {
      await update<Ledger>($, ledger, () => EMPTY_LEDGER)
      await update($, turn, () => ({ currentId: null, gatedTurnId: null }))
    }

    return next(e)
  })

  // The model's bookkeeping calls stay quiet in the transcript: track_question draws nothing,
  // mark_answered draws one dim line, which is also where "jump to answer" lands.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool === TRACK_QUESTION) {
      const { Box } = $.ui.resolve(e)

      return <Box />
    }
    if (e.props.tool === MARK_ANSWERED) {
      const { Text } = $.ui.resolve(e)
      const input = (e.props.input ?? {}) as { id?: unknown; status?: unknown }
      const status = input.status === 'deferred' ? 'deferred' : 'answered'

      return <Text dimColor>{`✓ Q${String(input.id ?? '?')} ${status}`}</Text>
    }

    return next(e)
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.tool === TRACK_QUESTION || e.props.tool === MARK_ANSWERED) {
      const { Box } = $.ui.resolve(e)

      return <Box />
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const l = await read($, ledger)
    const width = Math.max(20, e.props.bodyColumns)
    // Every uncleared row is listed in both placements; the pane body scrolls, so older rows
    // stay reachable above the newest (track_question scrolls the newest into view).
    const questions = l.questions.filter(q => q.cleared !== true)
    const qDone = l.questions.filter(q => q.status !== 'open').length
    const steps = l.steps.filter(s => s.cleared !== true)
    const sDone = l.steps.filter(s => s.status === 'completed').length
    const clearCompleted = () =>
      void update($, ledger, cur => ({
        ...cur,
        questions: cur.questions.map(q => (q.status === 'open' ? q : { ...q, cleared: true as const })),
        steps: cur.steps.map(s => (s.status === 'completed' ? { ...s, cleared: true as const } : s)),
      }))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold>Questions </Text>
          <Text color={qDone === l.questions.length && l.questions.length > 0 ? 'success' : 'warning'}>
            {ring(qDone, l.questions.length)}
          </Text>
        </Box>
        {questions.length === 0 && (
          <Text dimColor>{l.questions.length === 0 ? '  none yet — the model adds a question with track_question' : '  all cleared'}</Text>
        )}
        {questions.map((q, index) => {
          // The question is text, green once answered; the jumps are bracketed buttons, the
          // answer one in the primary style. The engine draws a hotkey button as `1: label`: an
          // answered row puts its digit on the answer, an open row on the ask.
          const hotkey = index < HOTKEYS ? String(index + 1) : undefined
          const answered = q.status === 'answered'
          const text = `${statusGlyph(q)} Q${q.id} ${truncate(q.head, width - 28)}`

          return (
            <Box key={`row-q-${q.id}`} flexDirection="row" columnGap={1}>
              <Text color={answered ? 'success' : undefined} dimColor={q.status === 'deferred'}>
                {text}
              </Text>
              {q.askedRequestId !== undefined && (
                <Button key={`q-${q.id}`} hotkey={answered ? undefined : hotkey} label="asked" onPress={() => jump($, q.askedRequestId as string, 'start')} />
              )}
              {q.answerRequestId !== undefined && (
                <Button key={`a-${q.id}`} variant="primary" hotkey={answered ? hotkey : undefined} label="answer" onPress={() => jump($, q.answerRequestId as string, 'end')} />
              )}
              {q.status === 'deferred' && <Text dimColor>(deferred)</Text>}
              <Button key={`del-${q.id}`} plain dimColor label="✕" onPress={() => withdraw($, q.id)} />
            </Box>
          )
        })}
        <Box flexDirection="row" marginTop={1}>
          <Text bold>Steps </Text>
          <Text color={sDone === l.steps.length && l.steps.length > 0 ? 'success' : 'warning'}>{ring(sDone, l.steps.length)}</Text>
        </Box>
        {steps.length === 0 && (
          <Text dimColor>{l.steps.length === 0 ? '  none yet — tasks and approved plan steps appear here' : '  all cleared'}</Text>
        )}
        {steps.map(s => (
          <Text dimColor={s.status === 'completed'}>
            {'   '}
            {s.status === 'completed' ? '◼' : s.status === 'in_progress' ? '◧' : '◻'} {truncate(s.subject, width - 6)}
          </Text>
        ))}
        <Box flexDirection="row" marginTop={1}>
          <Button key="clear" plain hotkey="c" label="Clear completed" onPress={clearCompleted} />
          <Text dimColor>   /track hides · ctrl+x x closes for good</Text>
        </Box>
      </Box>
    )
  })
}
