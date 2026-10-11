// FIXTURE, TRACK-21 (2026-10-11): unavailable session identity must not stop
// tracking or let unidentified rows enter a later session's durable ledger.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'

const OTHER = '11111111-2222-4333-8444-555555555555'

for (const kind of ['question', 'step', 'task', 'todo'] as const) test(`${kind} tracking survives unavailable identity and archives unknown ownership on recovery`, async ($, on) => {
  mock.clock(on)
  const memory = atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on)
  logs(on)
  if (kind === 'task') on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '7' } } }))
  if (kind === 'todo') on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { newTodos: [{ content: 'minted without identity', status: 'pending' }] } }))
  const input = kind === 'question' ? { tool: 'mcp__track__track_question', summary: 'minted without identity' }
    : kind === 'step' ? { tool: 'mcp__track__track_steps', steps: ['minted without identity'] }
    : kind === 'task' ? { tool: 'TaskCreate', subject: 'minted without identity', description: 'work' }
    : { tool: 'TodoWrite', todos: [{ content: 'minted without identity', status: 'pending' }] }
  // No session.id implementation: an actual engine capability failure, not a
  // fake empty identifier. The old hook aborts before writing any row.
  await $.tool.call(input as never).catch(() => undefined)
  const rows = kind === 'question' ? memory.value.questions : memory.value.steps
  expect(rows).toHaveLength(1)
  on('session.id', () => ({ value: OTHER }))
  const receipt = JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: OTHER } as never)).result))
  expect(receipt.ok).toBe(true)
  const destination = store.held.get(`s:${OTHER}`) as any
  expect(destination.ledger.questions).toEqual([])
  expect(destination.ledger.steps).toEqual([])
  const archives = [...store.held.entries()].filter(([key]) => key.startsWith(`r:${OTHER}:session-switch-`)).map(([, value]) => value as any)
  expect(archives).toHaveLength(1)
  expect(archives[0].value.source_session).toBe(null)
  const archived = kind === 'question' ? archives[0].value.ledger.questions : archives[0].value.ledger.steps
  expect(archived[0][kind === 'question' ? 'head' : 'subject']).toBe('minted without identity')
})

test('a known ledger owner survives an identity outage before the next save', async ($, on) => {
  const memory = atomStore(on, 'ledger', { ...EMPTY, session_id: SESSION })
  const store = pluginStore(on)
  logs(on)
  await $.tool.call({ tool: 'mcp__track__track_steps', steps: ['belongs to A'] } as never).catch(() => undefined)
  expect(memory.value.steps).toHaveLength(1)
  on('session.id', () => ({ value: OTHER }))
  const receipt = JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: OTHER } as never)).result))
  expect(receipt.ok).toBe(true)
  expect((store.held.get(`s:${OTHER}`) as any).ledger.steps).toEqual([])
  const archive = [...store.held.entries()].find(([key]) => key.startsWith(`r:${OTHER}:session-switch-`))?.[1] as any
  expect(archive.value.source_session).toBe(SESSION)
  expect(archive.value.ledger.steps[0].subject).toBe('belongs to A')
})
