// FIXTURE: native ToolGroup propagation is represented by mounting a ToolUse
// with the rewritten group's expansion bit. No live ctrl+o gesture is claimed.
import { expect, test } from 'claude-code/testing'
import { atomStore, EMPTY } from './kit'
import type { Ledger, Question } from '../types'

const CALL = 'owned-call'
const FROM = '11111111-2222-4333-8444-555555555555'
const QUESTION: Question = { id: 1, head: 'Target question', at: 1, turnId: 't1', status: 'open' }
const CASES = [
  { tool: 'mcp__track__track_question', input: { summary: 'Target question' }, question: { ...QUESTION, trackedBy: CALL, askedRequestId: CALL }, label: 'Q1. Target question' },
  { tool: 'mcp__track__mark_answered', input: { id: 1, status: 'answered' }, question: { ...QUESTION, status: 'answered', answeredBy: CALL, answerKey: CALL, answerText: 'Saved answer' }, label: '✓ Q1. answered' },
  { tool: 'mcp__track__restore_tracker', input: { from_session: FROM }, question: { ...QUESTION, status: 'answered', restoredBy: CALL, answerText: 'Saved answer' }, label: 'Q1. Target question' },
] satisfies Array<{ tool: string; input: object; question: Question; label: string }>

for (const { tool, input, question, label } of CASES) {
  test(`UI-4 forced group for ${tool} keeps its target label and native details`, async ($, on) => {
    atomStore<Ledger>(on, 'ledger', { ...EMPTY, questions: [question], restores: [{ by: CALL, from: FROM, steps: 0, questions: [question] }] })
    atomStore(on, 'flash', 1)
    let groupExpanded = false
    on('ui.render', { component: 'ToolGroup' }, (_, e) => {
      groupExpanded = e.props.isExpanded
      return { type: 'Text', props: {}, children: ['Native group'] }
    })
    const nativeCalls: unknown[] = []
    on('ui.render', { component: 'ToolUse' }, (_, e) => {
      nativeCalls.push(e.props)
      return { type: 'Text', props: {}, children: ['Native expanded details'] }
    })

    await $.ui.mount({
      plugin: 'track', surface: 'terminal', component: 'ToolGroup', requestId: 'owned-group',
      props: { calls: [{ tool, tool_use_id: CALL, input, isRunning: false, isErrored: false, isInterrupted: false }], isExpanded: false, isActive: false },
    } as never)
    expect(groupExpanded).toBe(true)
    const ui = await $.ui.mount({
      plugin: 'track', surface: 'terminal', component: 'ToolUse', requestId: CALL,
      props: { tool, tool_use_id: CALL, input, isExpanded: groupExpanded, isRunning: false, isErrored: false, isInterrupted: false },
    } as never)

    expect(nativeCalls).toHaveLength(1)
    const texts = (await ui.findAll({ type: 'Text' })).map(row => row.text)
    expect(texts).toContain('Native expanded details')
    expect(texts).toContain(label)
    const highlighted = tool === 'mcp__track__restore_tracker'
      ? await ui.find({ key: `restored-q:${CALL}:1` })
      : await ui.find({ type: 'Text', text: label })
    expect((highlighted?.props as { backgroundColor?: unknown } | undefined)?.backgroundColor).toBeDefined()
  })
}

test('UI-4 clearing an owned target keeps subsequent expanded rows native only', async ($, on) => {
  atomStore<Ledger>(on, 'ledger', { ...EMPTY, questions: [{ ...QUESTION, trackedBy: CALL, askedRequestId: CALL, cleared: true }] })
  on('ui.render', { component: 'ToolUse' }, () => ({ type: 'Text', props: {}, children: ['Native expanded details'] }))
  const ui = await $.ui.mount({
    plugin: 'track', surface: 'terminal', component: 'ToolUse', requestId: CALL,
    props: { tool: 'mcp__track__track_question', tool_use_id: CALL, input: { summary: 'Target question' }, isExpanded: true, isRunning: false, isErrored: false, isInterrupted: false },
  } as never)
  expect((await ui.findAll({ type: 'Text' })).map(row => row.text)).toEqual(['Native expanded details'])
})
