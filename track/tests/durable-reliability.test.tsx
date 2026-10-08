// FIXTURE: persistence, source identity and repeat-safe restoration release gates.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'

const OLD = '11111111-2222-4333-8444-555555555555'
const step = (id: string, status = 'pending') => ({ id, subject: id, source: 'plan', status })
const q = (id = 1) => ({ id, head: 'Keep this question', status: 'open', at: 1, turnId: 'old' })
const prepare = (on: any, initial: any = EMPTY, records: Record<string, unknown> = {}, capBytes = 4 * 1024 * 1024) => {
  const l = atomStore(on, 'ledger', initial)
  atomStore(on, 'turn', { currentId: 'new', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  const store = pluginStore(on, records, capBytes)
  on('session.id', () => ({ value: SESSION }))
  on('session.messages', () => ({ value: [] }))
  return { l, store }
}

test('an acknowledged question is durable before turn.complete', async ($, on) => {
  const { store } = prepare(on)
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Durable now', tool_use_id: 'q-new' } as never)
  expect((store.held.get(`s:${SESSION}`) as any)?.ledger.questions[0]?.head).toBe('Durable now')
})

test('unknown question source uses the tracking call, never a previous composer prompt', async ($, on) => {
  const { l } = prepare(on, { ...EMPTY, prompts: [{ head: 'Earlier question', at: 1, turnId: 'old', rowKey: 'earlier', requestId: 'earlier' }] })
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Peer question', tool_use_id: 'actual-position' } as never)
  expect((l.value as any).questions[0].askedRequestId).toBe('actual-position')
  expect((l.value as any).questions[0].rowKey).toBeUndefined()
})

test('a peer model-bound prompt receives the generic instruction when compose was bypassed', async ($, on) => {
  prepare(on)
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  const result = await $.prompt.submit({ text: 'Please answer a substantive question', origin: { kind: 'plugin', name: 'peer' } } as never)
  expect(JSON.stringify(result)).toContain('regardless of sender')
  expect(JSON.stringify(result)).toContain('later content in this turn')
})

test('session.start restores the current saved ledger without classic lifecycle events', async ($, on) => {
  const { l } = prepare(on, EMPTY, { [`s:${SESSION}`]: { v: 1, savedAt: 1, ledger: { ...EMPTY, questions: [q()], steps: [step('plan:1')] } } })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect((l.value as any).questions[0]?.head).toBe('Keep this question')
  expect((l.value as any).steps[0]?.id).toBe('plan:1')
})

test('a failed acknowledged save stays visibly unsaved', async ($, on) => {
  const { l } = prepare(on, EMPTY, {}, 0)
  const lines = logs(on)
  const result = await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Keep it in memory' } as never)
  expect((l.value as any).questions).toHaveLength(1)
  expect(JSON.stringify(result).toLowerCase()).toContain('unsaved')
  expect(lines.some(x => x.toLowerCase().includes('unsaved') && x.includes('4 MiB'))).toBe(true)
})

test('question capacity refuses new work instead of dropping an unfinished question', async ($, on) => {
  const before = { ...EMPTY, nextQuestionId: 201, questions: Array.from({ length: 200 }, (_, i) => q(i + 1)) }
  const { l } = prepare(on, before)
  const result = await $.tool.call({ tool: 'mcp__track__track_question', summary: 'One too many' } as never)
  expect((l.value as any).questions).toEqual(before.questions)
  expect(result.deny).toContain('capacity')
})

test('save budget never deletes another session with unfinished work', async ($, on) => {
  const records: Record<string, unknown> = {}
  for (let i = 0; i < 21; i++) records[`s:unfinished-${i}`] = { v: 1, savedAt: i, ledger: { ...EMPTY, questions: [q()] } }
  const { store } = prepare(on, EMPTY, records)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.turn.complete({ answer: 'done', reason: 'answer', turnId: 'new', durationMs: 1, isAborted: false } as never)
  for (let i = 0; i < 21; i++) expect(store.held.has(`s:unfinished-${i}`)).toBe(true)
})

test('repeated restore preserves local ids and status updates, including after clearing displayed rows', async ($, on) => {
  const { l } = prepare(on, EMPTY, { [`s:${OLD}`]: { v: 1, savedAt: 1, ledger: { ...EMPTY, questions: [q()], steps: [step('plan:1')] } } })
  await $.tool.call({ tool: 'mcp__track__restore_tracker', from_session: OLD, tool_use_id: 'restore-a' } as never)
  const first = (l.value as any).questions[0]?.id
  await $.tool.call({ tool: 'mcp__track__mark_answered', id: first, status: 'deferred', note: 'Peer is running' } as never)
  const result = await $.tool.call({ tool: 'mcp__track__restore_tracker', from_session: OLD, tool_use_id: 'restore-b' } as never)
  expect(result.deny).toBeUndefined()
  expect((l.value as any).questions).toHaveLength(1)
  expect((l.value as any).questions[0]?.id).toBe(first)
  expect((l.value as any).questions[0]?.status).toBe('deferred')
  const by = (l.value as any).restores
  l.value = { ...(l.value as any), questions: [], steps: [], restores: by }
  const again = await $.tool.call({ tool: 'mcp__track__restore_tracker', from_session: OLD, tool_use_id: 'restore-c' } as never)
  expect(again.deny).toBeUndefined()
  expect((l.value as any).questions[0]?.id).toBe(first)
})

test('a restored question answered on the next turn keeps the new answer text', async ($, on) => {
  const { l } = prepare(on, { ...EMPTY, nextQuestionId: 2, questions: [{ ...q(), turnId: 'restored', restoredFrom: OLD }] })
  on('session.append', (_, e, next) => next(e))
  await $.session.append({ door: 'response', uuid: 'aaaaaaaa-bbbb-cccc-dddd-111111111111', message: { role: 'assistant', content: [{ type: 'text', text: 'תשובה 😀' }] }, origin: { kind: 'agent' } } as never)
  await $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'answered' } as never)
  expect((l.value as any).questions[0]?.answerText).toBe('תשובה 😀')
})

test('Unicode summaries never split a surrogate pair at the size boundary', async ($, on) => {
  const { l } = prepare(on)
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'a'.repeat(198) + '😀😀' } as never)
  expect((l.value as any).questions[0].head).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u)
})
