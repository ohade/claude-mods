// FIXTURE: track_steps with a competing writer, and its refusal text. Real handler, engine and store in memory.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Pending, Step } from '../types'

const REQUEST = 'Continue the existing work'
const active: Step = { id: 'plan:1', source: 'plan', sourceId: 'original-row', subject: 'Original work', status: 'in_progress', startedAt: 100, activeTurnId: 't1' }
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call(input as never)

// The ledger starts with `rows`. The first write that `eligible` accepts is seen by `seen`, then a
// competing writer changes the ledger first, so that write loses its compare-and-set and retries.
const prepare = (on: On, rows: Step[], competing?: (current: Ledger) => Ledger) => {
  let ledger: ReturnType<typeof atomStore<Ledger>>
  const proposals: Ledger[] = []
  let injected = false
  on('state.set', { plugin: 'track', key: ['ledger'] }, async (_, event, next) => {
    proposals.push(event.value as Ledger)
    if (!injected && competing !== undefined) {
      injected = true
      ledger.value = competing(ledger.value)
      ledger.version++
    }
    return next(event)
  })
  ledger = atomStore(on, 'ledger', { ...EMPTY, session_id: SESSION, steps: rows })
  atomStore<Pending>(on, 'pending', { inputs: [{ id: 1, head: REQUEST, excerpt: REQUEST, rowKey: '11111111-2222-4333-8444', textHash: 'a'.repeat(64), turnId: 't1' }], nextId: 2 })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 4 })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'scroll', { questions: null, steps: null })
  mock.clock(on)
  mock.env(on, { CLAUDE_CONFIG_DIR: '/fixture/config' })
  pluginStore(on)
  blobPool(on)
  on('session.id', () => ({ value: SESSION }))
  on('ui.log', () => ({ value: undefined }))

  return { ledger, proposals }
}

test('an insertion that loses its write takes new row ids and a new identity on the retry', async ($, on) => {
  const competitor: Step = { id: 'plan:2', source: 'plan', sourceId: 'competitor-row', subject: 'Added by another writer', status: 'pending' }
  const f = prepare(on, [active], current => ({ ...current, steps: [...current.steps, competitor] }))
  const result = await call($, { tool: 'mcp__track__track_steps', tool_use_id: 'insert-retry', steps: ['Mine'], after: 'plan:1', source_text: REQUEST })
  expect(result.deny).toBeUndefined()
  expect(f.proposals.length).toBeGreaterThanOrEqual(2)
  const firstTry = f.proposals[0]!.steps.find(row => row.subject === 'Mine')!
  const retry = f.ledger.value.steps.find(row => row.subject === 'Mine')!
  expect(firstTry.id).toBe('plan:2')
  expect(retry.id).toBe('plan:3')
  expect(retry.sourceId).not.toBe(firstTry.sourceId)
  expect(f.ledger.value.steps.map(row => row.id)).toEqual(['plan:1', 'plan:3', 'plan:2'])
  expect(new Set(f.ledger.value.steps.map(row => row.id)).size).toBe(3)
  expect(String(result.result)).toContain('plan:3 Mine')
})

for (const status of ['in_progress', 'pending'] as const) {
  test(`replacing a plan that still has ${status} work is refused with the exact guidance`, async ($, on) => {
    const f = prepare(on, [{ ...active, status }])
    const result = await call($, { tool: 'mcp__track__track_steps', tool_use_id: 'replace-refused', steps: ['New work'], source_text: REQUEST })
    expect(result.result).toBe(`Cannot replace unfinished plan steps: plan:1 "Original work" (${status}). Reuse them or insert with after; pass replace: true only for an intentional replacement.`)
    expect(f.ledger.value.steps).toEqual([{ ...active, status }])
  })
}

test('the refusal lists every unfinished plan step, separated by a semicolon', async ($, on) => {
  const second: Step = { id: 'plan:2', source: 'plan', sourceId: 'second-row', subject: 'Second work', status: 'waiting' }
  prepare(on, [active, second])
  const result = await call($, { tool: 'mcp__track__track_steps', tool_use_id: 'replace-refused-two', steps: ['New work'], source_text: REQUEST })
  expect(result.result).toBe('Cannot replace unfinished plan steps: plan:1 "Original work" (in_progress); plan:2 "Second work" (waiting). Reuse them or insert with after; pass replace: true only for an intentional replacement.')
})
