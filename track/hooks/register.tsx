import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ledger, Pane, Prompt, Question, Turn } from '../types'

const PANE = 'track'
const PANE_COLUMNS = 48

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

const statusGlyph = (q: Question): string => (q.status === 'answered' ? '●' : q.status === 'deferred' ? '◌' : '○')

// Scrolls the transcript to a row. Allowed only while answering the person's own input,
// which a Button press is; anything else answers `deny`, shown as a toast.
const jump = async ($: EngineInterface, requestId: string, block: 'start' | 'end'): Promise<void> => {
  const moved = await $.ui.scroll({ to: { requestId }, block })
  if (moved.deny !== undefined) {
    $.ui.toast(`track: cannot jump — ${moved.deny}`)
  }
}

const openPane = async ($: EngineInterface): Promise<boolean> => {
  const opened = await $.ui.open({ id: PANE, title: 'Track', columns: PANE_COLUMNS })
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
    if (e.origin.kind !== 'composer' || e.text.trim().startsWith('/')) {
      return next(e)
    }
    const l = await read($, ledger)
    const open = l.questions.filter(q => q.status === 'open' || q.status === 'deferred')
    const stepsLeft = l.steps.filter(s => s.status !== 'completed').length
    if (open.length === 0 && stepsLeft === 0) {
      return next(e)
    }
    const listed = open
      .slice(-OPEN_LISTED)
      .map(q => `Q${q.id} "${truncate(q.head, 60)}"${q.status === 'deferred' ? ' (deferred)' : ''}`)
      .join(', ')
    const done = l.steps.length - stepsLeft
    const line = `track: open ${listed || 'none'}${open.length > OPEN_LISTED ? ` (+${open.length - OPEN_LISTED} more)` : ''}; steps ${done} of ${l.steps.length} done. Mark a question with mcp__track__mark_answered when you answer it.`

    return next({ ...e, context: [...(e.context ?? []), line] })
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

  // An interrupted turn leaves its questions open and tags them, so the pane shows why.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'aborted') {
      await update($, ledger, l => ({
        ...l,
        questions: l.questions.map(q => (q.status === 'open' && q.turnId === e.turnId ? { ...q, interrupted: true as const } : q)),
      }))
    }

    return next(e)
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
          ? { ...q, status, ...(note !== undefined && { note }), ...(e.tool_use_id !== undefined && { answerRequestId: e.tool_use_id }) }
          : q,
      ),
    }))

    return { result: `Q${id} marked ${status}.` }
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
    const placed = await openPane($)

    return { text: placed ? 'Track pane opened.' : 'Track pane could not be placed.' }
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (closed.deny === undefined && e.id === PANE) {
      const byPerson = e.origin.kind === 'person'
      await update($, pane, cur => ({ ...cur, isOpen: false, closedByPerson: cur.closedByPerson || byPerson }))
    }

    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const l = await read($, ledger)
    const width = Math.max(20, e.props.bodyColumns)
    const narrow = e.props.placement === 'inline'
    const questions = l.questions.filter(q => q.cleared !== true && (!narrow || q.status === 'open'))
    const qDone = l.questions.filter(q => q.status !== 'open').length
    const steps = l.steps.filter(s => s.cleared !== true && (!narrow || s.status !== 'completed'))
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
        {questions.length === 0 && <Text dimColor>  none yet — the model adds a question with track_question</Text>}
        {questions.map((q, index) => {
          // The engine draws a hotkey button as `1: label`, so the label carries no digit itself.
          const hotkey = index < HOTKEYS ? String(index + 1) : undefined
          const label = `${statusGlyph(q)} Q${q.id} ${truncate(q.head, width - 12)}`

          return (
            <Box flexDirection="row">
              {q.askedRequestId !== undefined ? (
                <Button key={`q-${q.id}`} plain hotkey={hotkey} dimColor={q.status !== 'open'} label={label} onPress={() => jump($, q.askedRequestId as string, 'start')} />
              ) : (
                <Text dimColor={q.status !== 'open'}>{label}</Text>
              )}
              {q.answerRequestId !== undefined && (
                <Button key={`a-${q.id}`} plain label=" ↩" onPress={() => jump($, q.answerRequestId as string, 'end')} />
              )}
              {q.status === 'deferred' && <Text dimColor> (deferred)</Text>}
            </Box>
          )
        })}
        <Box flexDirection="row" marginTop={1}>
          <Text bold>Steps </Text>
          <Text color={sDone === l.steps.length && l.steps.length > 0 ? 'success' : 'warning'}>{ring(sDone, l.steps.length)}</Text>
        </Box>
        {steps.length === 0 && <Text dimColor>  none yet — tasks and approved plan steps appear here</Text>}
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
