// FIXTURE: 2026-10-08 A landed on Q1 answered instead of the answer.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'

const UUID = '11111111-2222-4333-8444-555555555555'
const DRAWN = '11111111-2222-4333-8444-000000000000'
const KEY = '11111111-2222-4333-8444'

test('answer-before-mark links and highlights only the real answer row', async ($, on) => {
  const clock = mock.clock(on)
  const ledger = atomStore(on, 'ledger', EMPTY as any)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, e, next) => next(e))
  on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'Text', props: {}, children: ['Actual answer 😀'] }))
  const logs: string[] = []
  const lit: string[] = []
  on('ui.log', (_, e) => { logs.push(e.text); return { value: undefined } })
  on('state.set', { plugin: 'track', key: 'flash' }, (_, e) => {
    if (Number(e.value) > 0) lit.push(String(e.id))
    return { value: { isSet: true as const, version: 2 } }
  })
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'The question', tool_use_id: 'toolu_question' } as never)
  await $.session.append({ door: 'response', uuid: UUID, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Actual answer 😀' }] }, origin: { kind: 'model', model: 'fixture' } } as never)
  await $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'answered', tool_use_id: 'toolu_ack' } as never)
  expect(ledger.value.questions[0].answerRequestId).toBe(UUID)
  expect(ledger.value.questions[0].answeredBy).toBe('toolu_ack')
  const answer = await $.ui.mount({ plugin: 'track', surface: 'terminal', component: 'AssistantMessage', requestId: DRAWN, props: { text: 'Actual answer 😀', isFirstOfReply: true } } as never)
  await clock.advance(0)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  expect(logs).toContain(`track: jump {"to":{"key":"answer:${KEY}"},"block":"start"}`)
  expect(lit).toContain(KEY)
  expect(lit).not.toContain('toolu_ack')
  await answer.unmount()
})

test('an older saved answer prefers its text key over an acknowledgement target', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 2, questions: [{ id: 1, head: 'Legacy question', at: 1, turnId: 'old', status: 'answered', answerRequestId: 'toolu_ack', answerKey: KEY, answerText: 'The saved answer' }] })
  const logs: string[] = []
  on('ui.log', (_, e) => { logs.push(e.text); return { value: undefined } })
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  expect(logs).toContain(`track: jump {"to":{"key":"answer:${KEY}"},"block":"start"}`)
  expect(logs.join('\n')).not.toContain('toolu_ack')
})
