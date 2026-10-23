// FIXTURE: TRACK-29 (2026-10-19). Stored row identities and values must survive
// reordering, reload and handoff; a display label alone cannot identify a row.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger } from '../types'

const OLD = '11111111-2222-4333-8444-555555555555'
const LOOKUP = 'mcp__track__lookup_rows'
const REORDER = 'mcp__track__reorder_steps'
const prepare = (on: On) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, session_id: OLD,
    steps: [
      { session_id: OLD, id: 'plan:1', source: 'plan', subject: 'Cleared history', status: 'completed', cleared: true },
      { session_id: OLD, id: 'plan:2', source: 'plan', subject: 'Wait for peer', status: 'in_progress', delegated: true, note: 'Peer owns this', startedAt: 10 },
      { session_id: OLD, id: 'plan:3', source: 'plan', subject: 'Run first', status: 'pending', note: 'Keep this note' },
    ], questions: [{ session_id: OLD, id: 7, head: 'Current question', at: 2, turnId: 'old', status: 'open' }], nextQuestionId: 8,
  })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  const store = pluginStore(on)
  const pool = blobPool(on)
  logs(on)
  let session = OLD
  on('session.id', () => ({ value: session }))
  on('tool.call', { tool: /mcp__track__(lookup_rows|reorder_steps)$/ }, () => ({ result: '{}' }))
  on('classic.SessionStart', () => ({}))
  return { ledger, store, pool, setSession: (id: string) => { session = id } }
}
const invoke = ($: Engine, tool: string, input: object = {}) => $.tool.call({ tool, tool_use_id: `${tool}-call`, ...input } as never)
const receipt = (result: { result?: unknown }) => JSON.parse(typeof result.result === 'string' ? result.result : '{}')
const order = (ledger: Ledger) => ledger.steps.filter(step => step.cleared !== true).map(step => step.id)

test('TRACK-29 lookup resolves mentioned labels and explicitly reports absent rows without writes', async ($, on) => {
  const f = prepare(on)
  const rows = receipt(await invoke($, LOOKUP, { references: ['S2', 'Q1', 'S99'] })).rows
  expect(rows).toEqual([
    { label: 'S2', id: 'plan:3', kind: 'step', status: 'pending', subject: 'Run first' },
    { label: 'Q1', id: 'question:7', kind: 'question', status: 'open', subject: 'Current question' },
    { label: 'S99', shown: false },
  ])
  expect(f.ledger.writes).toEqual([])
  expect(f.store.held.size).toBe(0)
})

test('TRACK-29 lookup without labels returns current display order and excludes history', async ($, on) => {
  prepare(on)
  const data = receipt(await invoke($, LOOKUP))
  expect(data.ok).toBe(true)
  expect(data.rows.map((row: { label: string; id: string }) => [row.label, row.id])).toEqual([
    ['S1', 'plan:2'], ['S2', 'plan:3'], ['Q1', 'question:7'],
  ])
})

test('TRACK-29 reorder preserves row identity, status, notes and cleared history in its durable save', async ($, on) => {
  const f = prepare(on)
  const original = structuredClone(f.ledger.value.steps)
  const data = receipt(await invoke($, REORDER, { ids: ['plan:3', 'plan:2'] }))
  expect(data.ok).toBe(true)
  expect(f.ledger.value.steps).toEqual([original[0], original[2], original[1]])
  const rawOwnSave = f.store.held.get(`s:${OLD}`) as { v?: number } | undefined
  expect(rawOwnSave?.v).toBe(2)
  expect(Object.hasOwn(rawOwnSave!, 'ledger')).toBe(false)
  const saved = await f.pool.logical(f.store, `s:${OLD}`) as { ledger?: Ledger } | undefined
  expect(saved?.ledger?.steps).toEqual(f.ledger.value.steps)
})

test('TRACK-29 reordered display order survives native resume', async ($, on) => {
  const f = prepare(on)
  expect(receipt(await invoke($, REORDER, { ids: ['plan:3', 'plan:2'] })).ok).toBe(true)
  f.ledger.value = { ...EMPTY, v: 1 }
  await $.classic.SessionStart({ source: 'resume', session_id: OLD } as never)
  expect(order(f.ledger.value)).toEqual(['plan:3', 'plan:2'])
})

test('TRACK-29 reordered order survives checkpoint restore to a different session', async ($, on) => {
  const f = prepare(on)
  expect(receipt(await invoke($, REORDER, { ids: ['plan:3', 'plan:2'] })).ok).toBe(true)
  const checkpoint = receipt(await invoke($, 'mcp__track__checkpoint', { expected_session: OLD }))
  expect(checkpoint.ok).toBe(true)
  f.setSession(SESSION)
  f.ledger.value = { ...EMPTY, v: 1 }
  const restored = receipt(await invoke($, 'mcp__track__restore_tracker', { from_session: OLD, expected_checkpoint: checkpoint }))
  expect(restored.ok).toBe(true)
  const visible = f.ledger.value.steps.filter(step => step.cleared !== true)
  expect(visible.map(step => step.subject)).toEqual(['Run first', 'Wait for peer'])
  expect(visible[1]).toMatchObject({ status: 'in_progress', delegated: true, note: 'Peer owns this' })
})

for (const ids of [['plan:3'], ['plan:3', 'plan:88'], ['plan:2', 'plan:2']]) {
  test(`TRACK-29 invalid reorder ${JSON.stringify(ids)} is refused before any write`, async ($, on) => {
    const f = prepare(on)
    expect(receipt(await invoke($, REORDER, { ids })).ok).toBe(false)
    expect(order(f.ledger.value)).toEqual(['plan:2', 'plan:3'])
    expect(f.ledger.writes).toEqual([])
    expect(f.store.held.size).toBe(0)
  })
}

test('TRACK-29 a subagent cannot reorder the main session', async ($, on) => {
  const f = prepare(on)
  const result = await invoke($, REORDER, { ids: ['plan:3', 'plan:2'], agentId: 'worker-1' })
  expect(result.deny).toBeDefined()
  expect(order(f.ledger.value)).toEqual(['plan:2', 'plan:3'])
  expect(f.ledger.writes).toEqual([])
})

test('TRACK-29 a failed durable save cannot report a successful reorder', async ($, on) => {
  const f = prepare(on)
  f.store.faults.write = 'disk unavailable'
  const result = receipt(await invoke($, REORDER, { ids: ['plan:3', 'plan:2'] }))
  expect(result.ok).toBe(false)
  expect(result.reason).toContain('disk unavailable')
  expect(f.store.held.has(`s:${OLD}`)).toBe(false)
})
