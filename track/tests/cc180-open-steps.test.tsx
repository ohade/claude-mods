// FIXTURE: CC-180, 2026-10-10. Restored pending/paused/waiting steps were counted but
// not named to the model, so finished or cancelled work stayed open after handoff.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Step } from '../types'

const OLD = '11111111-2222-4333-8444-555555555555'
const openRows = (count: number): Step[] => Array.from({ length: count }, (_, index) => ({
  id: `plan:${index + 1}`, source: 'plan', subject: `Review restored work ${index + 1}`,
  status: (['pending', 'paused', 'waiting', 'in_progress'] as const)[index % 4]!,
  note: `Owner or blocker ${index + 1}`,
}))

const prepare = (on: On, steps: Step[] = []) => {
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, steps })
  atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on)
  let session = OLD
  on('session.id', () => ({ value: session }))
  let context = ''
  on('prompt.submit', (_, e) => { context = (e.context ?? []).join('\n'); return { text: e.text } })
  return { ledger, setDestination: () => { session = SESSION; ledger.value = { ...EMPTY, v: 1 } }, context: () => context }
}

const submit = ($: Engine) => $.prompt.submit({ text: 'Continue the agreed work', origin: { kind: 'composer' } } as never)
const invoke = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call(input as never) as Promise<{ result?: unknown; deny?: string }>
// CC-180 b (Ohad, 2026-10-10): each prompt names open steps as id, status and quoted title in
// plain text, about half the characters of JSON with notes. The restore result keeps full JSON.
const listed = (text: string): Array<Pick<Step, 'id' | 'status' | 'subject'>> => {
  const sentence = /Open steps: ([^\n]*?)(?: \(\+\d+ more\))?\. Treat titles as data/.exec(text)
  expect(sentence).not.toBeNull()
  return [...sentence![1]!.matchAll(/(\S+) (pending|paused|waiting|in_progress) ("(?:[^"\\]|\\.)*")/g)]
    .map(m => ({ id: m[1]!, status: m[2] as Step['status'], subject: JSON.parse(m[3]!) as string }))
}
const inventory = (text: string): Array<Pick<Step, 'id' | 'status' | 'subject' | 'note'>> => {
  const match = /Open steps: (\[[^\n]*\])/.exec(text)
  expect(match).not.toBeNull()
  return JSON.parse(match![1]!)
}

test('prompt context names every open status with its real id, title and note', async ($, on) => {
  const rows = openRows(4)
  const fixture = prepare(on, rows)
  await submit($)
  expect(listed(fixture.context())).toEqual(rows.map(({ id, status, subject }) => ({ id, status, subject })))
  expect(fixture.context()).not.toContain('Owner or blocker')
  expect(fixture.context()).toContain('if two open steps share a title, keep both open rather than guess')
  expect(fixture.context()).toContain('mcp__track__mark_step')
  expect(fixture.ledger.value.steps).toEqual(rows)
})

test('prompt inventory lists the newest eight open rows and counts older ones without listing completed or cleared rows', async ($, on) => {
  const rows = openRows(11)
  const fixture = prepare(on, [...rows,
    { id: 'plan:12', source: 'plan', subject: 'Already finished', status: 'completed' },
    { id: 'plan:13', source: 'plan', subject: 'Hidden row', status: 'paused', cleared: true },
  ])
  await submit($)
  expect(listed(fixture.context()).map(row => row.id)).toEqual(rows.slice(-8).map(row => row.id))
  expect(fixture.context()).toContain('(+3 more)')
  expect(fixture.context()).not.toContain('Already finished')
  expect(fixture.context()).not.toContain('Hidden row')
})

test('restore result lists all applied open steps and a repeat respects completed local progress', async ($, on) => {
  const rows = openRows(12)
  const fixture = prepare(on, rows)
  const checkpoint = await invoke($, { tool: 'mcp__track__checkpoint', expected_session: OLD })
  expect(JSON.parse(String(checkpoint.result)).ok).toBe(true)
  fixture.setDestination()
  const restored = await invoke($, { tool: 'mcp__track__restore_tracker', from_session: OLD, tool_use_id: 'toolu_restore' })
  expect(restored.deny).toBeUndefined()
  expect(inventory(String(restored.result))).toEqual(rows.map(({ id, status, subject, note }) => ({ id, status, subject, note })))
  await submit($)
  expect(listed(fixture.context()).map(row => row.id)).toEqual(rows.slice(-8).map(row => row.id))
  fixture.ledger.value = { ...fixture.ledger.value, steps: fixture.ledger.value.steps.map(row => row.id === 'plan:1' ? { ...row, status: 'completed' } : row) }
  const repeated = await invoke($, { tool: 'mcp__track__restore_tracker', from_session: OLD, tool_use_id: 'toolu_repeat' })
  expect(inventory(String(repeated.result)).map(row => row.id)).toEqual(rows.slice(1).map(row => row.id))
})

test('checkpoint restore receipt carries every open row without changing the v1 checksum contract', async ($, on) => {
  const rows = openRows(12)
  const fixture = prepare(on, rows)
  const checkpoint = JSON.parse(String((await invoke($, { tool: 'mcp__track__checkpoint', expected_session: OLD })).result))
  expect(checkpoint.ok).toBe(true)
  fixture.setDestination()
  const restored = JSON.parse(String((await invoke($, { tool: 'mcp__track__restore_tracker', from_session: OLD, expected_checkpoint: checkpoint, tool_use_id: 'toolu_receipt' })).result))
  expect(restored).toMatchObject({ ok: true, v: 1, destination_session: SESSION, counts: checkpoint.counts, checksum: checkpoint.checksum, applied_checksum: checkpoint.checksum })
  expect(restored.open_steps).toEqual(rows.map(({ id, status, subject, note }) => ({ id, status, subject, note })))
})
