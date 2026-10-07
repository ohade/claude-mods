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
    { id: 1, head: 'kept question', at: 1000, turnId: 't1', status: 'answered', trackedBy: 'toolu_kept', answerRequestId: 'toolu_rewound_answer', answeredAt: 1100, answerKey: 'aaaa1111-bbbb-cccc-dddd' },
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
  expect((questions[0] as { answerKey?: string } | undefined)?.answerKey).toBeUndefined()
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
  ['after the person closed it', { columns: 160, isFullscreen: true, repo: REPO, closedByPerson: true }],
] as const) {
  test(`the pane does not open by itself ${why}`, async ($, on) => {
    expect(await autoOpenCase($, on, { ...c })).toHaveLength(0)
  })
}

// Ohad, 2026-10-07: drop the diff panel's git condition. Most sessions start in ~/git, which is
// no repository, and questions and steps do not depend on git.
test('the pane opens by itself outside a git repository too', async ($, on) => {
  const opens = await autoOpenCase($, on, { columns: 160, isFullscreen: true, repo: null, closedByPerson: false })
  expect(opens).toHaveLength(1)
})

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
// The audit of the same day found the clickable-question change had dropped the green; Ohad
// chose green text with short jump buttons, [ Q ] and [ A ], so the original check is restored.
test('an answered question is green and its answer button is prominent', async ($, on) => {
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: ANSWERED, version: 1 } }))

  const ui = await $.ui.mount(pane('dock'))

  const texts = await ui.findAll({ type: 'Text' })
  const question = texts.find(t => String(t.text ?? '').includes('Q1'))
  expect((question?.props as { color?: string } | undefined)?.color).toBe('success')
  const answer = (await ui.findAll({ type: 'Button' })).find(b => b.key === 'a-1')
  expect(answer?.props).toMatchObject({ variant: 'primary', label: 'A' })
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

// Ohad, 2026-10-07: steps read like questions — same dot glyphs, same left edge, numbered.
test('step rows are annotated like question rows', async ($, on) => {
  const three = {
    ...BOTH,
    steps: [
      { id: 'plan:1', source: 'plan', subject: 'Write', status: 'completed' },
      { id: 'plan:2', source: 'plan', subject: 'Print', status: 'in_progress' },
      { id: 'plan:3', source: 'plan', subject: 'Count', status: 'pending' },
    ],
  }
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: three, version: 1 } }))

  const ui = await $.ui.mount(pane('dock'))

  // Updated 2026-10-07 at Ohad's request: the dot is its own column, so a wrapped line
  // aligns with the text, not under the dot.
  const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? ''))
  expect(texts.filter(t => /^S\d /.test(t))).toEqual(['S1 Write', 'S2 Print', 'S3 Count'])
  // Updated 2026-10-07 at Ohad's request: the step in progress shows who is on it. With nothing
  // running the session waits on the person, so its mark is ◆ (a grey spinner while the main
  // session works, an hourglass while agents do: see the pulse tests).
  expect(texts.filter(t => /^[○◐●◆]$/.test(t)).slice(-3)).toEqual(['●', '◆', '○'])
})

// Ohad, 2026-10-07: rows sit one step in under their header, in both sections alike.
test('question and step rows are indented the same under their headers', async ($, on) => {
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: BOTH, version: 1 } }))

  const ui = await $.ui.mount(pane('dock'))

  const boxes = await ui.findAll({ type: 'Box' })
  const margin = (key: string) => (boxes.find(b => b.key === key)?.props as { marginLeft?: number } | undefined)?.marginLeft
  expect([margin('row-q-1'), margin('row-s-plan:1')]).toEqual([2, 2])
})

// Ohad, 2026-10-07: show the whole question; a long one wraps, and its next lines align with
// the text, not under the dot.
test('a long question is shown whole, its dot in a column of its own', async ($, on) => {
  const head = 'Why did I check AMQ when only the agent availability check was asked for in the brief?'
  const long = { ...BOTH, questions: [{ ...ANSWERED.questions[0], id: 4, head }] }
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: long, version: 1 } }))

  const ui = await $.ui.mount(pane('dock'))

  const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? ''))
  expect(texts).toContain(`Q4 ${head}`)
  expect(texts).toContain('●')
})

// Observed 2026-10-07 (Ohad): the pane opened by itself at session start, then closed. Every
// reload in the debug logs is followed by `ui.close nested in track#0`: session.start runs again
// on a reload, an enable or a worker respawn, while the pane stays up, and it closed the pane.
const startSession = async (
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  panes: Array<{ id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }>,
) => {
  const closes: string[] = []
  on('ui.panes', () => ({ value: panes }))
  on('ui.close', (_, e) => {
    closes.push(e.id)

    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/Users/ohad.e/git', surface: 'terminal', isInteractive: true })

  return closes
}

test('session.start again (a reload) leaves a placed pane open', async ($, on) => {
  const closes = await startSession($, on, [{ id: 'track', title: 'Track', isShown: true, isFocused: false, isPlaced: true }])
  expect(closes).toEqual([])
})

test('session.start drops a pane that waits undrawn', async ($, on) => {
  const closes = await startSession($, on, [{ id: 'track', title: 'Track', isShown: false, isFocused: false, isPlaced: false }])
  expect(closes).toEqual(['track'])
})

// Ohad, 2026-10-07: after a jump, light the question or answer in the transcript and fade it,
// so the eye finds where the jump landed.
const lightLog = (on: Parameters<TestBody>[1]) => {
  const levels: Array<[string, number]> = []
  let version = 1
  on('state.set', { plugin: 'track', key: 'flash' }, (_, e) => {
    levels.push([String(e.id), Number(e.value)])
    version += 1

    return { value: { isSet: true as const, version } }
  })

  return levels
}

// Ohad, 2026-10-07: remove [ asked ]; then, after the audit, short jump buttons [ Q ] and [ A ]
// beside the green question text. The kit cannot raise a transcript scroll: a probe answering
// on('ui.scroll') with {}, { value: {} } and { deny } each still failed "no implementation for
// ui.scroll". So the test reads the debug line that carries the exact scroll arguments, the
// toast that reports the refusal, and the row the press lights.
const jumpLog = (on: Parameters<TestBody>[1]) => {
  const logs: string[] = []
  const toasts: string[] = []
  on('ui.log', (_, e) => {
    logs.push(String(e.text))

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))

    return { value: undefined }
  })

  return { logs, toasts }
}

test('[ Q ] jumps to where the question was asked; there is no asked button', async ($, on) => {
  mock.clock(on)
  const levels = lightLog(on)
  const { logs, toasts } = jumpLog(on)
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: ANSWERED, version: 1 } }))

  const ui = await $.ui.mount(pane('dock'))

  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.map(b => (b.props as { label?: string }).label)).not.toContain('asked')
  expect(buttons.find(b => b.key === 'q-1')?.props).toMatchObject({ label: 'Q' })
  await ui.press({ key: 'q-1' })
  expect(logs).toContain('track: jump {"to":{"requestId":"row-1"},"block":"start"}')
  expect(toasts.some(t => t.startsWith('track: cannot jump'))).toBe(true)
  expect(levels.filter(([, level]) => level > 0).map(([id]) => id)).toEqual(['row-1'])
})

test('[ A ] jumps to the end of the answer', async ($, on) => {
  mock.clock(on)
  const { logs } = jumpLog(on)
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: ANSWERED, version: 1 } }))

  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })

  expect(logs).toContain('track: jump {"to":{"requestId":"toolu_a"},"block":"end"}')
})

test('a jump to the question lights its prompt row, then fades it out', async ($, on) => {
  const clock = mock.clock(on)
  const levels = lightLog(on)
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: ANSWERED, version: 1 } }))

  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'q-1' })

  const row = () => levels.filter(([id]) => id === 'row-1').map(([, level]) => level)
  expect(row()[0]).toBeGreaterThan(0)
  await clock.advance(5000)
  const seen = row()
  expect(seen.at(-1)).toBe(0)
  expect(seen.length).toBeGreaterThan(2)
  expect(seen.every((level, i) => i === 0 || level < (seen[i - 1] as number))).toBe(true)
})

test('a jump to the answer lights the answer text and the mark under it', async ($, on) => {
  mock.clock(on)
  const levels = lightLog(on)
  const withText = { ...ANSWERED, questions: [{ ...ANSWERED.questions[0], answerKey: 'aaaa1111-bbbb-cccc-dddd' }] }
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: withText, version: 1 } }))

  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })

  const lit = levels.filter(([, level]) => level > 0).map(([id]) => id)
  expect(lit).toContain('toolu_a')
  expect(lit).toContain('aaaa1111-bbbb-cccc-dddd')
})

const userRow = (requestId: string) => ({
  plugin: 'track',
  surface: 'terminal' as const,
  component: 'UserMessage' as const,
  requestId,
  props: { text: 'what is the capital of Australia?', origin: { kind: 'composer' }, isExpanded: false },
})

const flashAt = (on: Parameters<TestBody>[1], lit: Record<string, number>) =>
  on('state.get', { plugin: 'track', key: 'flash' }, (_, e) => ({ value: { value: lit[String(e.id)] ?? 0, version: 1 } }))

test('a lit prompt row is drawn on a highlight; an unlit one is left alone', async ($, on) => {
  flashAt(on, { 'row-1': 3 })
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: ANSWERED, version: 1 } }))
  on('ui.render', { component: 'UserMessage' }, () => ({ type: 'Text', props: {}, children: ['the prompt'] }))

  const lit = await $.ui.mount(userRow('row-1') as never)
  const plain = await $.ui.mount(userRow('row-2') as never)

  const background = async (ui: { findAll: (q: { type: string }) => Promise<Array<{ props: unknown }>> }) =>
    (await ui.findAll({ type: 'Box' })).map(b => (b.props as { backgroundColor?: string }).backgroundColor).filter(Boolean)
  expect(await background(lit)).toHaveLength(1)
  expect(await background(plain)).toHaveLength(0)
})

test('the lit answer mark is drawn on a highlight', async ($, on) => {
  flashAt(on, { toolu_row: 3 })
  on('ui.render', { component: 'ToolUse' }, () => ({ type: 'Text', props: {}, children: ['engine row'] }))

  const mark = await $.ui.mount(toolRow('mcp__track__mark_answered', { id: 1, status: 'answered' }))

  const markText = (await mark.findAll({ type: 'Text' }))[0]
  expect((markText?.props as { backgroundColor?: string } | undefined)?.backgroundColor).toBeDefined()
})

// Audit 2026-10-07 (both engines): a hash of the words matched the stored message's joined text
// blocks against one drawn block, and lit identical replies together. The answer's text row is
// now keyed by its row id: the engine draws an assistant row under its uuid with the last group
// zeroed (debug log of session 7bb54c88, image-thumbs probe), as it draws a prompt row.
const ROW = 'aaaa1111-bbbb-cccc-dddd'
const TURN_WITH_TEXT = { currentId: 't1', gatedTurnId: null, lastText: { row: ROW, turnId: 't1' } }

const answeredWith = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], turnState: unknown, status = 'answered') => {
  let written: { answerKey?: string } | undefined
  on('state.get', { plugin: 'track', key: 'turn' }, () => ({ value: { value: turnState, version: 1 } }))
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({
    value: { value: { ...OPEN_ONE, questions: [{ ...OPEN_ONE.questions[0], answerKey: 'stale-key' }] }, version: 1 },
  }))
  on('state.set', { plugin: 'track', key: 'ledger' }, (_, e) => {
    written = (e.value as { questions: Array<{ answerKey?: string }> }).questions[0]

    return { value: { isSet: true as const, version: 2 } }
  })
  await $.tool.call({ tool: 'mcp__track__mark_answered', tool_use_id: 'toolu_mark', id: 1, status } as never)

  return written
}

test('mark_answered keys the answer by the last text row the model wrote this turn', async ($, on) => {
  expect((await answeredWith($, on, TURN_WITH_TEXT))?.answerKey).toBe(ROW)
})

test('mark_answered keeps no answer key when this turn wrote no text, or when deferred', async ($, on) => {
  const other = { ...TURN_WITH_TEXT, lastText: { row: ROW, turnId: 't0' } }
  expect((await answeredWith($, on, other))?.answerKey).toBeUndefined()
})

test('a deferred question gets no answer key', async ($, on) => {
  expect((await answeredWith($, on, TURN_WITH_TEXT, 'deferred'))?.answerKey).toBeUndefined()
})

test('the answer text row is lit by its row key; another row with the same words is not', async ($, on) => {
  const answer = 'Canberra is the capital of Australia.'
  flashAt(on, { [ROW]: 3 })
  on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'Text', props: {}, children: [answer] }))

  const block = (requestId: string) => ({
    plugin: 'track',
    surface: 'terminal' as const,
    component: 'AssistantMessage' as const,
    requestId,
    props: { text: answer, isFirstOfReply: true },
  })
  const backgrounds = async (ui: { findAll: (q: { type: string }) => Promise<Array<{ props: unknown }>> }) =>
    (await ui.findAll({ type: 'Box' })).map(b => (b.props as { backgroundColor?: string }).backgroundColor).filter(Boolean)
  expect(await backgrounds(await $.ui.mount(block(`${ROW}-000000000000`)))).toHaveLength(1)
  expect(await backgrounds(await $.ui.mount(block('eeee2222-ffff-0000-1111-000000000000')))).toHaveLength(0)
})

// Audit 2026-10-07 (both engines, reproduced on a fixture): a fade step already under way could
// clear a newer jump's lit list, so a later jump or a reload left that row lit for good.
test('a fade step under way when a new jump lands does not undo the new jump', async ($, on) => {
  const clock = mock.clock(on)
  const flash = new Map<string, number>()
  let lit: string[] = []
  let release: (() => void) | undefined
  let version = 1
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: ANSWERED, version: 1 } }))
  on('state.get', { plugin: 'track', key: 'flash' }, (_, e) => ({ value: { value: flash.get(String(e.id)) ?? 0, version } }))
  on('state.get', { plugin: 'track', key: 'lit' }, () => ({ value: { value: lit, version } }))
  on('state.set', { plugin: 'track', key: 'lit' }, (_, e) => {
    lit = e.value as string[]
    version += 1

    return { value: { isSet: true as const, version } }
  })
  on('state.set', { plugin: 'track', key: 'flash' }, async (_, e) => {
    // Hold the old jump's last fade step until the new jump has been pressed.
    if (String(e.id) === 'row-1' && Number(e.value) === 0 && release === undefined) {
      await new Promise<void>(resolve => {
        release = resolve
      })
    }
    flash.set(String(e.id), Number(e.value))
    version += 1

    return { value: { isSet: true as const, version } }
  })

  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'q-1' })
  await clock.advance(5000)
  expect(release).toBeDefined()
  // The new jump runs as far as it can while the old step is held, then the old step finishes.
  const pressed = ui.press({ key: 'a-1' })
  await clock.advance(0)
  release?.()
  await pressed
  await clock.advance(0)

  expect(lit).toEqual(['toolu_a'])
  expect(flash.get('toolu_a')).toBe(3)
})

// Audit 2026-10-07: session.start did its housekeeping before registering /track and the tools,
// so one refused call there left the session without them.
test('session.start registers /track and the tools even when its pane housekeeping fails', async ($, on) => {
  const commands: string[] = []
  on('ui.panes', () => ({ deny: 'no panes here' }))
  on('command.register', (_, e) => {
    commands.push(e.name)

    return { value: { command: e.name } }
  })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/Users/ohad.e/git', surface: 'terminal', isInteractive: true })

  expect(commands).toEqual(['track'])
})

test('session.start puts out rows a reload left lit', async ($, on) => {
  const levels = lightLog(on)
  on('ui.panes', () => ({ value: [] }))
  on('state.get', { plugin: 'track', key: 'lit' }, () => ({ value: { value: ['row-9'], version: 1 } }))
  on('state.set', { plugin: 'track', key: 'lit' }, () => ({ value: { isSet: true as const, version: 2 } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/Users/ohad.e/git', surface: 'terminal', isInteractive: true })

  expect(levels).toEqual([['row-9', 0]])
})

// Observed 2026-10-07: "do a /retro" ran its steps unlisted until Ohad asked. The debug logs of
// that day show "track: prompt.compose bypassed by cc-plugin-sec-default", so the standing rule
// never reached the model; each prompt carries the steps instruction instead, while the rule is
// bypassed. Then Plannotator's review comments (a plugin's prompt) added work and no step.
const submitted = async (
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  text: string,
  origin: unknown = { kind: 'composer' },
  composeSeen = false,
) => {
  let context: readonly string[] = []
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: { v: 1, nextQuestionId: 1, prompts: [], questions: [], steps: [] }, version: 1 } }))
  on('state.get', { plugin: 'track', key: 'turn' }, () => ({ value: { value: { currentId: null, gatedTurnId: null, ...(composeSeen && { composeSeen: true }) }, version: 1 } }))
  on('command.list', () => ({
    value: [
      { name: 'retro', description: 'retro', source: 'plugin' as const },
      { name: 'compact', description: 'compact', source: 'builtin' as const },
      { name: 'track', description: 'track', source: 'plugin' as const },
    ],
  }))
  on('prompt.submit', (_, e) => {
    context = e.context ?? []

    return { text: e.text }
  })
  await $.prompt.submit({ text, origin } as never)

  return context.join('\n')
}

test('a typed prompt with nothing open still tells the model to send multi-step work to track', async ($, on) => {
  expect(await submitted($, on, 'stop it now, and do a /retro why you did that')).toContain('mcp__track__track_steps')
})

test('a skill typed as a slash command carries the steps instruction too', async ($, on) => {
  expect(await submitted($, on, '/retro')).toContain('mcp__track__track_steps')
})

test('a built-in command and /track carry no steps instruction', async ($, on) => {
  expect(await submitted($, on, '/compact')).not.toContain('track_steps')
})

test('/track carries no steps instruction', async ($, on) => {
  expect(await submitted($, on, '/track status')).not.toContain('track_steps')
})

test('a plugin\'s prompt (review comments) carries the steps instruction, naming after', async ($, on) => {
  const context = await submitted($, on, 'Ohad annotated the retro report: fix section 2.', { kind: 'plugin', name: 'plannotator' })
  expect(context).toContain('mcp__track__track_steps')
  expect(context).toContain('after')
})

test('a task notification carries no steps instruction', async ($, on) => {
  expect(await submitted($, on, '<task-notification>done</task-notification>', { kind: 'task-notification' })).not.toContain('track_steps')
})

test('no steps instruction rides on the prompt once the system rule reached the model', async ($, on) => {
  expect(await submitted($, on, 'do a /retro', { kind: 'composer' }, true)).not.toContain('track_steps')
})

// Ohad, 2026-10-07: new work mid-plan (review comments) gets a step of its own, in place.
test('track_steps with after inserts steps after that step and keeps the plan', async ($, on) => {
  const writes = captureSteps(
    on,
    withSteps([
      { id: 'plan:1', source: 'plan', subject: 'Draft the retro', status: 'completed' },
      { id: 'plan:2', source: 'plan', subject: 'Open it in Plannotator', status: 'in_progress' },
      { id: 'plan:3', source: 'plan', subject: 'Save the retro', status: 'pending' },
    ]),
  )

  await $.tool.call({ tool: 'mcp__track__track_steps', steps: ['Apply Ohad\'s review comments'], after: 'plan:2' } as never)

  expect(writes.at(-1)?.steps.map(s => `${s.id}|${s.subject}|${s.status}`)).toEqual([
    'plan:1|Draft the retro|completed',
    'plan:2|Open it in Plannotator|in_progress',
    'plan:4|Apply Ohad\'s review comments|pending',
    'plan:3|Save the retro|pending',
  ])
})

// Ohad, 2026-10-07: /track should act like /btw, at once while a turn runs and without a row in
// the session. The command is registered `immediate`, and the toggle answers with no text.
test('/track is registered to run at once while a turn is in flight', async ($, on) => {
  const commands: Array<{ name: string; immediate?: true }> = []
  on('ui.panes', () => ({ value: [] }))
  on('command.register', (_, e) => {
    commands.push(e)

    return { value: { command: e.name } }
  })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/Users/ohad.e/git', surface: 'terminal', isInteractive: true })

  expect(commands.find(c => c.name === 'track')).toMatchObject({ immediate: true })
})

test('/track opens and hides the pane without writing a transcript row', async ($, on) => {
  let isOpen = false
  mock.store(on)
  on('state.get', { plugin: 'track', key: 'pane' }, () => ({ value: { value: { isOpen, hidden: false, closedByPerson: false }, version: 1 } }))
  on('state.set', { plugin: 'track', key: 'pane' }, (_, e) => {
    isOpen = (e.value as { isOpen: boolean }).isOpen

    return { value: { isSet: true as const, version: 2 } }
  })
  const calls: string[] = []
  on('ui.open', (_, e) => {
    calls.push(`open ${e.id}`)

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_, e) => {
    calls.push(`close ${e.id}`)

    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))

  const opened = await $.command.run({ command: 'track', args: '' } as never)
  const hidden = await $.command.run({ command: 'track', args: '' } as never)

  expect([opened?.text, hidden?.text]).toEqual([undefined, undefined])
  expect(calls).toEqual(['open track', 'close track'])
})

// Ohad, 2026-10-07: a colored banner at the top of the pane says where the session stands:
// working, waiting on agents, waiting on you, or safe to close.
const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [] }

const banner = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], ledger: unknown, activity: unknown) => {
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: ledger, version: 1 } }))
  on('state.get', { plugin: 'track', key: 'activity' }, () => ({ value: { value: activity, version: 1 } }))
  const ui = await $.ui.mount(pane('dock'))

  return (await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? '')).join('\n')
}

test('the banner says Working while the main turn runs', async ($, on) => {
  expect(await banner($, on, ANSWERED, { ...IDLE, isWorking: true })).toContain('Working')
})

test('the banner says Waiting on agents while an Agent call runs', async ($, on) => {
  expect(await banner($, on, ANSWERED, { ...IDLE, isWorking: true, agentCalls: ['toolu_ag'] })).toContain('Waiting on agents')
})

test('the banner says Waiting on agents after the turn while background work runs', async ($, on) => {
  expect(await banner($, on, ANSWERED, { ...IDLE, background: ['ag1', 'task7'] })).toContain('Waiting on agents')
})

test('the banner says Waiting on you while a question to the user is open', async ($, on) => {
  expect(await banner($, on, ANSWERED, { ...IDLE, isWorking: true, askCalls: ['toolu_ask'] })).toContain('Waiting on you')
})

test('the banner says Waiting on you after the turn while a question or step is open', async ($, on) => {
  expect(await banner($, on, OPEN_ONE, IDLE)).toContain('Waiting on you')
})

test('the banner says Safe to close when the turn ended and nothing is open or running', async ($, on) => {
  expect(await banner($, on, ANSWERED, IDLE)).toContain('Safe to close')
})

test('turns, a background agent and its notification drive the banner state', async ($, on) => {
  let activity: { isWorking: boolean; background: string[] } = { ...IDLE }
  let version = 1
  on('state.get', { plugin: 'track', key: 'activity' }, () => ({ value: { value: activity, version } }))
  on('state.set', { plugin: 'track', key: 'activity' }, (_, e) => {
    activity = e.value as typeof activity
    version += 1

    return { value: { isSet: true as const, version } }
  })
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: { ...ANSWERED, questions: [] }, version: 1 } }))
  on('state.set', { plugin: 'track', key: 'ledger' }, () => ({ value: { isSet: true as const, version: 2 } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'ag1' } }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('session.id', () => ({ value: 'S1' }))
  mock.store(on)

  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(activity.isWorking).toBe(true)
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_ag', description: 'x', prompt: 'y', run_in_background: true } as never)
  await $.turn.complete({ answer: 'done', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  expect(activity).toMatchObject({ isWorking: false, background: ['ag1'] })
  await $.prompt.submit({ text: '<task-notification><task-id>ag1</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' } } as never)
  expect(activity.background).toEqual([])
})

// Observed 2026-10-07 (Ohad, session 68a12838): [ Q ] on Q2 ("2+2") jumped to the first "1+1"
// prompt. The saved ledger showed prompt 1 linked to the engine's `placeholder` row, and prompts
// 2 and 3 both linked to prompt 1's row: a drawn row that matched no prompt went to the first
// prompt still unlinked. A prompt is linked only to the row drawn under its own id.
const A = '3f6ecc74-f6f0-45c2-908e'
const B = 'ef24fc1c-0e37-4159-9281'
const C = '13fd2a23-6943-4a0e-96e9'
const THREE_PROMPTS = {
  v: 1,
  nextQuestionId: 3,
  steps: [],
  prompts: [A, B, C].map((rowKey, i) => ({ rowKey, head: `prompt ${i + 1}`, turnId: `t${i + 1}`, at: i })),
  questions: [{ id: 2, head: '2+2?', at: 3, rowKey: C, turnId: 't3', status: 'answered' }],
}

const drawPrompts = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], ledger: unknown, requestIds: string[]) => {
  const clock = mock.clock(on)
  let current = ledger
  let version = 1
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: current, version } }))
  on('state.set', { plugin: 'track', key: 'ledger' }, (_, e) => {
    current = e.value
    version += 1

    return { value: { isSet: true as const, version } }
  })
  on('state.get', { plugin: 'track', key: 'flash' }, () => ({ value: { value: 0, version: 1 } }))
  on('ui.render', { component: 'UserMessage' }, () => ({ type: 'Text', props: {}, children: ['a prompt'] }))
  // Each id is drawn and taken down again, as the transcript redraws a row.
  for (const requestId of requestIds) {
    const ui = await $.ui.mount(userRow(requestId) as never)
    await clock.advance(10)
    await ui.unmount()
  }

  return current as typeof THREE_PROMPTS & { prompts: Array<{ rowKey: string; requestId?: string }>; questions: Array<{ askedRequestId?: string }> }
}

test('a drawn row links only the prompt with its own id; a placeholder or another row links none', async ($, on) => {
  const ledger = await drawPrompts($, on, THREE_PROMPTS, ['placeholder', `${A}-980eda5aad4b`, `${A}-980eda5aad4b`, `${C}-a6e9b0000001`])

  expect(ledger.prompts.map(p => p.requestId)).toEqual([`${A}-980eda5aad4b`, undefined, `${C}-a6e9b0000001`])
  expect(ledger.questions[0]?.askedRequestId).toBe(`${C}-a6e9b0000001`)
})

test('a question linked to the wrong row is repaired when its own prompt row is drawn', async ($, on) => {
  const wrong = {
    ...THREE_PROMPTS,
    prompts: THREE_PROMPTS.prompts.map(p => ({ ...p, requestId: `${A}-980eda5aad4b` })),
    questions: [{ ...THREE_PROMPTS.questions[0], askedRequestId: `${A}-980eda5aad4b` }],
  }
  const ledger = await drawPrompts($, on, wrong, [`${C}-a6e9b0000001`])

  expect(ledger.prompts.find(p => p.rowKey === C)?.requestId).toBe(`${C}-a6e9b0000001`)
  expect(ledger.questions[0]?.askedRequestId).toBe(`${C}-a6e9b0000001`)
})

test('[ Q ] is not offered for a question whose stored row is another prompt\'s', async ($, on) => {
  const wrong = { ...ANSWERED, questions: [{ ...ANSWERED.questions[0], rowKey: C, askedRequestId: `${A}-980eda5aad4b` }] }
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: wrong, version: 1 } }))

  const ui = await $.ui.mount(pane('dock'))

  expect((await ui.findAll({ type: 'Button' })).find(b => b.key === 'q-1')).toBeUndefined()
})

// Ohad, 2026-10-07: the step in progress blinks slowly, and differently by who is working: the
// main session (grey shades, a turning spinner), agents it waits on (amber, an hourglass); while
// it waits on the person the row holds still in the banner's purple.
const IN_PROGRESS = {
  ...ANSWERED,
  steps: [
    { id: 'plan:1', source: 'plan', subject: 'Write', status: 'completed' },
    { id: 'plan:2', source: 'plan', subject: 'Print', status: 'in_progress' },
    { id: 'plan:3', source: 'plan', subject: 'Count', status: 'pending' },
  ],
}

const stepRow = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], activity: unknown, phase = 0) => {
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: IN_PROGRESS, version: 1 } }))
  on('state.get', { plugin: 'track', key: 'activity' }, () => ({ value: { value: activity, version: 1 } }))
  on('state.get', { plugin: 'track', key: 'pulse' }, () => ({ value: { value: phase, version: 1 } }))
  mock.clock(on)
  const ui = await $.ui.mount(pane('dock'))
  const texts = await ui.findAll({ type: 'Text' })
  const at = texts.findIndex(t => String(t.text ?? '') === 'S2 Print')
  const color = (t: { props: unknown } | undefined) => (t?.props as { color?: string } | undefined)?.color

  return { glyph: String(texts[at - 1]?.text ?? ''), glyphColor: color(texts[at - 1]), textColor: color(texts[at]) }
}

test('while the main session works, the step in progress turns a spinner in grey shades', async ($, on) => {
  const first = await stepRow($, on, { ...IDLE, isWorking: true }, 0)
  expect(['◐', '◓', '◑', '◒']).toContain(first.glyph)
  expect(first.textColor).toMatch(/^#[0-9a-f]{6}$/)
  const [r, g, b] = [1, 3, 5].map(i => parseInt(String(first.textColor).slice(i, i + 2), 16)) as [number, number, number]
  expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(40)
})

test('while the session waits on agents, the step in progress pulses amber under an hourglass', async ($, on) => {
  const row = await stepRow($, on, { ...IDLE, isWorking: true, agentCalls: ['toolu_ag'] }, 0)
  expect(row.glyph).toBe('⧗')
  const [r, , b] = [1, 3, 5].map(i => parseInt(String(row.textColor).slice(i, i + 2), 16)) as [number, number, number]
  expect(r - b).toBeGreaterThan(60)
})

test('while the session waits on the person, the step in progress holds still in purple', async ($, on) => {
  const row = await stepRow($, on, IDLE, 3)
  expect(row).toMatchObject({ glyph: '◆', glyphColor: 'permission' })
})

test('the pulse ticks only while a step is in progress and the session or its agents work', async ($, on) => {
  const ticks: number[] = []
  let activity: unknown = { ...IDLE, isWorking: true }
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: IN_PROGRESS, version: 1 } }))
  on('state.get', { plugin: 'track', key: 'activity' }, () => ({ value: { value: activity, version: 1 } }))
  on('state.set', { plugin: 'track', key: 'pulse' }, (_, e) => {
    ticks.push(Number(e.value))

    return { value: { isSet: true as const, version: ticks.length + 1 } }
  })
  const clock = mock.clock(on)

  await $.ui.mount(pane('dock'))
  await clock.advance(1300)
  const whileWorking = ticks.length
  activity = IDLE
  await clock.advance(1300)
  const afterIdle = ticks.length
  await clock.advance(1300)

  expect(whileWorking).toBeGreaterThanOrEqual(2)
  expect(ticks.length).toBe(afterIdle)
})
