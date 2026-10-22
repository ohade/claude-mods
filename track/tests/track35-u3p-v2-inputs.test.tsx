// FIXTURE: TRACK-35 U3-P, 2026-10-23. Real Track hooks consume valid v:2
// pointers through blobPool; these checks do not prove host filesystem atomicity.
import { expect, mock, test } from 'claude-code/testing'
import { describeCheckpoint } from '../hooks/checkpoint'
import type { Checkpoint, Ledger } from '../types'
import { EMPTY, atomStore, blobPool, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'

type LogicalBody = { v: 1; session_id: string; generation: string; savedAt: number; ledger: Ledger; checkpoint: Checkpoint }
const sessionFor = (family: number) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(family).padStart(12, '0')}`
const FOREIGN = '11111111-2222-4333-8444-555555555555'
const FIRST_RESPONSE = '11111111-2222-4333-8444-666666666666'
const CORRECTED_RESPONSE = '66666666-7777-4888-8999-bbbbbbbbbbbb'
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length
const fingerprint = async (text: string) => ({
  bytes: utf8Bytes(text),
  checksum: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join(''),
})
const pointerFor = async (body: LogicalBody, ledger: Ledger) => {
  const text = JSON.stringify(ledger)
  const ref = await fingerprint(text)
  const checkpoint = await describeCheckpoint(ledger, body.session_id, body.checkpoint)
  const { ledger: _inline, ...metadata } = body
  const pointer = { ...metadata, v: 2, ledger_blob: ref, checkpoint }
  const head = { v: 1, session_id: body.session_id, generation: body.generation, checkpoint }
  return { pointer, head, text, path: `/fixture/config/state/track/blobs/${ref.checksum}.json` }
}
const prepare = (on: On, session: string, initial: Ledger = EMPTY, beforeGet?: (key: string) => void) => {
  const pool = blobPool(on)
  mock.clock(on)
  const memory = atomStore<Ledger>(on, 'ledger', initial)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  const store = pluginStore(on, {}, undefined, { beforeGet })
  logs(on)
  on('session.id', () => ({ value: session }))
  return { pool, memory, store }
}
const invoke = ($: Engine, tool: string, input: object = {}) => $.tool.call({ tool, tool_use_id: `${tool}-call`, ...input } as never)
const receipt = (result: { result?: unknown }) => JSON.parse(typeof result.result === 'string' ? result.result : '{}')
const logicalBody = async (f: ReturnType<typeof prepare>, session: string) => await f.pool.logical(f.store, `s:${session}`) as LogicalBody
const install = (f: ReturnType<typeof prepare>, session: string, fixture: Awaited<ReturnType<typeof pointerFor>>) => {
  f.pool.files.set(fixture.path, fixture.text)
  f.store.held.set(`s:${session}`, fixture.pointer)
  f.store.held.set(`h:${session}`, fixture.head)
}
const response = ($: Engine, text: string, uuid: string) => $.session.append({
  door: 'response', uuid,
  message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: `<!-- A1:start -->\n${text}\n<!-- A1:end -->` }] },
  origin: { kind: 'model', model: 'fixture' },
} as never)
const visibleOrder = (ledger: Ledger) => ledger.steps.filter(step => step.cleared !== true).map(step => step.id)

test('TRACK-35 v2 consistent-head stale conflict refuses save and keeps raw body head and blob', async ($, on) => {
  const session = sessionFor(90)
  const f = prepare(on, session)
  await invoke($, 'mcp__track__track_question', { summary: 'Acknowledged first row' })
  const saved = await logicalBody(f, session)
  // Both writers add Q2 differently after the same baseline. A valid newer
  // checkpoint must reach the stale-revision conflict, rather than fail hydration.
  const newerLedger: Ledger = { ...saved.ledger, nextQuestionId: 3, questions: [...saved.ledger.questions,
    { session_id: session, id: 2, head: 'Newer durable café 🚀', at: 2, turnId: 't1', status: 'open' },
  ] }
  const fixture = await pointerFor(saved, newerLedger)
  expect(fixture.pointer.checkpoint.revision).toBeGreaterThan(saved.checkpoint.revision)
  install(f, session, fixture)
  const rawBefore = JSON.stringify(fixture.pointer)
  const headBefore = JSON.stringify(fixture.head)
  const result = await invoke($, 'mcp__track__track_question', { summary: 'Conflicting local Q2', tool_use_id: 'stale-second-call' })
  expect(JSON.stringify(result)).toContain('unsaved')
  expect(JSON.stringify(f.store.held.get(`s:${session}`))).toBe(rawBefore)
  expect(JSON.stringify(f.store.held.get(`h:${session}`))).toBe(headBefore)
  expect(await fingerprint(f.pool.files.get(fixture.path)!)).toEqual(fixture.pointer.ledger_blob)
  expect(f.pool.files.get(fixture.path)).toBe(fixture.text)
})

test('TRACK-35 v2 conflicting nested owner refuses checkpoint and keeps raw body head and blob', async ($, on) => {
  const session = sessionFor(91)
  const f = prepare(on, session)
  await invoke($, 'mcp__track__track_question', { summary: 'Acknowledged local row' })
  const saved = await logicalBody(f, session)
  const conflicting: Ledger = { ...saved.ledger, nextQuestionId: 3, questions: [...saved.ledger.questions,
    { session_id: FOREIGN, id: 2, head: 'Foreign nested owner café 🚀', at: 2, turnId: null, status: 'open' },
  ] }
  const fixture = await pointerFor(saved, conflicting)
  install(f, session, fixture)
  const rawBefore = JSON.stringify(fixture.pointer)
  const headBefore = JSON.stringify(fixture.head)
  const result = receipt(await invoke($, 'mcp__track__checkpoint', { expected_session: session }))
  expect(result.ok).toBe(false)
  expect(result.reason).toContain('identity')
  expect(JSON.stringify(f.store.held.get(`s:${session}`))).toBe(rawBefore)
  expect(JSON.stringify(f.store.held.get(`h:${session}`))).toBe(headBefore)
  expect(await fingerprint(f.pool.files.get(fixture.path)!)).toEqual(fixture.pointer.ledger_blob)
  expect(f.pool.files.get(fixture.path)).toBe(fixture.text)
})

test('TRACK-35 v2 answer correction saves corrected answer and concurrent step without clobbering blob', async ($, on) => {
  const session = sessionFor(92)
  const f = prepare(on, session)
  on('session.append', (_, e, next) => next(e))
  await invoke($, 'mcp__track__track_question', { summary: 'Which answer is current?' })
  await response($, 'Original answer.', FIRST_RESPONSE)
  const saved = await logicalBody(f, session)
  const concurrent: Ledger = { ...saved.ledger, steps: [...saved.ledger.steps,
    { session_id: session, id: 'plan:9', source: 'plan', subject: 'Concurrent durable café 🚀', status: 'paused' },
  ] }
  const fixture = await pointerFor(saved, concurrent)
  install(f, session, fixture)
  await response($, 'Corrected full answer.', CORRECTED_RESPONSE)
  const durable = (await logicalBody(f, session)).ledger
  expect(durable.questions[0]?.answerText).toBe('Corrected full answer.')
  expect(durable.questions[0]?.answerRequestId).toBe(CORRECTED_RESPONSE)
  expect(durable.steps).toContainEqual(expect.objectContaining({ id: 'plan:9', subject: 'Concurrent durable café 🚀', status: 'paused', session_id: session }))
  expect(f.memory.value.questions[0]?.answerText).toBe('Corrected full answer.')
  expect(await fingerprint(f.pool.files.get(fixture.path)!)).toEqual(fixture.pointer.ledger_blob)
  expect(f.pool.files.get(fixture.path)).toBe(fixture.text)
})

test('TRACK-35 v2 newer membership refuses mismatched reorder receipt and keeps durable rows and blob', async ($, on) => {
  const session = sessionFor(93)
  let replacement: Awaited<ReturnType<typeof pointerFor>> | undefined
  let injected = false
  const initial: Ledger = { ...EMPTY, session_id: session, steps: [
    { session_id: session, id: 'plan:1', source: 'plan', subject: 'Cleared history', status: 'completed', cleared: true },
    { session_id: session, id: 'plan:2', source: 'plan', subject: 'Two', status: 'pending', note: 'Keep this note' },
    { session_id: session, id: 'plan:3', source: 'plan', subject: 'Three', status: 'pending' },
  ] }
  const f = prepare(on, session, initial, key => {
    if (replacement === undefined || injected || key !== `s:${session}`) return
    injected = true
    install(f, session, replacement)
  })
  on('tool.call', { tool: /mcp__track__reorder_steps$/ }, () => ({ result: '{}' }))
  expect(receipt(await invoke($, 'mcp__track__checkpoint', { expected_session: session })).ok).toBe(true)
  const saved = await logicalBody(f, session)
  const newerLedger: Ledger = { ...saved.ledger, steps: [...saved.ledger.steps,
    { session_id: session, id: 'plan:4', source: 'plan', subject: 'Concurrent new café 🚀', status: 'pending' },
  ] }
  replacement = await pointerFor(saved, newerLedger)
  const result = receipt(await invoke($, 'mcp__track__reorder_steps', { ids: ['plan:3', 'plan:2'] }))
  expect(injected).toBe(true)
  expect(result.ok).toBe(false)
  expect(result.reason).toContain('saved order differs')
  expect(result.order).toBeUndefined()
  const durable = (await logicalBody(f, session)).ledger
  expect(visibleOrder(durable)).toEqual(['plan:2', 'plan:3', 'plan:4'])
  expect(durable.steps).toEqual(newerLedger.steps)
  expect(await fingerprint(f.pool.files.get(replacement.path)!)).toEqual(replacement.pointer.ledger_blob)
  expect(f.pool.files.get(replacement.path)).toBe(replacement.text)
})
