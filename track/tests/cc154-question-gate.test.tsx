// FIXTURE: a question-like prompt with no Track call blocks Stop once.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, SESSION } from './kit'
import type { Engine, On } from './kit'

const blockFor = (excerpt: string) =>
  `track: a prompt looks like a question ("${excerpt}") but no Track row was written for it. Call mcp__track__track_question with source_text = its first line, Write the formatted answer once between standalone <!-- A{id}:start --> and <!-- A{id}:end --> lines, using its stable numeric id; Track captures it automatically. Do not also send answer_text. For a tool/file-only answer, call mcp__track__mark_answered with the completed answer_text; for a request instead, reuse a matching open step with mcp__track__mark_step, keeping its current status and the same source_text. For new work, call mcp__track__track_steps with the same source_text; use after when steps already exist so their rows and statuses are kept. Then finish.`

const prepare = (on: Parameters<typeof atomStore>[0]) => {
  mock.clock(on)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 1 })
  const turn = atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('classic.Stop', () => ({}))
  watchGate(on)
  on('command.list', () => ({ value: [{ name: 'compact', description: 'compact', source: 'builtin' as const }] }))
  return { ledger, turn }
}

const ask = ($: { prompt: { submit: (e: never) => Promise<unknown> } }, text: string, origin?: { kind: string }) =>
  $.prompt.submit({ text, ...(origin !== undefined && { origin }) } as never)

const stop = ($: { classic: { Stop: (e: never) => Promise<{ block?: string }> } }) =>
  $.classic.Stop({ stop_hook_active: false } as never)
// TRACK-46 unit 3 step C: stop-gate.py, the command hook, is the only Stop decider. A case that
// pinned the module's own block now pins the input rows the module publishes for the hook, and
// that the module itself returns no block; tests/helpers/test_stop_inputs.py covers the hook's block.
const gates = new WeakMap<On, { text: string }>()
const watchGate = (on: On) => {
  const gate = { text: '{}' }
  gates.set(on, gate)
  // publishGate stamps the snapshot with the session id; this fixture had none.
  on('session.id', () => ({ value: SESSION }))
  on('env.set', { name: /^TRACK_GATE_SNAPSHOT$/ }, (_, e) => { gate.text = String(e.value); return { value: {} } })
}
const gateReasons = async ($: Engine, on: On, fields: Record<string, unknown> = {}) => {
  expect((await $.classic.Stop({ stop_hook_active: false, ...fields } as never)).block).toBeUndefined()
  return (JSON.parse(gates.get(on)?.text ?? '{}') as { inputs?: Array<{ reason: string }> }).inputs?.map(row => row.reason)
}

test('ok, u on it? with no Track call blocks Stop once', async ($, on) => {
  prepare(on)
  await ask($, 'ok, u on it?', { kind: 'composer' })
  expect(await gateReasons($, on)).toEqual([blockFor('ok, u on it?')])
  const second = await stop($)
  expect(second.block).toBeUndefined()
})

test('a question word without a question mark blocks Stop', async ($, on) => {
  prepare(on)
  await ask($, 'why does it take so long', { kind: 'composer' })
  expect(await gateReasons($, on)).toEqual([blockFor('why does it take so long')])
})

test('the block quotes only the first 80 characters', async ($, on) => {
  prepare(on)
  const text = `${'what '.repeat(30)}?`
  await ask($, text, { kind: 'composer' })
  const excerpt = text.trim().slice(0, 80)
  expect(await gateReasons($, on)).toEqual([blockFor(excerpt)])
})

test('the same prompt with track_question and mark_answered does not block', async ($, on) => {
  const { ledger } = prepare(on)
  await ask($, 'ok, u on it?', { kind: 'composer' })
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'ok, u on it?', tool_use_id: 'toolu_q' } as never)
  const id = (ledger.value as { questions: Array<{ id: number }> }).questions.at(-1)?.id
  await $.tool.call({ tool: 'mcp__track__mark_answered', id, status: 'answered', answer_text: 'On it.', tool_use_id: 'toolu_a' } as never)
  expect((await stop($)).block).toBeUndefined()
})

test('a request without a question mark or a question word does not block', async ($, on) => {
  prepare(on)
  await ask($, 'send it now', { kind: 'composer' })
  expect((await stop($)).block).toBeUndefined()
})

test('an AMQ doorbell, a bash input and a slash command do not block', async ($, on) => {
  prepare(on)
  for (const text of [': AMQ doorbell run amq drain?', '<bash-input>echo hi?', '/compact now?']) {
    await ask($, text, { kind: 'composer' })
    expect((await stop($)).block).toBeUndefined()
  }
})

test('a task notification does not block', async ($, on) => {
  prepare(on)
  await ask($, '<task-notification><task-id>ag1</task-id></task-notification> why?', { kind: 'task-notification' })
  expect((await stop($)).block).toBeUndefined()
})

// A subagent hand-back reaches the prompt door under the peer origin, in the shape Claude Code
// delivers it. It is model output, not the person's question, so it never blocks Stop.
test('a subagent hand-back does not block', async ($, on) => {
  prepare(on)
  const handback = 'Another Claude session sent a message:\n<agent-message from="a1">\n[Subagent hand-back] Did the build pass? Yes.\n</agent-message>'
  await ask($, handback, { kind: 'peer' })
  expect((await stop($)).block).toBeUndefined()
})
