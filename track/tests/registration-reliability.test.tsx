import { expect, mock, test } from 'claude-code/testing'

import { EMPTY, atomStore } from './kit'

const PLAN = { id: 'plan:1', source: 'plan', subject: 'Finish the authorized change', status: 'in_progress', startedAt: 10 }

test('plan approval appends exactly one reminder without losing existing result context', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({ result: { plan: 'Prose only', isAgent: false }, context: ['keep this'], ref: 42 }))

  const result = await $.tool.call({ tool: 'ExitPlanMode' })

  expect(result.context).toHaveLength(2)
  expect(result.context?.[0]).toBe('keep this')
  expect(result.context?.[1]).toContain('mcp__track__track_steps')
  expect(result.ref).toBe(42)
})

test('successful plan approval preserves the whole ledger and adds one reminder after existing context', async ($, on) => {
  const initial = { ...EMPTY, steps: [PLAN], withdrawn: [{ id: 7, head: 'withdrawn' }] }
  const ledger = atomStore(on, 'ledger', initial)
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({ result: { plan: '1. Scope\n2. Verification\n- [x] Noise', isAgent: false }, context: ['keep this'], ref: 42 }))

  const result = await $.tool.call({ tool: 'ExitPlanMode' })

  expect(ledger.value).toEqual(initial)
  expect(ledger.writes).toEqual([])
  expect(result.context).toHaveLength(2)
  expect(result.context?.[0]).toBe('keep this')
  expect(result.context?.[1]).toContain('mcp__track__track_steps')
  expect(result.ref).toBe(42)
})

test('a refused plan approval carries no reminder and does not mutate the ledger', async ($, on) => {
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: [PLAN] })
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({ deny: 'approval refused' }))

  expect(await $.tool.call({ tool: 'ExitPlanMode' })).toEqual({ deny: 'approval refused' })
  expect(ledger.writes).toEqual([])
})

test('same-turn text before the question is never its answer, even at equal timestamps', async ($, on) => {
  const ledger = atomStore(on, 'ledger', { ...EMPTY, questions: [{ id: 1, head: 'Later question', at: 100, turnId: 't1', trackedOrder: 2, status: 'open', answerKey: 'stale' }] })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 2, lastText: { row: 'earlier-text', turnId: 't1', order: 1, at: 100 } })

  const before = JSON.stringify(ledger.value)
  const refused = await $.tool.call({ tool: 'mcp__track__mark_answered', tool_use_id: 'answer', id: 1, status: 'answered' } as never)

  expect(refused.deny).toContain('answer_text')
  expect(JSON.stringify(ledger.value)).toBe(before)
  expect(ledger.value.questions[0].status).toBe('open')
})

test('same-turn answer linking fails closed when event order is unknown', async ($, on) => {
  const ledger = atomStore(on, 'ledger', { ...EMPTY, questions: [{ id: 1, head: 'Legacy question', at: 100, turnId: 't1', status: 'open' }] })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, lastText: { row: 'unknown-order', turnId: 't1' } })

  await $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'answered' } as never)

  expect((ledger.value.questions[0] as { answerKey?: string }).answerKey).toBeUndefined()
})

test('step-update result identifies the affected step by id and title', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, steps: [PLAN, { ...PLAN, id: 'plan:2', subject: 'Unrelated step' }] })

  const result = await $.tool.call({ tool: 'mcp__track__mark_step', id: 'plan:1', status: 'completed' } as never)

  expect(String(result.result)).toContain('plan:1')
  expect(String(result.result)).toContain(PLAN.subject)
  expect(String(result.result)).not.toContain('Unrelated step')
})

test('a question tracked in a later plugin turn cannot bind earlier text through the previous composer turn', async ($, on) => {
  const ledger = atomStore(on, 'ledger', { ...EMPTY, prompts: [{ head: 'Previous composer prompt', turnId: 't1', at: 10, rowKey: 'previous-prompt' }], questions: [] as any[] })
  atomStore(on, 'turn', { currentId: 't2', gatedTurnId: null, eventOrder: 1, lastText: { row: 'before-question', turnId: 't2', order: 1 } })
  atomStore(on, 'scrollAt', { questions: null, steps: null })

  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'New plugin-delivered question', tool_use_id: 'track-q' } as never)
  await $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'answered' } as never)

  expect(ledger.value.questions[0].answerKey).toBeUndefined()
  expect(ledger.value.questions[0].turnId).toBe('t2')
})

test('equal event orders fail closed when linking an answer', async ($, on) => {
  const ledger = atomStore(on, 'ledger', { ...EMPTY, questions: [{ id: 1, head: 'Question', turnId: 't1', trackedOrder: 2, status: 'open', at: 100 }] })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 2, lastText: { row: 'same-order', turnId: 't1', order: 2 } })
  await $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'answered' } as never)
  expect((ledger.value.questions[0] as { answerKey?: string }).answerKey).toBeUndefined()
})

test('a question from an earlier turn may link to text in a fresh later turn', async ($, on) => {
  const ledger = atomStore(on, 'ledger', { ...EMPTY, questions: [{ id: 1, head: 'Saved question', turnId: 'old', trackedOrder: 5, status: 'open', at: 100 }] })
  atomStore(on, 'turn', { currentId: 'new', gatedTurnId: null, eventOrder: 1, lastText: { row: 'later-answer', requestId: 'later-response', text: 'A later answer', turnId: 'new', order: 1 } })
  await $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'answered', answer_request_id: 'later-response' } as never)
  expect((ledger.value.questions[0] as { answerKey?: string }).answerKey).toBe('later-answer')
})

for (const failure of ['error', 'agent']) {
  test(`plan approval from an ${failure} result is unchanged`, async ($, on) => {
    const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: [PLAN] })
    const answer = { result: { plan: '1. Do not import', isAgent: failure === 'agent' }, ...(failure === 'error' && { isError: true }), context: ['keep'], ref: 42 }
    on('tool.call', { tool: 'ExitPlanMode' }, () => answer)
    expect(await $.tool.call({ tool: 'ExitPlanMode' })).toEqual(answer)
    expect(ledger.writes).toEqual([])
  })
}
