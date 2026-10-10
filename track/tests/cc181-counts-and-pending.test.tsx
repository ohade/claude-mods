// FIXTURE: CC-181, 2026-10-10. Cleared history counted as current work, and
// the public checkpoint lacked the inventory needed to check declared pending items.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Step } from '../types'
import { describeCheckpoint } from '../hooks/checkpoint'

const OLD = '11111111-2222-4333-8444-555555555555'
const rows = (): Step[] => Array.from({ length: 75 }, (_, i) => ({
  id: `plan:${i + 1}`, source: 'plan', subject: `Work ${i + 1}`,
  status: i === 74 ? 'paused' : 'completed', ...(i < 50 && { cleared: true as const }),
}))
const prepare = (on: On, steps: Step[]) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps })
  atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  const store = pluginStore(on)
  let session = OLD
  on('session.id', () => ({ value: session }))
  let context = ''
  on('prompt.submit', (_, e) => { context = (e.context ?? []).join('\n'); return { text: e.text } })
  return { ledger, store, context: () => context, destination: () => { session = SESSION; ledger.value = { ...EMPTY, v: 1 } } }
}
const call = async ($: Engine, input: Record<string, unknown>) => JSON.parse(String((await $.tool.call(input as never) as { result: unknown }).result))

test('75 retained rows count as 25 current steps in both reminder and public checkpoint without changing history or checksum', async ($, on) => {
  const steps = rows()
  const fixture = prepare(on, steps)
  const expected = await describeCheckpoint(fixture.ledger.value, OLD)
  await $.prompt.submit({ text: 'Continue', origin: { kind: 'composer' } } as never)
  expect(fixture.context()).toContain('steps 24 of 25 done')
  expect(fixture.context()).not.toContain('of 75 done')
  const saved = await call($, { tool: 'mcp__track__checkpoint', expected_session: OLD })
  expect(saved).toMatchObject({ checksum: expected.checksum, counts: { steps: 25 } })
  expect(saved.open_steps).toEqual([{ id: 'plan:75', status: 'paused', subject: 'Work 75' }])
  expect(fixture.ledger.value.steps).toEqual(steps)
  expect((fixture.store.held.get(`s:${OLD}`) as { ledger: Ledger }).ledger.steps).toEqual(steps)
})

const mechanicalCaller = { plugins: [{ name: 'fixture-caller', register(on: On) {
  on('tool.call', { tool: 'fixture__restore' }, async ($, e) => $.tool.call({ ...e, tool: 'mcp__track__restore_tracker' }))
} }] }

test('mechanical restore notices label 25 current steps and 50 cleared history while retaining all 75 rows', mechanicalCaller, async ($, on) => {
  const steps = rows()
  const fixture = prepare(on, steps)
  fixture.ledger.value = { ...fixture.ledger.value, nextQuestionId: 2, questions: [{ id: 1, head: 'Saved question', at: 1, turnId: null, status: 'answered', answerText: 'Saved answer' }] }
  const notices: string[] = []
  on('session.append', (_, e, next) => { notices.push(JSON.stringify(e.message)); return next(e) })
  const saved = await call($, { tool: 'mcp__track__checkpoint', expected_session: OLD })
  fixture.destination()
  const restored = await call($, { tool: 'fixture__restore', from_session: OLD, expected_checkpoint: saved, tool_use_id: 'fixture_restore' })
  expect(restored).toMatchObject({ ok: true, applied_checksum: saved.checksum, counts: { steps: 25 } })
  expect(notices).toHaveLength(2)
  for (const notice of notices) {
    expect(notice).toContain('25 steps (50 cleared in history)')
    expect(notice).not.toContain(': 75 steps,')
  }
  expect(fixture.ledger.value.steps).toHaveLength(75)
  expect(fixture.ledger.value.steps.filter(s => s.cleared)).toHaveLength(50)
  expect(fixture.ledger.value.restores?.[0]).toMatchObject({ steps: 75, visibleSteps: 25 })
})

test('safe registration adds four waiting decisions to one existing open row and repeat restore preserves all five identities and history', async ($, on) => {
  const fixture = prepare(on, rows())
  await $.tool.call({ tool: 'mcp__track__track_steps', after: 'plan:75', steps: ['Memory decision', 'Plane close decision', 'CC-153 decision', 'Benchmark decision'] } as never)
  for (let n = 76; n <= 79; n++) await $.tool.call({ tool: 'mcp__track__mark_step', id: `plan:${n}`, status: 'waiting', note: 'Owner: Ohad; needs a decision' } as never)
  const saved = await call($, { tool: 'mcp__track__checkpoint', expected_session: OLD })
  expect(saved.open_steps).toHaveLength(5)
  expect(saved.open_steps.map((s: Step) => s.id)).toEqual(['plan:75', 'plan:76', 'plan:77', 'plan:78', 'plan:79'])
  expect(fixture.ledger.value.steps.slice(0, 75)).toEqual(rows())
  fixture.destination()
  for (let n = 0; n < 2; n++) {
    const restored = await call($, { tool: 'mcp__track__restore_tracker', from_session: OLD, expected_checkpoint: saved, tool_use_id: `restore_${n}` })
    expect(restored.open_steps).toEqual(saved.open_steps)
    expect(restored.applied_checksum).toBe(saved.checksum)
    expect(fixture.ledger.value.steps).toHaveLength(79)
    expect(new Set(fixture.ledger.value.steps.map(s => s.sourceId)).size).toBe(79)
  }
})
