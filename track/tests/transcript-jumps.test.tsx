// FIXTURE: 2026-10-08 native A clicks refused transcript Box keys despite visible
// saved bodies. This pins supported requestId dispatch and body-only shading.
// The engine test kit cannot execute transcript scroll; native clicks remain a gate.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, logs, pane } from './kit'

const UUID = '11111111-2222-4333-8444-555555555555'
const ROW = '11111111-2222-4333-8444'
const DRAWN = ROW + '-000000000000'
const question = (extra: object = {}) => ({ id: 1, head: 'Which source?', at: 1, turnId: 't1', status: 'answered', answerText: 'Completed answer תשובה 😀', ...extra })
const answerCall = (id: string) => ({ plugin: 'track', surface: 'terminal', component: 'ToolUse', requestId: id, props: { tool: 'mcp__track__mark_answered', tool_use_id: id, input: { id: 1, status: 'answered' }, isRunning: false, isErrored: false, isInterrupted: false, onScreen: null } })
const moves = (lines: string[]) => lines.filter(line => line.startsWith('track: jump'))

test('a saved call-sourced answer resolves its stable ToolUse host before any render', async ($, on) => {
  mock.clock(on)
  const lines = logs(on)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, questions: [question({ answeredBy: 'answer-call', answerKey: 'answer-call', answerRequestId: 'answer-call' })] })
  const before = JSON.stringify(ledger.value)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  expect(moves(lines)).toEqual(['track: jump {"to":{"requestId":"answer-call"},"block":"start"}'])
  expect(JSON.stringify(ledger.value)).toBe(before)
})

test('a drawn call answer jumps by requestId and shades its body without the acknowledgement', async ($, on) => {
  mock.clock(on)
  const lines = logs(on)
  atomStore(on, 'ledger', { ...EMPTY, questions: [question({ answeredBy: 'answer-call', answerKey: 'answer-call', answerRequestId: 'answer-call' })] })
  const answer = await $.ui.mount(answerCall('answer-call') as never)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  expect(moves(lines)).toEqual(['track: jump {"to":{"requestId":"answer-call"},"block":"start"}'])
  const body = await answer.find({ key: 'answer:answer-call' })
  expect(body?.text).toBe('Completed answer תשובה 😀')
  expect(body?.props.backgroundColor).toBeDefined()
  const acknowledgement = (await answer.findAll({ type: 'Text' })).find(row => row.text === '✓ Q1. answered')
  expect(acknowledgement).toBeDefined()
  expect(acknowledgement?.props.backgroundColor).toBeUndefined()
})

test('a verified assistant answer uses the exact render instance with no transcript key scroll', async ($, on) => {
  mock.clock(on)
  const lines = logs(on)
  atomStore(on, 'ledger', { ...EMPTY, questions: [question({ answeredBy: 'ack-call', answerKey: ROW, answerRequestId: UUID })] })
  on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'Text', props: {}, children: ['Completed answer תשובה 😀'] }))
  const answer = await $.ui.mount({ plugin: 'track', surface: 'terminal', component: 'AssistantMessage', requestId: DRAWN, props: { text: 'Completed answer תשובה 😀', isFirstOfReply: true, onScreen: null } } as never)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  expect(moves(lines)).toEqual([`track: jump {"to":{"requestId":"${DRAWN}"},"block":"start"}`])
  expect((await answer.find({ key: `answer:${ROW}` }))?.props.backgroundColor).toBeDefined()
})

test('an unknown assistant host refuses visibly without scrolling to an acknowledgement or a Box key', async ($, on) => {
  mock.clock(on)
  const lines = logs(on)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, questions: [question({ answeredBy: 'ack-call', answerKey: 'unseen-row', answerRequestId: UUID })] })
  const before = JSON.stringify(ledger.value)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  expect(moves(lines)).toEqual([])
  expect(lines.some(line => line.startsWith('track: cannot jump —'))).toBe(true)
  expect(JSON.stringify(ledger.value)).toBe(before)
})
