// FIXTURE: TRACK-8 request acknowledgement and TRACK-26 result persistence must
// share one durable mark_step operation without covering unrelated new work.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Pending, PendingInput, Step } from '../types'
import { checksumOf } from '../hooks/checkpoint'

const REQUEST = 'Continue the existing work.'
const OTHER = 'Inspect a different issue.'
const RESULT = 'Verified the completed work.'
const ACTIVE: Step = { id: 'plan:1', source: 'plan', subject: 'Original work', status: 'in_progress', startedAt: 100, activeTurnId: 'turn-1' }
const pendingInput = (id: number, head: string): PendingInput => ({ id, head, excerpt: head, rowKey: `request-${id}`, textHash: 'a'.repeat(64), turnId: 'turn-1' })
const prepare = (on: On) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, session_id: SESSION, steps: [{ ...ACTIVE }] })
  const pending = atomStore<Pending>(on, 'pending', { inputs: [pendingInput(1, REQUEST), pendingInput(2, OTHER)], nextId: 3 })
  atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'scroll', { questions: null, steps: null })
  const store = pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('env.get', () => ({ value: undefined }))
  on('env.set', () => ({ value: undefined }))
  return { ledger, pending, store }
}
const complete = ($: Engine, extra: Record<string, unknown> = {}) => $.tool.call({
  tool: 'mcp__track__mark_step', tool_use_id: 'completion-call', id: 'plan:1',
  status: 'completed', result_text: RESULT, source_text: REQUEST, ...extra,
} as never)

test('a source-linked completion saves its result and covers only the request owned by open work', async ($, on) => {
  const f = prepare(on)
  await complete($)
  const saved = (f.store.held.get(`s:${SESSION}`) as { ledger: Ledger }).ledger.steps[0] as any
  expect(saved.resultText).toBe(RESULT)
  expect(saved.resultTextHash).toBe(await checksumOf(RESULT))
  expect(saved.resultRequestId).toBe('completion-call')
  expect(saved).toMatchObject({ id: ACTIVE.id, subject: ACTIVE.subject, status: 'completed', startedAt: 100 })
  expect(f.pending.value.inputs.map(row => row.covered)).toEqual(['steps', undefined])

  const replacement = 'Verified additional result detail.'
  await complete($, { source_text: OTHER, result_text: replacement, tool_use_id: 'replacement-call' })
  const savedReplacement = (f.store.held.get(`s:${SESSION}`) as { ledger: Ledger }).ledger.steps[0] as { resultText?: string }
  expect(savedReplacement.resultText).toBe(replacement)
  expect(f.pending.value.inputs.map(row => row.covered)).toEqual(['steps', undefined])
  expect(f.ledger.value.steps).toHaveLength(1)
})

test('a refused result save cannot acknowledge the request', async ($, on) => {
  const f = prepare(on)
  f.store.faults.write = 'disk unavailable'
  expect(String((await complete($)).result)).toContain('unsaved')
  expect(f.pending.value.inputs.every(row => row.covered === undefined)).toBe(true)
  expect(f.store.held.get(`s:${SESSION}`)).toBeUndefined()
  expect(f.ledger.value.steps).toHaveLength(1)
})

test('invalid non-completed result input cannot cover a request through step reuse', async ($, on) => {
  const f = prepare(on)
  const before = JSON.stringify(f.ledger.value)
  expect((await complete($, { status: 'in_progress' })).deny).toBeDefined()
  expect(f.pending.value.inputs.every(row => row.covered === undefined)).toBe(true)
  expect(JSON.stringify(f.ledger.value)).toBe(before)
})
