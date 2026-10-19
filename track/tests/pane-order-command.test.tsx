// FIXTURE: TRACK-29, 2026-10-19. The person needs the same lookup and durable
// reorder operation without asking the model to invoke an MCP tool.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger } from '../types'

const prepare = (on: On) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, session_id: SESSION, steps: [
    { id: 'plan:1', session_id: SESSION, source: 'plan', subject: 'Cleared history', status: 'completed', cleared: true },
    { id: 'plan:2', session_id: SESSION, source: 'plan', subject: 'Review peer', status: 'in_progress', delegated: true, note: 'Keep the owner' },
    { id: 'plan:3', session_id: SESSION, source: 'plan', subject: 'Run first', status: 'pending' },
  ] })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  const pane = atomStore(on, 'pane', { isOpen: false, hidden: false, closedByPerson: false })
  const store = pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('command.run', () => ({ text: '{}' }))
  return { ledger, pane, store }
}
const command = async ($: Engine, args: string) => {
  const result = await $.command.run({ command: 'track', args } as never)
  // Missing output is an assertion failure, rather than a JSON parser error.
  expect(result.text).toBeDefined()
  return JSON.parse(result.text ?? '{}')
}

test('TRACK-29 /track order reads current visible order without writes or pane toggles', async ($, on) => {
  const f = prepare(on)
  const data = await command($, 'order')
  expect(data.ok).toBe(true)
  expect(data.rows.map((row: { label: string; id: string }) => [row.label, row.id])).toEqual([['S1', 'plan:2'], ['S2', 'plan:3']])
  expect(f.ledger.writes).toEqual([])
  expect(f.pane.writes).toEqual([])
  expect(f.store.held.size).toBe(0)
})

test('TRACK-29 /track reorder saves exactly the requested visible permutation', async ($, on) => {
  const f = prepare(on)
  const before = structuredClone(f.ledger.value.steps)
  const data = await command($, 'reorder ["plan:3","plan:2"]')
  expect(data.ok).toBe(true)
  expect(f.ledger.value.steps).toEqual([before[0], before[2], before[1]])
  expect((f.store.held.get(`s:${SESSION}`) as { ledger: Ledger }).ledger.steps).toEqual(f.ledger.value.steps)
  expect(f.pane.writes).toEqual([])
})

for (const args of ['reorder', 'reorder [', 'reorder ["plan:3"]', 'reorder ["S2","S1"]']) {
  test(`TRACK-29 /track ${args} refuses before writing`, async ($, on) => {
    const f = prepare(on)
    const data = await command($, args)
    expect(data.ok).toBe(false)
    expect(f.ledger.writes).toEqual([])
    expect(f.pane.writes).toEqual([])
    expect(f.store.held.size).toBe(0)
  })
}

test('TRACK-29 /track reorder reports a failed save without success', async ($, on) => {
  const f = prepare(on)
  f.store.faults.write = 'disk unavailable'
  const data = await command($, 'reorder ["plan:3","plan:2"]')
  expect(data.ok).toBe(false)
  expect(data.reason).toContain('disk unavailable')
  expect(f.store.held.has(`s:${SESSION}`)).toBe(false)
})
