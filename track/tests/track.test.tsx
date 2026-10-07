import { expect, test } from 'claude-code/testing'

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
