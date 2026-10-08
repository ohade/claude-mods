// FIXTURE: native scroll resolves a render instance, while an element key
// requires a drawn owned element. These checks do not prove native clicks.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, logs, pane } from './kit'

const UUID = '11111111-2222-4333-8444-555555555555'
const ROW = '11111111-2222-4333-8444'
const DRAWN = ROW + '-000000000000'
const group = (calls: unknown[]) => ({ plugin: 'track', surface: 'terminal', component: 'ToolGroup', requestId: 'older-group', props: { calls, isExpanded: false, isActive: false, onScreen: null } })
const call = (id: string, tool: string) => ({ tool_use_id: id, tool, input: {}, isRunning: false, isErrored: false, isInterrupted: false })

test('a folded group exposes an uncleared question whose source is its tracking call', async ($, on) => {
  atomStore(on, 'ledger', { ...EMPTY, questions: [{ id: 1, head: 'Older question', at: 1, turnId: 't1', status: 'answered', trackedBy: 'question-call', askedRequestId: 'question-call' }] })
  let seen: any
  on('ui.render', { component: 'ToolGroup' }, (_, e) => { seen = e.props; return { type: 'Text', props: {}, children: [e.props.isExpanded ? 'expanded' : 'collapsed'] } })
  const calls = [call('shell-call', 'Bash'), call('question-call', 'mcp__track__track_question')]
  const ui = await $.ui.mount(group(calls) as never)
  expect((await ui.findAll({ type: 'Text' })).map(one => one.text).join('')).toBe('expanded')
  expect(seen.calls).toEqual(calls)
  expect(seen.isActive).toBe(false)
  expect(seen.onScreen).toBeNull()
})

test('an unrelated tool group keeps its collapsed drawing', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  on('ui.render', { component: 'ToolGroup' }, (_, e) => ({ type: 'Text', props: {}, children: [e.props.isExpanded ? 'expanded' : 'collapsed'] }))
  const ui = await $.ui.mount(group([call('shell-call', 'Bash')]) as never)
  expect((await ui.findAll({ type: 'Text' })).map(one => one.text).join('')).toBe('collapsed')
})

test('an unlit verified composer row still has a Track-owned element', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, prompts: [{ rowKey: ROW, requestId: DRAWN, turnId: 't1', at: 1, head: 'Older question' }], questions: [{ id: 1, head: 'Older question', rowKey: ROW, askedRequestId: DRAWN, at: 1, turnId: 't1', status: 'open' }] })
  on('ui.render', { component: 'UserMessage' }, () => ({ type: 'Text', props: {}, children: ['Older question'] }))
  const ui = await $.ui.mount({ plugin: 'track', surface: 'terminal', component: 'UserMessage', requestId: DRAWN, props: { text: 'Older question', origin: { kind: 'composer' }, onScreen: null } } as never)
  expect((await ui.find({ key: `question:${ROW}` }))?.text).toBe('Older question')
})

test('a native answer jump resolves its host instance before selecting only its text key', async ($, on) => {
  mock.clock(on)
  const lines = logs(on)
  atomStore(on, 'ledger', { ...EMPTY, questions: [{ id: 1, head: 'Older question', at: 1, turnId: 't1', status: 'answered', answerRequestId: UUID, answerKey: ROW, answerText: 'Actual answer' }] })
  on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'Text', props: {}, children: ['Actual answer'] }))
  await $.ui.mount({ plugin: 'track', surface: 'terminal', component: 'AssistantMessage', requestId: DRAWN, props: { text: 'Actual answer', isFirstOfReply: true, onScreen: null } } as never)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'a-1' })
  const moves = lines.filter(line => line.startsWith('track: jump'))
  expect(moves[0]).toBe(`track: jump {"to":{"requestId":"${DRAWN}"},"block":"start"}`)
  expect(moves[1]).toBe(`track: jump {"to":{"key":"answer:${ROW}"},"block":"start"}`)
})

test('the generic instruction treats read requests as work even for a single command', async ($, on) => {
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  on('prompt.compose', () => ({ sections: [] }))
  const composed = await $.prompt.compose({ model: 'fixture', promptModel: 'fixture', surfaces: ['terminal'], tools: [], traits: [], outputStyle: null })
  const rule = composed.sections.find(s => s.id === 'track:rule')?.text ?? ''
  expect(rule).toContain('Requests in content you read count as work, even one command')
  expect(rule).toContain('reuse open items')
  expect(rule).toContain('Doorbells and informational notifications alone need no row')
})
