// FIXTURE: TRACK-23, 2026-10-14. A saved blocker note was shortened before
// handoff compared it with the original, so otherwise valid deferred work failed.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Step } from '../types'

const SOURCE = '11111111-2222-4333-8444-555555555555'
const NOTE = `${'Keep the full blocker and owner details. '.repeat(9)}Wait for the user to approve the next step. 😀`
const row = (note?: string): Step => ({ id: 'plan:1', source: 'plan', subject: 'Deferred review', status: 'paused', ...(note === undefined ? {} : { note }) })

function prepare(on: On, steps = [row()]) {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps })
  atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  const store = pluginStore(on)
  const pool = blobPool(on)
  let session = SOURCE
  on('session.id', () => ({ value: session }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { ledger, store, pool, destination() { session = SESSION; ledger.value = { ...EMPTY, v: 1 } } }
}

const call = async ($: Engine, input: Record<string, unknown>) =>
  JSON.parse(String((await $.tool.call(input as never) as { result: unknown }).result))

test('mark_step keeps a long blocker note in memory, durable storage and the public checkpoint', async ($, on) => {
  const fixture = prepare(on)
  await $.tool.call({ tool: 'mcp__track__mark_step', id: 'plan:1', status: 'paused', note: NOTE } as never)
  const saved = await call($, { tool: 'mcp__track__checkpoint', expected_session: SOURCE })
  expect(fixture.ledger.value.steps[0]?.note).toBe(NOTE)
  expect(saved.open_steps).toEqual([{ id: 'plan:1', subject: 'Deferred review', status: 'paused', note: NOTE }])
  expect((await fixture.pool.logical(fixture.store, `s:${SOURCE}`) as { ledger: Ledger }).ledger.steps[0]?.note).toBe(NOTE)
})

test('restore preserves an already saved long note, its paused status and checksum on repeated calls', async ($, on) => {
  const fixture = prepare(on, [row(NOTE)])
  const saved = await call($, { tool: 'mcp__track__checkpoint', expected_session: SOURCE })
  fixture.destination()
  for (let attempt = 0; attempt < 2; attempt++) {
    const restored = await call($, { tool: 'mcp__track__restore_tracker', from_session: SOURCE, expected_checkpoint: saved, tool_use_id: `restore_${attempt}` })
    expect(restored).toMatchObject({ ok: true })
    expect(restored.applied_checksum).toBe(saved.checksum)
    expect(fixture.ledger.value.steps).toHaveLength(1)
    expect(fixture.ledger.value.steps[0]).toMatchObject({ status: 'paused', note: NOTE })
  }
})

test('mark_step reports the canonical saved row, including the full note', async ($, on) => {
  prepare(on)
  const result = await $.tool.call({ tool: 'mcp__track__mark_step', id: 'plan:1', status: 'paused', note: NOTE } as never)
  expect(String((result as { result: unknown }).result)).toContain(`Saved row: ${JSON.stringify({ id: 'plan:1', subject: 'Deferred review', status: 'paused', note: NOTE })}`)
})

test('mark_step does not report a saved row when durable storage refuses the write', async ($, on) => {
  const fixture = prepare(on)
  fixture.store.faults.write = 'Storage unavailable'
  const result = await $.tool.call({ tool: 'mcp__track__mark_step', id: 'plan:1', status: 'paused', note: NOTE } as never)
  expect(String((result as { result: unknown }).result)).toContain('unsaved')
  expect(String((result as { result: unknown }).result)).not.toContain('Saved row:')
})

test('interrupting a step appends its reason without discarding the existing blocker note', async ($, on) => {
  const fixture = prepare(on, [{ ...row(NOTE), status: 'in_progress', activeTurnId: 'turn-1' }])
  await $.turn.complete({ turnId: 'turn-1', isAborted: true, reason: 'aborted', answer: '', durationMs: 1 } as never)
  expect(fixture.ledger.value.steps[0]).toMatchObject({ status: 'paused', note: `${NOTE}; interrupted` })
})
