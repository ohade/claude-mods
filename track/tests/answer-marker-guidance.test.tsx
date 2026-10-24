// FIXTURE: 2026-10-12 generic reminders still requested a second tool answer.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore, logs } from './kit'
import type { On } from './kit'

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
  return observed
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

test('the Stop repair for a tracked open question prefers one marker answer', async ($, on) => {
  prepare(on)
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Open question', tool_use_id: 'ask-guidance' } as never)
  const stopped = await $.classic.Stop({ stop_hook_active: false } as never)
  expectMarkers(stopped.block ?? '')
})

test('the Stop repair for an uncovered question uses the same answer path', async ($, on) => {
  prepare(on)
  await $.prompt.submit({ text: 'Why is this duplicated?', origin: { kind: 'composer' } } as never)
  const stopped = await $.classic.Stop({ stop_hook_active: false } as never)
  expectMarkers(stopped.block ?? '')
})
