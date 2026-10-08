// FIXTURE: v1 text receipts fence the exact session, revision and restored values.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

const OLD = '11111111-2222-4333-8444-555555555555'
const prepare = (on: any) => {
  const l = atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 2, questions: [{ id: 1, head: 'Question 😀', at: 1, turnId: 't1', status: 'answered', answerText: 'תשובה', note: 'Saved note' }], steps: [{ id: 'plan:1', subject: 'Continue work', source: 'plan', status: 'paused', note: 'Peer is running' }] })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on)
  let session = OLD
  on('session.id', () => ({ value: session }))
  return { l, store, setSession: (id: string) => { session = id } }
}
const receipt = (r: any) => JSON.parse(typeof r.result === 'string' ? r.result : '{}')

test('checkpoint returns versioned JSON as text only after verified durable save', async ($, on) => {
  const { store } = prepare(on)
  const r = await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: OLD } as never)
  expect(typeof r.result).toBe('string')
  const c = receipt(r)
  expect(c).toMatchObject({ v: 1, ok: true, source_session: OLD, counts: { questions: 1, answers: 1, steps: 1 } })
  expect(c.revision).toBeGreaterThan(0)
  expect(c.checksum).toMatch(/^[a-f0-9]{64}$/)
  expect((store.held.get(`s:${OLD}`) as any)?.checkpoint).toMatchObject({ revision: c.revision, checksum: c.checksum })
})

test('checkpoint wrong-session and failed saves return explicit unsuccessful receipts', async ($, on) => {
  const { store } = prepare(on)
  const wrong = receipt(await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never))
  expect(wrong).toMatchObject({ v: 1, ok: false, source_session: OLD })
  expect(wrong.reason).toContain('session')
  store.faults.write = 'quota exhausted'
  const failed = receipt(await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: OLD } as never))
  expect(failed.ok).toBe(false)
  expect(failed.reason).toContain('quota')
})

test('unchanged checkpoints keep their revision and checksum stable', async ($, on) => {
  prepare(on)
  const a = receipt(await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: OLD } as never))
  const b = receipt(await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: OLD } as never))
  expect(a.ok).toBe(true)
  expect(b).toMatchObject({ ok: true, revision: a.revision, checksum: a.checksum })
})

test('restore validates the expected checkpoint before changing any row and returns actual values', async ($, on) => {
  const { l, setSession } = prepare(on)
  const expected = receipt(await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: OLD } as never))
  const original = JSON.parse(JSON.stringify(l.value))
  setSession(SESSION)
  l.value = { ...EMPTY } as any
  const bad = receipt(await $.tool.call({ tool: 'mcp__track__restore_tracker', from_session: OLD, expected_checkpoint: { ...expected, revision: expected.revision + 1 } } as never))
  expect(bad.ok).toBe(false)
  expect(l.value.questions).toHaveLength(0)
  const good = receipt(await $.tool.call({ tool: 'mcp__track__restore_tracker', from_session: OLD, expected_checkpoint: expected, tool_use_id: 'restore-a' } as never))
  expect(good).toMatchObject({ v: 1, ok: true, source_session: OLD, destination_session: SESSION, revision: expected.revision, checksum: expected.checksum, counts: expected.counts })
  expect((l.value as any).questions[0]).toMatchObject({ head: original.questions[0].head, answerText: 'תשובה', note: 'Saved note' })
  expect((l.value as any).steps[0]).toMatchObject({ subject: 'Continue work', status: 'paused', note: 'Peer is running' })
  await $.tool.call({ tool: 'mcp__track__restore_tracker', from_session: OLD, expected_checkpoint: expected, tool_use_id: 'restore-b' } as never)
  expect(l.value.questions).toHaveLength(1)
  expect(l.value.steps).toHaveLength(1)
})

test('wrong-source receipt is refused before restoration', async ($, on) => {
  const { l, setSession } = prepare(on)
  const expected = receipt(await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: OLD } as never))
  setSession(SESSION)
  l.value = { ...EMPTY } as any
  const bad = receipt(await $.tool.call({ tool: 'mcp__track__restore_tracker', from_session: OLD, expected_checkpoint: { ...expected, source_session: SESSION } } as never))
  expect(bad.ok).toBe(false)
  expect(l.value.questions).toHaveLength(0)
  expect(l.value.steps).toHaveLength(0)
})

test('restore reports the checksum of the values actually applied, including repeat calls', async ($, on) => {
  const { l, setSession } = prepare(on)
  const expected = receipt(await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: OLD } as never))
  setSession(SESSION)
  l.value = { ...EMPTY } as any
  const first = receipt(await $.tool.call({ tool: 'mcp__track__restore_tracker', from_session: OLD, expected_checkpoint: expected, tool_use_id: 'restore-a' } as never))
  expect(first.applied_checksum).toBe(expected.checksum)
  const again = receipt(await $.tool.call({ tool: 'mcp__track__restore_tracker', from_session: OLD, expected_checkpoint: expected, tool_use_id: 'restore-b' } as never))
  expect(again.applied_checksum).toBe(expected.checksum)
  l.value = { ...l.value, questions: l.value.questions.map(q => ({ ...q, note: 'Changed after restore' })) } as any
  const progressed = receipt(await $.tool.call({ tool: 'mcp__track__restore_tracker', from_session: OLD, expected_checkpoint: expected, tool_use_id: 'restore-c' } as never))
  expect(progressed.applied_checksum).not.toBe(expected.checksum)
  expect((l.value as any).questions[0].note).toBe('Changed after restore')
})

test('validated restore save failure returns one parseable unsuccessful receipt', async ($, on) => {
  const { l, store, setSession } = prepare(on)
  const expected = receipt(await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: OLD } as never))
  setSession(SESSION)
  l.value = { ...EMPTY } as any
  store.faults.write = 'quota exhausted'
  const failed = receipt(await $.tool.call({ tool: 'mcp__track__restore_tracker', from_session: OLD, expected_checkpoint: expected, tool_use_id: 'restore-a' } as never))
  expect(failed).toMatchObject({ v: 1, ok: false, source_session: OLD, destination_session: SESSION })
  expect(failed.reason).toContain('quota exhausted')
  expect(store.held.has(`s:${SESSION}`)).toBe(false)
})

test('validated restore conflict returns a JSON failure without replacing unfinished rows', async ($, on) => {
  const { l, setSession } = prepare(on)
  const expected = receipt(await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: OLD } as never))
  setSession(SESSION)
  l.value = { ...EMPTY, steps: [{ id: 'plan:local', source: 'plan', subject: 'Local unfinished work', status: 'in_progress' }] } as any
  const before = JSON.stringify(l.value)
  const failed = receipt(await $.tool.call({ tool: 'mcp__track__restore_tracker', from_session: OLD, expected_checkpoint: expected, tool_use_id: 'restore-a' } as never))
  expect(failed).toMatchObject({ v: 1, ok: false, source_session: OLD, destination_session: SESSION })
  expect(failed.reason).toContain('already has')
  expect(JSON.stringify(l.value)).toBe(before)
})

test('an empty checkpoint restores successfully with zero counts and the empty checksum', async ($, on) => {
  const { l, setSession } = prepare(on)
  l.value = { ...EMPTY } as any
  const expected = receipt(await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: OLD } as never))
  expect(expected.counts).toEqual({ questions: 0, answers: 0, steps: 0 })
  setSession(SESSION)
  const restored = receipt(await $.tool.call({ tool: 'mcp__track__restore_tracker', from_session: OLD, expected_checkpoint: expected, tool_use_id: 'restore-empty' } as never))
  expect(restored).toMatchObject({ v: 1, ok: true, destination_session: SESSION, applied_checksum: expected.checksum, counts: expected.counts })
})

test('validated restore refuses capacity before dropping any checkpointed answer', async ($, on) => {
  const { l, setSession } = prepare(on)
  l.value = { ...EMPTY, nextQuestionId: 201, questions: Array.from({ length: 200 }, (_, i) => ({ id: i + 1, head: `Saved ${i + 1}`, at: i, turnId: 'old', status: 'answered', answerText: `Answer ${i + 1}` })) } as any
  const expected = receipt(await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: OLD } as never))
  expect(expected.counts).toEqual({ questions: 200, answers: 200, steps: 0 })
  setSession(SESSION)
  l.value = { ...EMPTY, nextQuestionId: 2, questions: [{ id: 1, head: 'Local unfinished question', at: 1000, turnId: 'new', status: 'open' }] } as any
  const before = JSON.stringify(l.value)
  const failed = receipt(await $.tool.call({ tool: 'mcp__track__restore_tracker', from_session: OLD, expected_checkpoint: expected, tool_use_id: 'restore-full' } as never))
  expect(failed.ok).toBe(false)
  expect(failed.reason).toContain('capacity')
  expect(JSON.stringify(l.value)).toBe(before)
})
