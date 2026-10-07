import { expect, mock, test } from 'claude-code/testing'

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

  const labels = (await ui.findAll({ type: 'Button' })).map(b => String((b.props as { label?: string }).label ?? ''))
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

  const labels = (await ui.findAll({ type: 'Button' })).map(b => String((b.props as { label?: string }).label ?? ''))
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
