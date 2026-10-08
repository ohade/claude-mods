// FIXTURE: refusing an unidentified answer is useful only if every model-bound
// instruction and the registered tool tell Claude how to supply a completed one.
import { expect, test } from 'claude-code/testing'
import { EMPTY, atomStore } from './kit'

test('the registered answer tool exposes completed answer content', async ($, on) => {
  let described: any
  on('tool.register', (_, e) => {
    if (e.name === 'mark_answered') described = e
    return { value: { tool: `mcp__track__${e.name}` } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ deny: 'no panes here' }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(described.description).toContain('completed answer')
  expect(described.description).toContain('answer_text')
  expect(described.description).toContain('Progress updates are not answers')
  expect(described.inputSchema.properties.answer_text.type).toBe('string')
})

test('both composed rule and per-turn reminder request completed answer_text', async ($, on) => {
  atomStore(on, 'ledger', { ...EMPTY, questions: [{ id: 1, head: 'A question', at: 1, turnId: 't1', status: 'open' }] })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  on('prompt.compose', () => ({ sections: [] }))
  let context: readonly string[] = []
  on('prompt.submit', (_, e) => { context = e.context ?? []; return { text: e.text } })
  const composed = await $.prompt.compose({ model: 'fixture', promptModel: 'fixture', surfaces: ['terminal'], tools: [], traits: [], outputStyle: null })
  expect(composed.sections.find(s => s.id === 'track:rule')?.text).toContain('completed answer as answer_text')
  await $.prompt.submit({ text: 'A follow-up', origin: { kind: 'composer' } } as never)
  // The composed rule already reached the model, so this must be the open-item
  // reminder, rather than the fallback copy of the standing rule.
  expect(context).toHaveLength(1)
  expect(context[0]).toContain('completed answer_text')
})

test('a prompt whose composition was bypassed still requests completed answer_text', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  let context: readonly string[] = []
  on('prompt.submit', (_, e) => { context = e.context ?? []; return { text: e.text } })
  await $.prompt.submit({ text: 'Content from any sender', origin: { kind: 'plugin', name: 'fixture' } } as never)
  expect(context.join('\n')).toContain('completed answer as answer_text')
})
