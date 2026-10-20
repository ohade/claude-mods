// FIXTURE: UI-3 historical status rows use their own acknowledged call, while
// refused question updates never claim an answer from proposed input.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger } from '../types'

const MARK = 'mcp__track__mark_step'
const ANSWER = 'mcp__track__mark_answered'
const invoke = ($: Engine, tool: string, input: object) => $.tool.call({ tool, ...input } as never)
const prepare = (on: On) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, nextQuestionId: 2,
    questions: [{ id: 1, head: 'Original question', at: 1, turnId: 'turn-1', status: 'open' }],
    steps: [{ id: 'plan:1', source: 'plan', subject: 'Original work', status: 'pending' }],
  })
  atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on)
  logs(on)
  on('session.id', () => ({ value: SESSION }))
  on('env.get', () => ({ value: undefined }))
  on('env.set', () => ({ value: {} }))
  on('classic.Stop', () => ({}))
  return ledger
}
const sourceRow = (tool: string, id: string | number, status: string, output: unknown, call: string) => ({
  plugin: 'track', surface: 'terminal' as const, component: 'ToolUse' as const, requestId: `${call}-row`,
  props: { tool, tool_use_id: call, input: { id, status }, output, isRunning: false, isErrored: false, isInterrupted: false },
})

test('UI-3 an acknowledged in-progress row keeps its status after completion', async ($, on) => {
  const ledger = prepare(on)
  const receipt = await invoke($, MARK, { id: 'plan:1', status: 'in_progress', tool_use_id: 'started-call' })
  expect(ledger.value.steps[0]?.status).toBe('in_progress')
  await invoke($, MARK, { id: 'plan:1', status: 'completed', tool_use_id: 'finished-call' })
  expect(ledger.value.steps[0]?.status).toBe('completed')
  const source = await $.ui.mount(sourceRow(MARK, 'plan:1', 'in_progress', receipt.result, 'started-call'))
  const text = (await source.findAll({ type: 'Text' })).map(one => one.text ?? '').join('\n')
  expect(text).toContain('◧')
  expect(text).toContain('Original work in progress')
  expect(text).not.toContain('no saved update')
})

test('UI-3 an acknowledged completion without result words survives a reopen', async ($, on) => {
  const ledger = prepare(on)
  const receipt = await invoke($, MARK, { id: 'plan:1', status: 'completed', tool_use_id: 'finished-call' })
  expect(ledger.value.steps[0]?.status).toBe('completed')
  await invoke($, MARK, { id: 'plan:1', status: 'in_progress', tool_use_id: 'reopened-call' })
  expect(ledger.value.steps[0]?.status).toBe('in_progress')
  const source = await $.ui.mount(sourceRow(MARK, 'plan:1', 'completed', receipt.result, 'finished-call'))
  const text = (await source.findAll({ type: 'Text' })).map(one => one.text ?? '').join('\n')
  expect(text).toContain('Original work completed')
  expect(text).not.toContain('no saved update')
})

test('UI-3 an old completion without result words cannot adopt a replacement title', async ($, on) => {
  const ledger = prepare(on)
  const receipt = await invoke($, MARK, { id: 'plan:1', status: 'completed', tool_use_id: 'finished-call' })
  await invoke($, 'mcp__track__track_steps', { steps: ['Replacement work'], replace: true, tool_use_id: 'new-plan-call' })
  await invoke($, MARK, { id: 'plan:1', status: 'completed', tool_use_id: 'replacement-finished-call' })
  expect(ledger.value.steps[0]).toMatchObject({ subject: 'Replacement work', status: 'completed' })
  const source = await $.ui.mount(sourceRow(MARK, 'plan:1', 'completed', receipt.result, 'finished-call'))
  const text = (await source.findAll({ type: 'Text' })).map(one => one.text ?? '').join('\n')
  expect(text).toContain('Original work completed')
  expect(text).not.toContain('Replacement work')
})

test('UI-3 an acknowledged status row remains true after its step is cleared', async ($, on) => {
  const ledger = prepare(on)
  const receipt = await invoke($, MARK, { id: 'plan:1', status: 'in_progress', tool_use_id: 'started-call' })
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'clear-steps' })
  expect(ledger.value.steps).toHaveLength(0)
  const source = await $.ui.mount(sourceRow(MARK, 'plan:1', 'in_progress', receipt.result, 'started-call'))
  const text = (await source.findAll({ type: 'Text' })).map(one => one.text ?? '').join('\n')
  expect(text).toContain('Original work in progress')
  expect(text).not.toContain('no saved update')
})

test('UI-3 a legacy Saved row receipt keeps its original title and status', async ($, on) => {
  prepare(on)
  const receipt = await invoke($, MARK, { id: 'plan:1', status: 'completed', tool_use_id: 'legacy-call' })
  // FIXTURE: retain exactly the acknowledged format already written before UI-3.
  const legacy = String(receipt.result).split('\n').filter(line => !line.startsWith('Step update source: ')).join('\n')
  expect(legacy).toContain('Saved row: ')
  await invoke($, 'mcp__track__track_steps', { steps: ['Replacement work'], replace: true, tool_use_id: 'new-plan-call' })
  const source = await $.ui.mount(sourceRow(MARK, 'plan:1', 'completed', legacy, 'legacy-call'))
  const text = (await source.findAll({ type: 'Text' })).map(one => one.text ?? '').join('\n')
  expect(text).toContain('Original work completed')
  expect(text).not.toContain('Replacement work')
})

test('UI-3 a status receipt cannot approve a different call identity', async ($, on) => {
  prepare(on)
  const receipt = await invoke($, MARK, { id: 'plan:1', status: 'in_progress', tool_use_id: 'started-call' })
  await invoke($, MARK, { id: 'plan:1', status: 'completed', tool_use_id: 'finished-call' })
  const source = await $.ui.mount(sourceRow(MARK, 'plan:1', 'in_progress', receipt.result, 'different-call'))
  const text = (await source.findAll({ type: 'Text' })).map(one => one.text ?? '').join('\n')
  expect(text).not.toContain('◧')
  expect(text).not.toContain('in progress')
})

test('UI-3 refusing an unknown question cannot draw an answered claim', async ($, on) => {
  prepare(on)
  const receipt = await invoke($, ANSWER, { id: 99, status: 'answered', answer_text: 'Not accepted', tool_use_id: 'unknown-call' })
  const source = await $.ui.mount(sourceRow(ANSWER, 99, 'answered', receipt.result, 'unknown-call'))
  const text = (await source.findAll({ type: 'Text' })).map(one => one.text ?? '').join('\n')
  expect(text).not.toContain('✓')
  expect(text).not.toContain('answered')
  expect(text).toContain('99')
})

for (const flag of ['isRunning', 'isErrored', 'isInterrupted'] as const) {
  test(`UI-3 an ${flag} question call cannot borrow a saved answer`, async ($, on) => {
    prepare(on)
    await invoke($, ANSWER, { id: 1, status: 'answered', answer_text: 'Saved answer', tool_use_id: 'accepted-answer' })
    const row = sourceRow(ANSWER, 1, 'answered', undefined, 'later-answer')
    const source = await $.ui.mount({ ...row, props: { ...row.props, [flag]: true } })
    const text = (await source.findAll({ type: 'Text' })).map(one => one.text ?? '').join('\n')
    expect(text).not.toContain('✓')
    expect(text).not.toContain('answered')
  })
}
