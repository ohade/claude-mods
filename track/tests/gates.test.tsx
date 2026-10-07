import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Pins the two gates the model meets: the track_question tool (it mints a question) and the
// Stop gate (it holds a turn once while a question tracked in it is still open).
// The ledger and turn atoms are answered by state.get / state.set stand-ins that keep the
// last written value, so a second call in the same test sees the first call's write.

type On = Parameters<TestBody>[1]
type QuestionRow = { id: number; head: string; status: string; turnId: string | null; rowKey?: string; askedRequestId?: string; trackedBy?: string }
type LedgerRow = { nextQuestionId: number; questions: QuestionRow[] }

// One atom held in the test: every read sees the last write, and each write is recorded.
const store = <T,>(on: On, key: string, initial: T) => {
  const held = { value: initial, version: 1, writes: [] as T[] }
  on('state.get', { plugin: 'track', key }, () => ({ value: { value: held.value, version: held.version } }))
  on('state.set', { plugin: 'track', key }, (_, e) => {
    held.value = e.value as T
    held.version += 1
    held.writes.push(e.value as T)

    return { value: { isSet: true as const, version: held.version } }
  })

  return held
}

const ledgerOf = (questions: QuestionRow[], nextQuestionId = questions.length + 1) => ({
  v: 1,
  nextQuestionId,
  prompts: [{ rowKey: 'row-1', requestId: 'request-1', turnId: 'turn-1', head: 'a prompt', at: 1000 }],
  questions,
  steps: [],
})

const open = (id: number, turnId: string | null = 'turn-1', status = 'open'): QuestionRow => ({ id, head: `question ${id}`, status, turnId })

// track_question

const track = ($: Parameters<TestBody>[0], input: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__track__track_question', tool_use_id: 'toolu_a', ...input } as never)

const deniedText = (r: unknown): string | undefined => (r as { deny?: string }).deny

test('a subagent cannot track a question and nothing is written', async ($, on) => {
  const ledger = store(on, 'ledger', ledgerOf([], 3))
  const scroll = store(on, 'scroll', { questions: 2, steps: null })

  const r = await track($, { summary: 'is this the user’s question?', agentId: 'agent-1' })

  expect(deniedText(r)).toBeDefined()
  expect(ledger.writes).toHaveLength(0)
  expect(scroll.writes).toHaveLength(0)
})

test('an empty or whitespace summary is denied', async ($, on) => {
  const ledger = store(on, 'ledger', ledgerOf([], 3))
  store(on, 'turn', { currentId: 'turn-1', gatedTurnId: null })

  for (const summary of ['', '   ', '\n  \n', undefined]) {
    const r = await track($, summary === undefined ? {} : { summary })
    expect(deniedText(r)).toBeDefined()
  }
  expect(ledger.writes).toHaveLength(0)
})

test('a tracked question takes the next id, opens, and the result names it and mark_answered', async ($, on) => {
  const ledger = store<LedgerRow>(on, 'ledger', ledgerOf([open(6, 'turn-0', 'answered')], 7))
  store(on, 'turn', { currentId: 'turn-1', gatedTurnId: null })
  store(on, 'scroll', { questions: null, steps: null })

  const r = (await track($, { summary: 'what is the capital of Australia?' })) as { result?: unknown }

  expect(ledger.value.nextQuestionId).toBe(8)
  expect(ledger.value.questions.at(-1)).toMatchObject({ id: 7, status: 'open' })
  const text = String(r.result)
  expect(text).toMatch(/\bQ7\b/)
  expect(text).toContain('mcp__track__mark_answered')
})

test('a tracked question links to the last prompt and to the call that tracked it', async ($, on) => {
  const ledger = store<LedgerRow>(on, 'ledger', ledgerOf([]))
  store(on, 'turn', { currentId: 'turn-1', gatedTurnId: null })
  store(on, 'scroll', { questions: null, steps: null })

  await track($, { summary: 'which row is this?' })

  expect(ledger.value.questions.at(-1)).toMatchObject({ rowKey: 'row-1', askedRequestId: 'request-1', trackedBy: 'toolu_a' })
})

test('a long summary is cut to 200 characters with an ellipsis', async ($, on) => {
  const ledger = store<LedgerRow>(on, 'ledger', ledgerOf([]))
  store(on, 'turn', { currentId: 'turn-1', gatedTurnId: null })
  store(on, 'scroll', { questions: null, steps: null })
  const long = 'x'.repeat(250)

  await track($, { summary: long })

  const head = ledger.value.questions.at(-1)?.head ?? ''
  expect(head).toHaveLength(200)
  expect(head).toBe(`${long.slice(0, 199)}…`)
})

test('only the first line of a multi-line summary is kept', async ($, on) => {
  const ledger = store<LedgerRow>(on, 'ledger', ledgerOf([]))
  store(on, 'turn', { currentId: 'turn-1', gatedTurnId: null })
  store(on, 'scroll', { questions: null, steps: null })

  await track($, { summary: 'the first line\nthe second line' })

  expect(ledger.value.questions.at(-1)?.head).toBe('the first line')
})

test('tracking a question makes the Questions region follow the newest again', async ($, on) => {
  store(on, 'ledger', ledgerOf([]))
  store(on, 'turn', { currentId: 'turn-1', gatedTurnId: null })
  const scroll = store(on, 'scroll', { questions: 4 as number | null, steps: 2 as number | null })

  await track($, { summary: 'scroll back to me?' })

  expect(scroll.value).toEqual({ questions: null, steps: 2 })
})

// The Stop gate

// The test's own classic.Stop hook is the bottom of the chain: it plays the settings hooks.
const stopWith = (on: On, questions: QuestionRow[], below: { block?: string } = {}) => {
  store(on, 'ledger', ledgerOf(questions))
  const turn = store(on, 'turn', { currentId: 'turn-1' as string | null, gatedTurnId: null as string | null })
  on('classic.Stop', () => below)

  return turn
}

const stop = ($: Parameters<TestBody>[0], fields: Record<string, unknown> = {}) =>
  $.classic.Stop({ stop_hook_active: false, ...fields } as never) as Promise<{ block?: string }>

// The ids a block names, in order of first mention.
const idsIn = (block: string | undefined): number[] => [...new Set([...(block ?? '').matchAll(/\bQ(\d+)\b/g)].map(m => Number(m[1])))]

test('a question tracked this turn and still open blocks the stop, naming it and mark_answered', async ($, on) => {
  stopWith(on, [open(4)])

  const r = await stop($)

  expect(r.block).toBeDefined()
  expect(r.block).toMatch(/\bQ4\b/)
  expect(r.block).toContain('mcp__track__mark_answered')
})

test('the gate holds a turn once: a second Stop in the same turn passes', async ($, on) => {
  const turn = stopWith(on, [open(4)])

  const first = await stop($)
  const second = await stop($)

  expect(first.block).toBeDefined()
  expect(turn.value.gatedTurnId).toBe('turn-1')
  expect(second.block).toBeUndefined()
})

test('an open question from an earlier turn does not block', async ($, on) => {
  stopWith(on, [open(4, 'turn-0')])

  expect((await stop($)).block).toBeUndefined()
})

test('an answered or deferred question from this turn does not block', async ($, on) => {
  stopWith(on, [open(4, 'turn-1', 'answered'), open(5, 'turn-1', 'deferred')])

  expect((await stop($)).block).toBeUndefined()
})

test('a block from the hooks below is returned as it is', async ($, on) => {
  const turn = stopWith(on, [open(4)], { block: 'a settings hook blocked' })

  expect((await stop($)).block).toBe('a settings hook blocked')
  expect(turn.writes).toHaveLength(0)
})

test('a Stop raised by a Stop hook does not block', async ($, on) => {
  stopWith(on, [open(4)])

  expect((await stop($, { stop_hook_active: true })).block).toBeUndefined()
})

test('a subagent Stop does not block', async ($, on) => {
  stopWith(on, [open(4)])

  expect((await stop($, { agent_id: 'agent-1' })).block).toBeUndefined()
})

test('with several open questions this turn, the block names the first and lists the others', async ($, on) => {
  // Q1 is open but from an earlier turn, so the block must not list it.
  stopWith(on, [open(1, 'turn-0'), open(2), open(3), open(5)])

  const ids = idsIn((await stop($)).block)

  expect(ids[0]).toBe(2)
  expect([...ids].sort((a, b) => a - b)).toEqual([2, 3, 5])
})
