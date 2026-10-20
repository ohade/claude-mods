// FIXTURE: stable marker IDs and source/order guards must not depend on ordinals.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { On } from './kit'

const UUID = '25252525-2222-4333-8444-555555555555'
const BODY = '**Answer:** one formatted response.'
const TEXT = `<!-- A25:start -->\n${BODY}\n<!-- A25:end -->\n\nLeft: review.`
const prepare = (on: On) => {
  const ledger = atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 25 })
  const turn = atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.append', (_, e, next) => next(e))
  on('ui.render', { component: 'AssistantMessage' }, (_, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))
  return { ledger, turn }
}
const ask = ($: any) => $.tool.call({ tool: 'mcp__track__track_question', summary: 'Stable id question', tool_use_id: 'ask-25' })
const response = ($: any, origin: object = { kind: 'model', model: 'fixture' }) => $.session.append({ door: 'response', uuid: UUID, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: TEXT }] }, origin })

test('A25 binds stable id 25 while its visible acknowledgement uses Q1', async ($, on) => {
  const { ledger } = prepare(on)
  await ask($)
  await response($)
  expect((ledger.value as any).questions[0]).toMatchObject({ id: 25, status: 'answered', answerText: BODY })
  const ui = await $.ui.mount({ plugin: 'track', surface: 'terminal', component: 'AssistantMessage', requestId: UUID, props: { text: TEXT } })
  expect((await ui.findAll({ type: 'Text' })).map(node => node.children.join('')).join('\n')).toContain('Q1. answered')
})

test('a same-turn marker written before the question cannot supply its answer', async ($, on) => {
  const { ledger } = prepare(on)
  await response($)
  await ask($)
  expect((ledger.value as any).questions[0].status).toBe('open')
})

test('a later-turn marker can answer an older open question', async ($, on) => {
  const { ledger, turn } = prepare(on)
  await ask($)
  turn.value = { ...turn.value, currentId: 't2' }
  await response($)
  expect((ledger.value as any).questions[0].status).toBe('answered')
})

test('plugin and composer-origin text cannot answer a main question', async ($, on) => {
  const { ledger } = prepare(on)
  await ask($)
  for (const origin of [{ kind: 'plugin', name: 'fixture' }, { kind: 'composer' }]) {
    await response($, origin)
    expect((ledger.value as any).questions[0].status).toBe('open')
  }
})
