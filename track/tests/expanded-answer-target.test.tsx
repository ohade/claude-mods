// FIXTURE: a saved answer's keyed target must survive expanded native details.
import { expect, test } from 'claude-code/testing'
import { atomStore, EMPTY } from './kit'
import type { Ledger } from '../types'

test('UI-4 an expanded answer owner keeps its saved answer target and native details', async ($, on) => {
  const call = 'answer-owner'
  const answerText = 'Saved answer body'
  atomStore<Ledger>(on, 'ledger', {
    ...EMPTY,
    questions: [{ id: 1, head: 'Target question', at: 1, turnId: 't1', status: 'answered', answeredBy: call, answerKey: call, answerText }],
  })
  atomStore(on, 'flash', 1)
  on('ui.render', { component: 'ToolUse' }, () => ({ type: 'Text', props: {}, children: ['Native expanded details'] }))

  const ui = await $.ui.mount({
    plugin: 'track', surface: 'terminal', component: 'ToolUse', requestId: call,
    props: { tool: 'mcp__track__mark_answered', tool_use_id: call, input: { id: 1, status: 'answered', answer_text: answerText }, isExpanded: true, isRunning: false, isErrored: false, isInterrupted: false },
  } as never)

  const target = await ui.find({ key: `answer:${call}` })
  expect(target).toBeDefined()
  expect(target?.text).toBe(answerText)
  expect((target?.props as { backgroundColor?: unknown } | undefined)?.backgroundColor).toBeDefined()
  const texts = (await ui.findAll({ type: 'Text' })).map(row => row.text)
  expect(texts).toContain('✓ Q1. answered')
  expect(texts).toContain('Native expanded details')
})
