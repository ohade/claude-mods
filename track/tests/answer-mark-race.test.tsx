// FIXTURE: a delayed mark's compare-and-set retry must keep an answer
// acknowledged by another call while that mark was in flight.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

test('a delayed answer mark cannot replace a concurrently acknowledged answer', async ($, on) => {
  const initial = { ...EMPTY, nextQuestionId: 2, questions: [{ id: 1, head: 'Who owns the writer?', at: 1, turnId: 't1', trackedOrder: 1, status: 'open' }] }
  const held = { value: initial as any, version: 1 }
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 1 })
  const store = pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(go => { enter = go })
  const released = new Promise<void>(go => { release = go })
  let blocked = false
  on('state.get', { plugin: 'track', key: 'ledger' }, () => ({ value: { value: held.value, version: held.version } }))
  on('state.set', { plugin: 'track', key: 'ledger' }, async (_, e) => {
    if (!blocked && (e.value as any).questions[0]?.answerText === 'Delayed answer') {
      blocked = true
      enter()
      await released
    }
    if (e.ifVersion !== undefined && e.ifVersion !== held.version) return { value: { isSet: false as const, version: held.version } }
    held.value = e.value
    held.version++
    return { value: { isSet: true as const, version: held.version } }
  })
  const delayed = $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'answered', answer_text: 'Delayed answer', tool_use_id: 'delayed-call' } as never)
  await entered
  const accepted = await $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'answered', answer_text: 'Acknowledged answer', tool_use_id: 'accepted-call' } as never)
  expect(accepted.deny).toBeUndefined()
  const acknowledged = JSON.stringify(held.value.questions[0])
  release()
  await delayed
  expect(JSON.stringify(held.value.questions[0])).toBe(acknowledged)
  expect(held.value.questions[0].answerText).toBe('Acknowledged answer')
  expect(held.value.questions[0].answeredBy).toBe('accepted-call')
  expect((store.held.get(`s:${SESSION}`) as any).ledger.questions[0]).toEqual(held.value.questions[0])
})
