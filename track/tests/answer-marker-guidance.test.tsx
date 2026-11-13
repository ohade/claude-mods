// FIXTURE: 2026-10-12 generic reminders still requested a second tool answer.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore, logs } from './kit'
import type { Engine, On } from './kit'

const prepare = (on: On) => {
  mock.clock(on)
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/fixture/config' })
  pluginStore(on)
  logs(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.messages', () => ({ value: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'ask-guidance', tool: 'mcp__track__track_question', input: { summary: 'Open question' } }] }] }))
  on('prompt.compose', () => ({ sections: [] }))
  const observed = { context: [] as readonly string[] }
  on('prompt.submit', (_, e) => { observed.context = e.context ?? []; return { text: e.text } })
  on('classic.Stop', () => ({}))
  watchGate(on)
  return observed
}
// TRACK-46 unit 3 step C: stop-gate.py, the command hook, is the only Stop decider. A case that
// pinned the module's own block now pins the input rows the module publishes for the hook, and
// that the module itself returns no block; tests/helpers/test_stop_inputs.py covers the hook's block.
const gates = new WeakMap<On, { text: string }>()
const watchGate = (on: On) => {
  const gate = { text: '{}' }
  gates.set(on, gate)
  on('env.set', { name: /^TRACK_GATE_SNAPSHOT$/ }, (_, e) => { gate.text = String(e.value); return { value: {} } })
}
const gateReasons = async ($: Engine, on: On, fields: Record<string, unknown> = {}) => {
  expect((await $.classic.Stop({ stop_hook_active: false, ...fields } as never)).block).toBeUndefined()
  return (JSON.parse(gates.get(on)?.text ?? '{}') as { inputs?: Array<{ reason: string }> }).inputs?.map(row => row.reason)
}
const expectMarkers = (text: string) => {
  expect(text).toContain('<!-- A')
  expect(text).toContain(':start -->')
  expect(text).toContain(':end -->')
  expect(text).toContain('Do not also send answer_text')
  expect(text).toContain('For a tool/file-only answer')
  expect(text).not.toContain('answer it, then mcp__track__mark_answered')
}

test('the later-turn open reminder prefers one formatted marker answer', async ($, on) => {
  const observed = prepare(on)
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Open question', tool_use_id: 'ask-guidance' } as never)
  await $.prompt.compose({ model: 'fixture', promptModel: 'fixture', surfaces: ['terminal'], tools: [], traits: [], outputStyle: null })
  await $.prompt.submit({ text: 'Continue.', origin: { kind: 'composer' } } as never)
  expectMarkers(observed.context.join('\n'))
})

test('a tracked open question is published as the one open row the Stop marker repair is built from', async ($, on) => {
  prepare(on)
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Open question', tool_use_id: 'ask-guidance' } as never)
  await gateReasons($, on)
  // The hook builds the marker repair from this row: test_stop_gate.py::test_open_question_reason_equals_module_and_lists_the_others.
  expect((JSON.parse(gates.get(on)?.text ?? '{}') as { open?: unknown }).open).toEqual([{ id: 1, head: 'Open question' }])
})

test('the Stop repair for an uncovered question uses the same answer path', async ($, on) => {
  prepare(on)
  await $.prompt.submit({ text: 'Why is this duplicated?', origin: { kind: 'composer' } } as never)
  const [reason = ''] = await gateReasons($, on) ?? []
  expectMarkers(reason)
})
