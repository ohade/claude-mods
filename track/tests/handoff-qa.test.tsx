import { expect, mock, test } from 'claude-code/testing'

import { EMPTY, SESSION, atomStore, logs, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'

// After a handoff the fresh session gets the old session's questions back with its steps, and the
// person reads the old answers in the restore call's row. So an answered question keeps the text
// of the answer it follows, and the saved register carries it to the next session.

type Q = {
  id: number
  head: string
  status: string
  at: number
  turnId: string | null
  note?: string
  answerText?: string
  answeredAt?: number
  restoredFrom?: string
  rowKey?: string
  askedRequestId?: string
  answerRequestId?: string
  answerKey?: string
  trackedBy?: string
  cleared?: true
}
type L = { nextQuestionId: number; questions: Q[]; steps: Array<{ id: string; subject: string; status: string }> }

const OLD = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
const TOOL = 'mcp__track__restore_tracker'
const RESTORE = 'toolu_restore'
const ANSWER = 'Canberra is the capital of Australia.'
const NOTE = 'waits for the release window'

// The old session: an answered question with its links and text, one cleared from the pane, a
// deferred one, one answered before answers were saved, and an open one.
const OLD_QUESTIONS: Q[] = [
  {
    id: 1,
    head: 'what is the capital of Australia?',
    status: 'answered',
    at: 1000,
    turnId: 't0',
    rowKey: 'a0000001-0000-4000-8000',
    askedRequestId: 'a0000001-0000-4000-8000-000000000000',
    trackedBy: 'toolu_old_q1',
    answerRequestId: 'toolu_old_a1',
    answerKey: 'c0000001-0000-4000-8000',
    answeredAt: 1100,
    answerText: ANSWER,
  },
  { id: 2, head: 'a question cleared from the pane', status: 'answered', at: 1200, turnId: 't0', answeredAt: 1300, cleared: true },
  { id: 3, head: 'when does the deploy run?', status: 'deferred', at: 1400, turnId: 't0', answeredAt: 1500, note: NOTE },
  { id: 4, head: 'answered before answers were saved', status: 'answered', at: 1600, turnId: 't0', answeredAt: 1700 },
  { id: 5, head: 'is the cache warm?', status: 'open', at: 1800, turnId: 't0' },
]
const OLD_STEPS = [
  { id: 'plan:1', source: 'plan', subject: 'Fix the pane', status: 'completed' },
  { id: 'plan:2', source: 'plan', subject: 'Deploy', status: 'in_progress' },
]
const SAVED = { v: 1, savedAt: 1, ledger: { ...EMPTY, nextQuestionId: 6, questions: OLD_QUESTIONS, steps: OLD_STEPS } }
const QUESTIONS_ONLY = { ...SAVED, ledger: { ...SAVED.ledger, steps: [] } }
const RESTORED_HEADS = ['what is the capital of Australia?', 'when does the deploy run?', 'answered before answers were saved', 'is the cache warm?']

// The new session already asked a question of its own.
const OWN = { ...EMPTY, nextQuestionId: 2, questions: [{ id: 1, head: 'a question of this session', status: 'open', at: 5000, turnId: 't1' }] }

// `null` stands for a session with nothing saved.
const setUp = (on: On, saved: unknown = SAVED) => {
  const ledger = atomStore<L>(on, 'ledger', OWN as L)
  atomStore(on, 'scroll', { questions: null, steps: null })
  const store = pluginStore(on, saved === null ? {} : { [`s:${OLD}`]: saved })

  return { ledger, store }
}

const restore = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call({ tool: TOOL, tool_use_id: RESTORE, ...input } as never) as Promise<{ result?: unknown; deny?: string }>

const restoredOf = (l: L) => l.questions.filter(q => q.restoredFrom === OLD)

// The restore call's own row in the transcript, under its tool_use_id.
const restoreRow = {
  plugin: 'track',
  surface: 'terminal' as const,
  component: 'ToolUse' as const,
  requestId: RESTORE,
  props: { tool_use_id: RESTORE, tool: TOOL, input: { from_session: OLD }, isRunning: false, isErrored: false, isInterrupted: false },
}

const rowTexts = async ($: Engine) => {
  const ui = await $.ui.mount(restoreRow as never)

  return (await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? ''))
}

// The answer's own words are what the next session shows; a long answer is cut, not dropped.
test('mark_answered keeps the explicitly identified response text, cut at 1000 characters', async ($, on) => {
  mock.clock(on)
  // The question precedes the response in the same turn; record that order explicitly.
  const ledger = atomStore<L>(on, 'ledger', { ...EMPTY, nextQuestionId: 2, questions: [{ id: 1, head: 'why?', status: 'open', at: 1000, turnId: 't1', trackedOrder: 0 }] })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  const long = `Because ${'x'.repeat(1500)}`
  // Nothing beneath the plugins stores the row, so the append rejects once the mod's hook has run.
  await $.session
    .append({ door: 'response', uuid: 'c0000001-0000-4000-8000-000000000001', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: long }] } } as never)
    .catch(() => undefined)

  await $.tool.call({ tool: 'mcp__track__mark_answered', tool_use_id: 'toolu_mark', id: 1, status: 'answered', answer_request_id: 'c0000001-0000-4000-8000-000000000001' } as never)

  expect(ledger.value.questions[0]?.answerText).toBe(`${long.slice(0, 999)}…`)
})

// A resume and a later restore both read the saved bucket: the answer and its origin must survive it.
test('a saved register keeps answerText and restoredFrom through a save and a resume', async ($, on) => {
  mock.clock(on)
  const row: Q = { id: 1, head: 'why?', status: 'answered', at: 1000, turnId: 't1', answeredAt: 1100, answerText: ANSWER, restoredFrom: OLD }
  const ledger = atomStore<L>(on, 'ledger', { ...EMPTY, nextQuestionId: 2, questions: [row] } as L)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('classic.SessionStart', () => ({}))
  await $.turn.complete({ answer: 'done', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
  ledger.value = EMPTY as L

  await $.classic.SessionStart({ source: 'resume', session_id: SESSION } as never)

  expect(ledger.value.questions[0]).toMatchObject({ answerText: ANSWER, restoredFrom: OLD })
})

// Questions the person cleared stay behind; the rest follow this session's own, in saved order.
test('restore_tracker brings back the steps and every question not cleared, with new ids in saved order', async ($, on) => {
  mock.clock(on)
  const { ledger } = setUp(on)

  await restore($, { from_session: OLD })

  expect(ledger.value.steps.map(s => s.id)).toEqual(['plan:1', 'plan:2'])
  expect(ledger.value.questions.map(q => `Q${q.id} ${q.head}`)).toEqual([
    'Q1 a question of this session',
    ...RESTORED_HEADS.map((head, i) => `Q${i + 2} ${head}`),
  ])
  expect(ledger.value.nextQuestionId).toBe(6)
})

// The old rows are in the old transcript: a link to them would jump nowhere, and the gate and the
// rewind check would judge the question by a turn and calls this session never had.
test('a restored question keeps its status, note, answer and times, drops its old row links, and names its session', async ($, on) => {
  mock.clock(on)
  const { ledger } = setUp(on)

  await restore($, { from_session: OLD })

  const [answered, deferred] = restoredOf(ledger.value)
  expect(answered).toMatchObject({ status: 'answered', answerText: ANSWER, at: 1000, answeredAt: 1100, restoredFrom: OLD })
  expect(deferred).toMatchObject({ status: 'deferred', note: NOTE, restoredFrom: OLD })
  for (const field of ['rowKey', 'askedRequestId', 'answerRequestId', 'answerKey', 'trackedBy'] as const) {
    expect(answered?.[field]).toBeUndefined()
  }
  expect(answered?.turnId).not.toBe('t0')
})

// The model needs the ids and where each question stands, not the answers it already wrote.
test('the restore result lists each restored question as Q<id> <status> <summary>, without the answers', async ($, on) => {
  mock.clock(on)
  setUp(on)

  const ran = await restore($, { from_session: OLD })

  const text = String(ran.result)
  expect(text).toContain('Q2 answered what is the capital of Australia?')
  expect(text).toContain('Q3 deferred when does the deploy run?')
  expect(text).toContain('Q5 open is the cache warm?')
  expect(text).not.toContain(ANSWER)
  expect(text).not.toContain('a question cleared from the pane')
})

// The handoff mod calls once; a repeated call must not list the same questions twice.
test('a second restore from the same session succeeds with the same questions and ids', async ($, on) => {
  mock.clock(on)
  const { ledger } = setUp(on, QUESTIONS_ONLY)
  await restore($, { from_session: OLD })
  const ids = restoredOf(ledger.value).map(q => q.id)

  const again = await restore($, { from_session: OLD })

  expect(again.deny).toBeUndefined()
  expect(restoredOf(ledger.value).map(q => q.id)).toEqual(ids)
  expect(restoredOf(ledger.value)).toHaveLength(RESTORED_HEADS.length)
})

test('a second restore with replace replaces the questions from that session, and keeps this session\'s own', async ($, on) => {
  mock.clock(on)
  const { ledger } = setUp(on, QUESTIONS_ONLY)
  await restore($, { from_session: OLD })

  await restore($, { from_session: OLD, replace: true })

  expect(restoredOf(ledger.value).map(q => q.head)).toEqual(RESTORED_HEADS)
  expect(ledger.value.questions[0]?.head).toBe('a question of this session')
})

// A subagent's work is not the session's; a refused call leaves the register as it was.
test('a subagent cannot restore, and nothing changes', async ($, on) => {
  mock.clock(on)
  const { ledger } = setUp(on)

  const ran = await restore($, { from_session: OLD, agentId: 'agent-1' })

  expect(ran.deny).toContain('subagent')
  expect(ledger.writes).toHaveLength(0)
})

test('a from_session that is not a session id is refused, and nothing changes', async ($, on) => {
  mock.clock(on)
  const { ledger, store } = setUp(on)

  const ran = await restore($, { from_session: 'saved' })

  expect(ran.deny).toContain('session id')
  expect(ledger.writes).toHaveLength(0)
  expect([...store.held.keys()]).toEqual([`s:${OLD}`])
})

test('a session with nothing saved is refused, and nothing changes', async ($, on) => {
  mock.clock(on)
  const { ledger } = setUp(on, null)

  const ran = await restore($, { from_session: OLD })

  expect(ran.deny).toContain(OLD)
  expect(ledger.writes).toHaveLength(0)
})

// The person reads the old answers in the transcript, in the restore call's own row.
test('the restore row shows the counts, each question, and its answer, its note, or that none was saved', async ($, on) => {
  mock.clock(on)
  setUp(on)
  on('ui.render', { component: 'ToolUse' }, () => ({ type: 'Text', props: {}, children: ['engine row'] }))
  await restore($, { from_session: OLD })

  const texts = await rowTexts($)

  expect(texts).toContain('Restored from the previous session: 2 steps, 4 questions')
  expect(texts).toContain('Q2. what is the capital of Australia?')
  expect(texts).toContain('Q5. is the cache warm?')
  expect(texts).toContain(ANSWER)
  expect(texts).toContain(NOTE)
  expect(texts).toContain('(answer text was not saved)')
  expect(texts).not.toContain('engine row')
})

// The row is drawn from what the call restored, not from the pane, so clearing the pane keeps it.
test('the restore row still shows the answers after the questions are cleared from the pane', async ($, on) => {
  mock.clock(on)
  const { ledger } = setUp(on)
  logs(on)
  on('ui.render', { component: 'ToolUse' }, () => ({ type: 'Text', props: {}, children: ['engine row'] }))
  await restore($, { from_session: OLD })
  const ui = await $.ui.mount(pane('dock', 60, 40))
  await ui.press({ key: 'clear-questions' })
  expect(ledger.value.questions).toHaveLength(0)

  const texts = await rowTexts($)

  expect(texts).toContain('Restored from the previous session: 2 steps, 4 questions')
  expect(texts).toContain(ANSWER)
})

// A restored question's rows are in the old transcript; the restore row is where it shows here.
test('[ A ] of a restored question reveals the observed restore row', async ($, on) => {
  mock.clock(on)
  setUp(on)
  const lines = logs(on)
  await restore($, { from_session: OLD })
  await rowTexts($)
  const ui = await $.ui.mount(pane('dock', 60, 40))

  await ui.press({ key: 'a-2' })

  expect(lines.filter(line => line.startsWith('track: jump'))).toEqual([`track: jump {"to":{"requestId":"${RESTORE}"},"block":"start"}`])
})

test('[ Q ] of a restored question reveals the observed restore row', async ($, on) => {
  mock.clock(on)
  setUp(on)
  const lines = logs(on)
  await restore($, { from_session: OLD })
  await rowTexts($)
  const ui = await $.ui.mount(pane('dock', 60, 40))

  await ui.press({ key: 'q-5' })

  expect(lines.filter(line => line.startsWith('track: jump'))).toEqual([`track: jump {"to":{"requestId":"${RESTORE}"},"block":"start"}`])
})
