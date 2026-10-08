// FIXTURE: two overlapping responses cannot mix one message's text with the
// other message's transcript id. The answer remains the first eligible text.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

test('an overlapping response keeps its own text and acknowledged message identity', async ($, on) => {
  const l = atomStore(on, 'ledger', EMPTY)
  const store = pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, e, next) => next(e))
  const held = { value: { currentId: 't1', gatedTurnId: null, eventOrder: 0 } as any, version: 1 }
  let enterFirst!: () => void
  let releaseFirst!: () => void
  const firstEntered = new Promise<void>(go => { enterFirst = go })
  const firstHeld = new Promise<void>(go => { releaseFirst = go })
  on('state.get', { plugin: 'track', key: 'turn' }, () => ({ value: { value: held.value, version: held.version } }))
  on('state.set', { plugin: 'track', key: 'turn' }, async (_, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== held.version) return { value: { isSet: false as const, version: held.version } }
    held.value = e.value
    held.version++
    if (held.value.lastText?.text === 'First actual answer') { enterFirst(); await firstHeld }
    return { value: { isSet: true as const, version: held.version } }
  })
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'A question', tool_use_id: 'question-call' } as never)
  await $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'answered', answer_text: 'First actual answer', tool_use_id: 'mark-call' } as never)
  const response = (uuid: string, text: string) => $.session.append({ door: 'response', uuid, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, origin: { kind: 'model', model: 'fixture' } } as never)
  const first = response('11111111-2222-4333-8444-555555555555', 'First actual answer')
  await firstEntered
  // Simulate a competing writer advancing the turn atom after the first
  // response committed its observation but before that update returns.
  held.value = { ...held.value, eventOrder: held.value.eventOrder + 1, lastText: { row: '66666666-7777-4888-8999', requestId: '66666666-7777-4888-8999-aaaaaaaaaaaa', turnId: 't1', order: held.value.eventOrder + 1, text: 'Second unrelated response' } }
  held.version++
  releaseFirst()
  await first
  const q = (l.value as any).questions[0]
  expect(q.answerText).toBe('First actual answer')
  expect(q.answerRequestId).toBe('11111111-2222-4333-8444-555555555555')
  expect((store.held.get(`s:${SESSION}`) as any).ledger.questions[0]).toEqual(q)
})
