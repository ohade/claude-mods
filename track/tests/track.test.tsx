import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// The kit cannot raise session.append and has no rewind event to raise (the 2.1.292 API
// has none). These tests start from a stored ledger answered by a state.get stand-in, and
// stand in for $.session.messages() — the transcript as it is after a /rewind.

type QuestionRow = { id: number; status: string; answerRequestId?: string }

// Q1 was tracked in a turn that survived the rewind, but its answer was given in a turn
// that was rewound away. Q2 was tracked in a rewound turn.
const LEDGER = {
  v: 1,
  nextQuestionId: 3,
  prompts: [],
  steps: [],
  questions: [
    { id: 1, head: 'kept question', at: 1000, turnId: 't1', status: 'answered', trackedBy: 'toolu_kept', answerRequestId: 'toolu_rewound_answer', answeredAt: 1100 },
    { id: 2, head: 'rewound question', at: 1200, turnId: 't2', status: 'open', trackedBy: 'toolu_rewound' },
  ],
}

// After the rewind only the first turn's track_question call is still in the transcript.
const AFTER_REWIND = [
  { role: 'user' as const, text: 'is the first question kept?', toolUses: [] },
  {
    role: 'assistant' as const,
    text: '',
    toolUses: [{ tool_use_id: 'toolu_kept', tool: 'mcp__track__track_question', input: { summary: 'kept question' } }],
  },
]

test('a prompt after /rewind drops questions tracked in rewound turns and reopens rewound answers', async ($, on) => {
  const writes: Array<{ questions: QuestionRow[] }> = []
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: LEDGER, version: 1 } }))
  on('state.set', { plugin: 'track', key: 'ledger' }, (_, e) => {
    writes.push(e.value as { questions: QuestionRow[] })

    return { value: { isSet: true as const, version: 2 } }
  })
  on('session.messages', () => ({ value: AFTER_REWIND }))
  on('prompt.submit', (_, e) => ({ text: e.text }))

  // @ts-expect-error deliberate: a prompt with no origin, the input that crashed the hook in the red run
  await $.prompt.submit({ text: 'the same question again?' })

  expect(writes.length).toBeGreaterThan(0)
  const questions = writes.at(-1)?.questions ?? []
  expect(questions.map(q => q.id)).toEqual([1])
  expect(questions[0]).toMatchObject({ id: 1, status: 'open' })
  expect(questions[0]?.answerRequestId).toBeUndefined()
})

test('nothing is dropped when every tracked call is still in the transcript', async ($, on) => {
  const writes: unknown[] = []
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: LEDGER, version: 1 } }))
  on('state.set', { plugin: 'track', key: 'ledger' }, (_, e) => {
    writes.push(e.value)

    return { value: { isSet: true as const, version: 2 } }
  })
  on('session.messages', () => ({
    value: [
      ...AFTER_REWIND,
      {
        role: 'assistant' as const,
        text: '',
        toolUses: [
          { tool_use_id: 'toolu_rewound', tool: 'mcp__track__track_question', input: { summary: 'rewound question' } },
          { tool_use_id: 'toolu_rewound_answer', tool: 'mcp__track__mark_answered', input: { id: 1, status: 'answered' } },
        ],
      },
    ],
  }))
  on('prompt.submit', (_, e) => ({ text: e.text }))

  // @ts-expect-error deliberate: a prompt with no origin, the input that crashed the hook in the red run
  await $.prompt.submit({ text: 'a new question?' })

  expect(writes).toHaveLength(0)
})

// An answered question must stay listed when the pane sits inline above the prompt
// (main screen or a narrow terminal). Observed 2026-10-07: the ring said "2 of 2" while
// the list said "none yet".
const ANSWERED = {
  v: 1,
  nextQuestionId: 2,
  prompts: [],
  steps: [],
  questions: [
    { id: 1, head: 'what is the capital of Australia?', at: 1000, turnId: 't1', status: 'answered', askedRequestId: 'row-1', trackedBy: 'toolu_q', answerRequestId: 'toolu_a', answeredAt: 1100 },
  ],
}

// Everything a pane row shows: its texts and its button labels.
const listed = async (ui: { findAll: (q: { type: string }) => Promise<Array<{ text?: string; props: unknown }>> }) => [
  ...(await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? '')),
  ...(await ui.findAll({ type: 'Button' })).map(b => String((b.props as { label?: string }).label ?? '')),
]

const pane = (placement: 'dock' | 'inline') => ({
  plugin: 'track',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'track',
  viewport: { columns: 120, rows: 40, isFullscreen: placement === 'dock' },
  props: { title: 'Track', isFocused: false, bodyColumns: 60, placement, scroll: { offset: 0, bodyRows: 20 }, view: {} },
})

test('an answered question stays listed in the inline pane', async ($, on) => {
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: ANSWERED, version: 1 } }))

  const ui = await $.ui.mount(pane('inline'))

  const labels = await listed(ui)
  expect(labels.some(label => label.includes('Q1'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /none yet — the model adds a question/ })).toBeUndefined()
})

const toolRow = (tool: string, input: unknown) => ({
  plugin: 'track',
  surface: 'terminal' as const,
  component: 'ToolUse' as const,
  requestId: 'toolu_row',
  props: { tool_use_id: 'toolu_row', tool, input, isRunning: false, isErrored: false, isInterrupted: false },
})

test('the track_question call draws no row', async ($, on) => {
  on('ui.render', { component: 'ToolUse' }, () => ({ type: 'Text', props: {}, children: ['engine row'] }))

  const ui = await $.ui.mount(toolRow('mcp__track__track_question', { summary: 'what is the capital of Australia?' }))

  expect(await ui.findAll({ type: 'Text' })).toHaveLength(0)
})

test('the mark_answered call draws one quiet line naming the question', async ($, on) => {
  on('ui.render', { component: 'ToolUse' }, () => ({ type: 'Text', props: {}, children: ['engine row'] }))

  const ui = await $.ui.mount(toolRow('mcp__track__mark_answered', { id: 2, status: 'answered' }))

  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toHaveLength(1)
  expect(texts[0]).toContain('Q2 answered')
})

// Observed 2026-10-07: an inline pane about 7 rows tall listed only the newest of four
// questions. The pane body scrolls, so every uncleared question is listed.
const FOUR = {
  ...ANSWERED,
  nextQuestionId: 5,
  questions: [1, 2, 3, 4].map(id => ({ ...ANSWERED.questions[0], id, head: `question ${id}`, askedRequestId: `row-${id}` })),
}

test('a short inline pane still lists every uncleared question', async ($, on) => {
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: FOUR, version: 1 } }))
  const short = { ...pane('inline'), props: { ...pane('inline').props, scroll: { offset: 0, bodyRows: 7 } } }

  const ui = await $.ui.mount(short)

  const labels = await listed(ui)
  expect([1, 2, 3, 4].every(id => labels.some(label => label.includes(`Q${id} `)))).toBe(true)
})

// Ohad, 2026-10-07: a rewound question should leave the pane at the rewind, not at the next
// prompt. No event marks a rewind; the prompt hint redraws when the rewind puts the old
// prompt back in the box, so that redraw schedules the same check.
test('a prompt-hint redraw after /rewind drops the rewound question without a new prompt', async ($, on) => {
  const clock = mock.clock(on)
  const writes: Array<{ questions: QuestionRow[] }> = []
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: LEDGER, version: 1 } }))
  on('state.set', { plugin: 'track', key: 'ledger' }, (_, e) => {
    writes.push(e.value as { questions: QuestionRow[] })

    return { value: { isSet: true as const, version: 2 } }
  })
  on('session.messages', () => ({ value: AFTER_REWIND }))
  on('ui.render', { component: 'PromptHint' }, () => ({ type: 'Text', props: {}, children: ['hint'] }))

  await $.ui.mount({ plugin: 'track', surface: 'terminal' as const, component: 'PromptHint' as const, requestId: 'hint', props: { isDraft: true, isWorking: false, hint: '' } })
  await clock.advance(5000)

  expect(writes.length).toBeGreaterThan(0)
  expect((writes.at(-1)?.questions ?? []).map(q => q.id)).toEqual([1])
})

// Ohad, 2026-10-07: a question can be withdrawn from the pane. It leaves the ledger, and
// the model is told once, on the next prompt, not to answer it.
const OPEN_ONE = {
  ...ANSWERED,
  questions: [{ id: 1, head: 'how tall am I?', at: 1000, turnId: 't1', status: 'open', askedRequestId: 'row-1', trackedBy: 'toolu_q' }],
}

test('pressing ✕ on a question removes it and queues a notice for the model', async ($, on) => {
  const writes: Array<{ questions: QuestionRow[]; withdrawn?: Array<{ id: number }> }> = []
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: OPEN_ONE, version: 1 } }))
  on('state.set', { plugin: 'track', key: 'ledger' }, (_, e) => {
    writes.push(e.value as { questions: QuestionRow[]; withdrawn?: Array<{ id: number }> })

    return { value: { isSet: true as const, version: 2 } }
  })

  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'del-1' })

  const last = writes.at(-1)
  expect(last?.questions ?? [{ id: 1 }]).toHaveLength(0)
  expect((last?.withdrawn ?? []).map(w => w.id)).toEqual([1])
})

test('the next prompt tells the model about a withdrawn question, once', async ($, on) => {
  const withNotice = { ...ANSWERED, questions: [], withdrawn: [{ id: 3, head: 'how tall am I?' }] }
  const writes: Array<{ withdrawn?: unknown[] }> = []
  let context: readonly string[] = []
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: withNotice, version: 1 } }))
  on('state.set', { plugin: 'track', key: 'ledger' }, (_, e) => {
    writes.push(e.value as { withdrawn?: unknown[] })

    return { value: { isSet: true as const, version: 2 } }
  })
  on('prompt.submit', (_, e) => {
    context = e.context ?? []

    return { text: e.text }
  })

  // @ts-expect-error deliberate: a prompt with no origin, the input that crashed the hook in the red run
  await $.prompt.submit({ text: 'something else' })

  expect(context.some(line => line.includes('withdrew Q3'))).toBe(true)
  expect(writes.at(-1)?.withdrawn ?? ['not cleared']).toHaveLength(0)
})

// Milestone 4: steps come from the model's own Task, todo and plan tools, with no extra call.
type StepRow = { id: string; source: string; subject: string; status: string; taskId?: string }
const withSteps = (steps: StepRow[]) => ({ ...ANSWERED, questions: [], steps })

const captureSteps = (on: Parameters<TestBody>[1], ledger: unknown) => {
  const writes: Array<{ steps: StepRow[] }> = []
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: ledger, version: 1 } }))
  on('state.set', { plugin: 'track', key: 'ledger' }, (_, e) => {
    writes.push(e.value as { steps: StepRow[] })

    return { value: { isSet: true as const, version: 2 } }
  })

  return writes
}

test('TaskCreate adds a pending step', async ($, on) => {
  const writes = captureSteps(on, withSteps([]))
  on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '7', subject: 'Write the parser' } } }))

  await $.tool.call({ tool: 'TaskCreate', subject: 'Write the parser', description: 'x', tool_use_id: 'toolu_tc' })

  expect(writes.at(-1)?.steps).toEqual([
    { id: 'task:7', source: 'task', subject: 'Write the parser', status: 'pending', taskId: '7', createdRequestId: 'toolu_tc' },
  ])
})

test('TaskUpdate completes a step, and deleted removes it', async ($, on) => {
  const two = [
    { id: 'task:7', source: 'task', subject: 'A', status: 'pending', taskId: '7' },
    { id: 'task:8', source: 'task', subject: 'B', status: 'pending', taskId: '8' },
  ]
  const writes = captureSteps(on, withSteps(two))
  on('tool.call', { tool: 'TaskUpdate' }, (_, e) => ({ result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }))

  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'completed' })
  expect(writes.at(-1)?.steps.map(s => `${s.id}:${s.status}`)).toEqual(['task:7:completed', 'task:8:pending'])

  await $.tool.call({ tool: 'TaskUpdate', taskId: '8', status: 'deleted' })
  expect(writes.at(-1)?.steps.map(s => s.id)).toEqual(['task:7'])
})

test('an approved plan becomes steps: numbered and checkbox lines, not code', async ($, on) => {
  const writes = captureSteps(on, withSteps([]))
  const plan = ['## Plan', '', '1. Foo', '2. Bar', '- [x] Baz', '```', '1. not a step', '```', 'Prose line.'].join('\n')
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({ result: { plan, isAgent: false } }))

  await $.tool.call({ tool: 'ExitPlanMode' })

  expect(writes.at(-1)?.steps.map(s => `${s.id}|${s.subject}|${s.status}`)).toEqual([
    'plan:1|Foo|pending',
    'plan:2|Bar|pending',
    'plan:3|Baz|completed',
  ])
})

test('a Task named like a plan step links to it instead of adding a row', async ($, on) => {
  const writes = captureSteps(on, withSteps([{ id: 'plan:1', source: 'plan', subject: 'Foo', status: 'pending' }]))
  on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '9', subject: 'foo.' } } }))

  await $.tool.call({ tool: 'TaskCreate', subject: 'foo.', description: 'x' })

  expect(writes.at(-1)?.steps).toEqual([{ id: 'plan:1', source: 'plan', subject: 'Foo', status: 'pending', taskId: '9' }])
})

test('TodoWrite replaces the todo rows and keeps the others', async ($, on) => {
  const writes = captureSteps(
    on,
    withSteps([
      { id: 'todo:old', source: 'todo', subject: 'old', status: 'pending' },
      { id: 'task:7', source: 'task', subject: 'A', status: 'pending', taskId: '7' },
    ]),
  )
  const newTodos = [{ content: 'New one', status: 'in_progress', activeForm: 'Doing the new one' }]
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos } }))

  await $.tool.call({ tool: 'TodoWrite', todos: newTodos as never })

  expect(writes.at(-1)?.steps.map(s => `${s.id}:${s.status}`)).toEqual(['task:7:pending', 'todo:new one:in_progress'])
})

test('mark_step sets a step status', async ($, on) => {
  const writes = captureSteps(on, withSteps([{ id: 'plan:1', source: 'plan', subject: 'Foo', status: 'pending' }]))

  await $.tool.call({ tool: 'mcp__track__mark_step', id: 'plan:1', status: 'completed' } as never)

  expect(writes.at(-1)?.steps.map(s => `${s.id}:${s.status}`)).toEqual(['plan:1:completed'])
})

test('a subagent TaskCreate is not the user’s step', async ($, on) => {
  const writes = captureSteps(on, withSteps([]))
  on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '7', subject: 'sub' } } }))

  await $.tool.call({ tool: 'TaskCreate', subject: 'sub', description: 'x', agentId: 'agent-1' } as never)

  expect(writes).toHaveLength(0)
})

// Milestone 5: the diff panel's own rule — git repo, fullscreen, at least 144 columns, and
// never closed by the person — opens the pane by itself; the ledger outlives the process.
const REPO = { root: '/repo', remote: null, internal: false, name: 'repo' }
const hint = (columns: number, isFullscreen: boolean) => ({
  plugin: 'track',
  surface: 'terminal' as const,
  component: 'PromptHint' as const,
  requestId: 'hint',
  viewport: { columns, rows: 40, isFullscreen },
  props: { isDraft: true, isWorking: false, hint: '' },
})

const autoOpenCase = async (
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  c: { columns: number; isFullscreen: boolean; repo: unknown; closedByPerson: boolean },
) => {
  const clock = mock.clock(on)
  const opens: unknown[] = []
  on('session.repo', () => ({ value: c.repo as never }))
  on('store.get', (_, e) => ({ value: e.key === 'closedByPerson' ? c.closedByPerson : undefined }))
  on('ui.open', (_, e) => {
    opens.push(e)

    return { value: { isPlaced: true as const } }
  })
  on('ui.render', { component: 'PromptHint' }, () => ({ type: 'Text', props: {}, children: ['hint'] }))
  await $.ui.mount(hint(c.columns, c.isFullscreen))
  await clock.advance(500)

  return opens
}

test('the pane opens by itself in a git repo, fullscreen, at 144+ columns, never closed by hand', async ($, on) => {
  const opens = await autoOpenCase($, on, { columns: 160, isFullscreen: true, repo: REPO, closedByPerson: false })
  expect(opens).toHaveLength(1)
  expect(opens[0]).toMatchObject({ id: 'track' })
})

for (const [why, c] of [
  ['under 144 columns', { columns: 120, isFullscreen: true, repo: REPO, closedByPerson: false }],
  ['outside the fullscreen layout', { columns: 160, isFullscreen: false, repo: REPO, closedByPerson: false }],
  ['outside a git repository', { columns: 160, isFullscreen: true, repo: null, closedByPerson: false }],
  ['after the person closed it', { columns: 160, isFullscreen: true, repo: REPO, closedByPerson: true }],
] as const) {
  test(`the pane does not open by itself ${why}`, async ($, on) => {
    expect(await autoOpenCase($, on, { ...c })).toHaveLength(0)
  })
}

test('a resumed session gets its saved questions back', async ($, on) => {
  const saved = { v: 1, savedAt: 1, ledger: OPEN_ONE }
  const writes: Array<{ questions: QuestionRow[] }> = []
  on('store.get', (_, e) => ({ value: e.key === 's:S1' ? saved : undefined }))
  on('state.set', { plugin: 'track', key: 'ledger' }, (_, e) => {
    writes.push(e.value as { questions: QuestionRow[] })

    return { value: { isSet: true as const, version: 2 } }
  })

  on('classic.SessionStart', () => ({}))

  await $.classic.SessionStart({ hook_event_name: 'SessionStart', source: 'resume', session_id: 'S1', transcript_path: '/t', cwd: '/repo' } as never)

  expect(writes.at(-1)?.questions.map(q => q.id)).toEqual([1])
})

test('a finished turn saves the ledger under the session id', async ($, on) => {
  const sets: Array<{ key: string; value: unknown }> = []
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: OPEN_ONE, version: 1 } }))
  on('session.id', () => ({ value: 'S1' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_, e) => {
    sets.push(e)

    return { value: undefined }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: 'done', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)

  const bucket = sets.find(s => s.key === 's:S1')?.value as { ledger?: { questions: QuestionRow[] } } | undefined
  expect(bucket?.ledger?.questions.map(q => q.id)).toEqual([1])
  expect(sets.find(s => s.key === 'sessions')?.value).toEqual(['S1'])
})

// Ohad, 2026-10-07: an answered question turns green, and the jump to its answer stands out.
test('an answered question is green and its answer button is prominent', async ($, on) => {
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: ANSWERED, version: 1 } }))

  const ui = await $.ui.mount(pane('dock'))

  const texts = await ui.findAll({ type: 'Text' })
  const question = texts.find(t => String(t.text ?? '').includes('Q1'))
  expect((question?.props as { color?: string } | undefined)?.color).toBe('success')
  const answer = (await ui.findAll({ type: 'Button' })).find(b => b.key === 'a-1')
  expect(answer?.props).toMatchObject({ variant: 'primary', label: 'answer' })
  expect((answer?.props as { plain?: true } | undefined)?.plain).toBeUndefined()
})

// Ohad, 2026-10-07: a plan written in chat registered no steps (no Task, todo or plan mode),
// and mark_step drew the engine's full row. track_steps registers chat-plan steps.
test('track_steps registers the steps of a plan laid out in chat', async ($, on) => {
  const writes = captureSteps(on, withSteps([]))

  await $.tool.call({ tool: 'mcp__track__track_steps', steps: ['Create the file', 'Print it', 'Count the lines'] } as never)

  expect(writes.at(-1)?.steps.map(s => `${s.id}|${s.subject}|${s.status}`)).toEqual([
    'plan:1|Create the file|pending',
    'plan:2|Print it|pending',
    'plan:3|Count the lines|pending',
  ])
})

test('track_steps draws no row and mark_step draws one quiet line', async ($, on) => {
  on('ui.render', { component: 'ToolUse' }, () => ({ type: 'Text', props: {}, children: ['engine row'] }))

  const steps = await $.ui.mount(toolRow('mcp__track__track_steps', { steps: ['a', 'b'] }))
  expect(await steps.findAll({ type: 'Text' })).toHaveLength(0)

  const second = toolRow('mcp__track__mark_step', { id: 'plan:1', status: 'in_progress' })
  const mark = await $.ui.mount({ ...second, requestId: 'toolu_row_2', props: { ...second.props, tool_use_id: 'toolu_row_2' } })
  const texts = (await mark.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toHaveLength(1)
  expect(texts[0]).toContain('plan:1 in progress')
})

// Ohad, 2026-10-07: clear all questions, or all steps, each on its own.
const BOTH = {
  ...ANSWERED,
  questions: [...ANSWERED.questions, { ...OPEN_ONE.questions[0], id: 2 }],
  steps: [{ id: 'plan:1', source: 'plan', subject: 'Foo', status: 'pending' }],
}

const captureLedger = (on: Parameters<TestBody>[1]) => {
  const writes: Array<{ questions: QuestionRow[]; steps: StepRow[]; withdrawn?: Array<{ id: number }> }> = []
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: BOTH, version: 1 } }))
  on('state.set', { plugin: 'track', key: 'ledger' }, (_, e) => {
    writes.push(e.value as { questions: QuestionRow[]; steps: StepRow[]; withdrawn?: Array<{ id: number }> })

    return { value: { isSet: true as const, version: 2 } }
  })

  return writes
}

test('clearing all questions empties them, withdraws the open ones and keeps the steps', async ($, on) => {
  const writes = captureLedger(on)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'clear-questions' })

  const last = writes.at(-1)
  expect(last?.questions ?? ['not cleared']).toHaveLength(0)
  expect((last?.withdrawn ?? []).map(w => w.id)).toEqual([2])
  expect(last?.steps.map(s => s.id)).toEqual(['plan:1'])
})

test('clearing all steps empties them and keeps the questions', async ($, on) => {
  const writes = captureLedger(on)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'clear-steps' })

  const last = writes.at(-1)
  expect(last?.steps ?? ['not cleared']).toHaveLength(0)
  expect(last?.questions.map(q => q.id)).toEqual([1, 2])
})

// Ohad, 2026-10-07: a completed step turns green like an answered question, and a line
// separates the two sections.
test('a completed step is green, and a separator line divides the sections', async ($, on) => {
  const done = { ...BOTH, steps: [{ id: 'plan:1', source: 'plan', subject: 'Foo', status: 'completed' }] }
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: done, version: 1 } }))

  const ui = await $.ui.mount(pane('dock'))

  const texts = await ui.findAll({ type: 'Text' })
  const step = texts.find(t => String(t.text ?? '').includes('Foo'))
  expect((step?.props as { color?: string } | undefined)?.color).toBe('success')
  expect(texts.some(t => /^─{10,}$/.test(String(t.text ?? '')))).toBe(true)
})

// Ohad, 2026-10-07: "q: clear all" sat flush against the ring. The engine draws a hotkey
// button as "q: label", so spacing inside the label lands after "q:", not before it.
test('the clear-all buttons carry no padding in their labels', async ($, on) => {
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: BOTH, version: 1 } }))

  const ui = await $.ui.mount(pane('dock'))

  const labels = (await ui.findAll({ type: 'Button' }))
    .filter(b => b.key === 'clear-questions' || b.key === 'clear-steps')
    .map(b => (b.props as { label?: string }).label)
  expect(labels).toEqual(['clear all', 'clear all'])
})
