// FIXTURE: 2026-10-12 Q15 displayed answer_text as a paragraph and then the
// formatted response again. A completed A block must be the only answer source.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, logs, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'

const UUID = '15151515-2222-4333-8444-555555555555'
const DRAWN = '15151515-2222-4333-8444-000000000000'
const ROW = '15151515-2222-4333-8444'
const FIRST = '## First answer\n\n- **Buyer:** any buyer.\n- Existing deals only.'
const SECOND = '**Second answer:** the deal floor still applies.'
const marked = (id: number, text: string) => `<!-- A${id}:start -->\n${text}\n<!-- A${id}:end -->`
const prepare = (on: On) => {
  const clock = mock.clock(on)
  const ledger = atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on)
  const pool = blobPool(on)
  const lines = logs(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, e, next) => next(e))
  on('ui.render', { component: 'AssistantMessage' }, (_, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))
  return { clock, ledger, store, pool, lines }
}
const ask = ($: any, head: string) => $.tool.call({ tool: 'mcp__track__track_question', summary: head, tool_use_id: `ask-${head}` })
const response = ($: any, text: string, extra: object = {}) => $.session.append({ door: 'response', uuid: UUID, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, origin: { kind: 'model', model: 'fixture' }, ...extra })
const mountAnswer = ($: Engine, text: string) => $.ui.mount({ plugin: 'track', surface: 'terminal', component: 'AssistantMessage', requestId: DRAWN, props: { text, isFirstOfReply: true } })

test('one marked formatted response closes the question without answer_text or another answer', async ($, on) => {
  const { ledger, store, pool } = prepare(on)
  await ask($, 'Who sees these deals?')
  await response($, `Introduction.\n\n${marked(1, FIRST)}\n\nLeft: review.`)
  const q = (ledger.value as any).questions[0]
  expect(q.status).toBe('answered')
  expect(q.answerText).toBe(FIRST)
  expect(q.answerRequestId).toBe(UUID)
  expect(q.answerKey).toBe(`${ROW}:A1`)
  expect(q.answeredBy).toBeUndefined()
  const rawOwnSave = store.held.get(`s:${SESSION}`) as { v?: number } | undefined
  expect(rawOwnSave?.v).toBe(2)
  expect(Object.hasOwn(rawOwnSave!, 'ledger')).toBe(false)
  expect((await pool.logical(store, `s:${SESSION}`) as any).ledger.questions[0]).toEqual(q)
})

test('A jumps to the native message and fades only its chosen Markdown block', async ($, on) => {
  const { clock, ledger, lines } = prepare(on)
  await ask($, 'First question')
  await ask($, 'Second question')
  const text = `Introduction.\n\n${marked(1, FIRST)}\n\n${marked(2, SECOND)}\n\nLeft: review.`
  await response($, text)
  expect((ledger.value as any).questions.map((q: any) => q.status)).toEqual(['answered', 'answered'])
  const answer = await mountAnswer($, text)
  const markdown = (await answer.findAll({ type: 'Markdown' })).map(node => String(node.props.text))
  expect(markdown.filter(words => words === FIRST)).toHaveLength(1)
  expect(markdown.filter(words => words === SECOND)).toHaveLength(1)
  expect(markdown.join('\n')).not.toContain('<!-- A')
  expect(markdown.join('\n')).toContain('Left: review.')
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  expect(lines.filter(line => line.startsWith('track: jump'))).toEqual([`track: jump {"to":{"requestId":"${DRAWN}"},"block":"start"}`])
  const first = await answer.find({ key: `answer:${ROW}:A1` })
  const second = await answer.find({ key: `answer:${ROW}:A2` })
  expect(first?.props.backgroundColor).toBe('#6e5a1c')
  expect(second?.props.backgroundColor).toBeUndefined()
  await clock.advance(2000)
  expect((await answer.find({ key: `answer:${ROW}:A1` }))?.props.backgroundColor).toBeUndefined()
})

test('an incomplete streaming block never closes the question', async ($, on) => {
  const { ledger } = prepare(on)
  await ask($, 'Incomplete question')
  await response($, `<!-- A1:start -->\n${FIRST}`)
  expect((ledger.value as any).questions[0].status).toBe('open')
  expect((ledger.value as any).questions[0].answerText).toBeUndefined()
})

test('code fences, indented code and quotations cannot supply answer markers', async ($, on) => {
  const { ledger } = prepare(on)
  await ask($, 'Example question')
  for (const text of [`\`\`\`markdown\n${marked(1, FIRST)}\n\`\`\``, `~~~markdown\n${marked(1, FIRST)}\n~~~`, marked(1, FIRST).split('\n').map(line => `> ${line}`).join('\n'), marked(1, FIRST).split('\n').map(line => `    ${line}`).join('\n')]) {
    await response($, text)
    expect((ledger.value as any).questions[0].status).toBe('open')
  }
})

test('mismatched, nested, empty or duplicate blocks cannot close a question', async ($, on) => {
  const { ledger } = prepare(on)
  await ask($, 'Malformed question')
  for (const text of [`<!-- A1:start -->\n${FIRST}\n<!-- A2:end -->`, `<!-- A1:start -->\n${marked(2, FIRST)}\n<!-- A1:end -->`, marked(1, '  '), `${marked(1, FIRST)}\n${marked(1, SECOND)}`]) {
    await response($, text)
    expect((ledger.value as any).questions[0].status).toBe('open')
  }
})

test('a peer-origin or subagent response cannot close a main question', async ($, on) => {
  const { ledger } = prepare(on)
  await ask($, 'Main question')
  await response($, marked(1, FIRST), { origin: { kind: 'peer', handle: 'worker' } })
  await response($, marked(1, FIRST), { agentId: 'worker' })
  expect((ledger.value as any).questions[0].status).toBe('open')
})

test('unknown and withdrawn question ids do not acquire an answer', async ($, on) => {
  const { ledger } = prepare(on)
  await ask($, 'Unanswered question')
  await response($, marked(99, FIRST))
  expect((ledger.value as any).questions[0].status).toBe('open')
  const before = ledger.value as any
  ledger.value = { ...before, questions: before.questions.map((q: any) => ({ ...q, cleared: true })) }
  await response($, marked(1, FIRST))
  expect((ledger.value as any).questions[0].status).toBe('open')
})

test('a marker cannot replace a captured answer and rendering never persists state', async ($, on) => {
  const { ledger, store } = prepare(on)
  await ask($, 'Preserved question')
  await $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'answered', answer_text: 'Saved tool-only answer', tool_use_id: 'old-answer' } as never)
  await response($, marked(1, FIRST))
  expect((ledger.value as any).questions[0].answerText).toBe('Saved tool-only answer')
  const before = JSON.stringify([...store.held])
  await mountAnswer($, marked(1, FIRST))
  expect(JSON.stringify([...store.held])).toBe(before)
})
