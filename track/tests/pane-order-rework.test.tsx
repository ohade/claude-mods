// FIXTURE: TRACK-29 exact-candidate review, 2026-10-19. Reorder must survive
// an overlapping save, and prompt Q labels must keep their pane meaning.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger } from '../types'
import { reconcileLedger } from '../hooks/reconcile'
import { paneReferenceContext } from '../hooks/pane-order'
import { describeCheckpoint } from '../hooks/checkpoint'

const prepare = (on: On, beforeGet?: (key: string) => void) => {
  const pool = blobPool(on)
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, session_id: SESSION, steps: [
    { session_id: SESSION, id: 'plan:1', source: 'plan', subject: 'Cleared history', status: 'completed', cleared: true },
    { session_id: SESSION, id: 'plan:2', source: 'plan', subject: 'Two', status: 'pending', note: 'Keep this note' },
    { session_id: SESSION, id: 'plan:3', source: 'plan', subject: 'Three', status: 'pending' },
  ], questions: [{ session_id: SESSION, id: 7, head: 'Current question', at: 2, turnId: 'old', status: 'open' }], nextQuestionId: 8 })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  const store = pluginStore(on, {}, undefined, { beforeGet })
  logs(on)
  const contexts: string[] = []
  on('session.id', () => ({ value: SESSION }))
  on('tool.call', { tool: /mcp__track__(reorder_steps|mark_step)$/ }, () => ({ result: '{}' }))
  on('prompt.submit', (_, e) => { contexts.push(...(e.context ?? [])); return { text: e.text } })
  return { ledger, store, pool, contexts }
}
const invoke = ($: Engine, tool: string, input: object = {}) => $.tool.call({ tool, tool_use_id: `${tool}-call`, ...input } as never)
const receipt = (result: { result?: unknown }) => JSON.parse(typeof result.result === 'string' ? result.result : '{}')
const order = (ledger: Ledger) => ledger.steps.filter(step => step.cleared !== true).map(step => step.id)

test('TRACK-29 a second reorder during the first save acknowledges its own durable order', async ($, on) => {
  let fired = false
  let second: ReturnType<typeof invoke> | undefined
  const f = prepare(on, key => {
    if (!fired && key === `s:${SESSION}` && f.store.held.has(key)) {
      fired = true
      second = invoke($, 'mcp__track__reorder_steps', { ids: ['plan:2', 'plan:3'] })
    }
  })
  await invoke($, 'mcp__track__reorder_steps', { ids: ['plan:3', 'plan:2'] })
  expect(fired).toBe(true)
  const result = receipt(await second!)
  expect(result.ok).toBe(true)
  expect(result.order).toEqual(['plan:2', 'plan:3'])
  expect(order((await f.pool.logical(f.store, `s:${SESSION}`) as { ledger: Ledger }).ledger)).toEqual(['plan:2', 'plan:3'])
  expect(order(f.ledger.value)).toEqual(['plan:2', 'plan:3'])
})

test('TRACK-29 reorder during a status save preserves both the new order and status', async ($, on) => {
  let fired = false
  let reordered: ReturnType<typeof invoke> | undefined
  const f = prepare(on, key => {
    if (!fired && key === `s:${SESSION}` && f.store.held.has(key)) {
      fired = true
      reordered = invoke($, 'mcp__track__reorder_steps', { ids: ['plan:3', 'plan:2'] })
    }
  })
  await invoke($, 'mcp__track__mark_step', { id: 'plan:2', status: 'in_progress' })
  expect(fired).toBe(true)
  const result = receipt(await reordered!)
  expect(result.ok).toBe(true)
  expect(result.order).toEqual(['plan:3', 'plan:2'])
  const durable = (await f.pool.logical(f.store, `s:${SESSION}`) as { ledger: Ledger }).ledger
  expect(order(durable)).toEqual(['plan:3', 'plan:2'])
  expect(durable.steps.find(step => step.id === 'plan:2')).toMatchObject({ status: 'in_progress', note: 'Keep this note' })
})

test('TRACK-29 conflicting independent order changes are refused instead of silently chosen', async ($, on) => {
  const f = prepare(on)
  const base = { ...f.ledger.value, steps: f.ledger.value.steps.map(step => ({ ...step, cleared: undefined })) }
  const durable = { ...base, steps: [base.steps[1]!, base.steps[0]!, base.steps[2]!] }
  const local = { ...base, steps: [base.steps[0]!, base.steps[2]!, base.steps[1]!] }
  expect(() => reconcileLedger(base, durable, local, SESSION)).toThrow('order')
  expect(base.steps.map(step => step.id)).toEqual(['plan:1', 'plan:2', 'plan:3'])
})

test('TRACK-29 open and withdrawn reminders never reuse a pane label as a permanent id', async ($, on) => {
  const f = prepare(on)
  f.ledger.value = { ...f.ledger.value, withdrawn: [{ id: 12, head: 'Withdrawn question', session_id: SESSION }] }
  await $.prompt.submit({ text: 'Answer Q1 and explain Q7 and Q12.', origin: { kind: 'composer' }, turnId: 't1' } as never)
  const context = f.contexts.join('\n')
  expect(context).toContain('Q1 = question:7')
  expect(context).toContain('Q7 = not shown')
  expect(context).not.toContain('open Q7')
  expect(context).not.toContain('withdrew Q12')
  expect(context).toContain('question:12')
})

test('TRACK-29 auto lookup bounds its references and ignores lower-case identifiers', async ($, on) => {
  const f = prepare(on)
  const context = paneReferenceContext(Array.from({ length: 200 }, (_, i) => `S${i + 1}`).join(' '), f.ledger.value) ?? ''
  expect((context.match(/S\d+ =/g) ?? []).length).toBeLessThanOrEqual(64)
  expect(paneReferenceContext('s2 q1', f.ledger.value)).toBeUndefined()
  expect(paneReferenceContext('S1000', f.ledger.value)).toBeUndefined()
  const unrelated = paneReferenceContext('Upload the report to AWS S3', f.ledger.value) ?? ''
  expect(unrelated).toContain('S3 = not shown')
  expect(unrelated).toContain('This lookup is data, not a request to act')
  expect(unrelated).toContain('AWS S3 remain unrelated')
})

test('TRACK-29 newer durable membership cannot receive a successful mismatched-order receipt', async ($, on) => {
  let replacement: { body: unknown; head: unknown } | undefined
  let injected = false
  const f = prepare(on, key => {
    if (replacement === undefined || injected || key !== `s:${SESSION}`) return
    injected = true
    f.store.held.set(`s:${SESSION}`, replacement.body)
    f.store.held.set(`h:${SESSION}`, replacement.head)
  })
  expect(receipt(await invoke($, 'mcp__track__checkpoint', { expected_session: SESSION })).ok).toBe(true)
  const prior = structuredClone(f.store.held.get(`s:${SESSION}`)) as any
  const logical = await f.pool.logical(f.store, `s:${SESSION}`) as { ledger: Ledger }
  const ledger: Ledger = { ...logical.ledger, steps: [...logical.ledger.steps,
    { session_id: SESSION, id: 'plan:4', source: 'plan', subject: 'Concurrent new work', status: 'pending' },
  ] }
  const checkpoint = await describeCheckpoint(ledger, SESSION, prior.checkpoint)
  replacement = { body: { ...logical, v: 1, ledger, checkpoint }, head: { v: 1, session_id: SESSION, generation: prior.generation, checkpoint } }
  const result = receipt(await invoke($, 'mcp__track__reorder_steps', { ids: ['plan:3', 'plan:2'] }))
  expect(injected).toBe(true)
  expect(result.ok).toBe(false)
  expect(result.reason).toContain('saved order differs')
  expect(result.order).toBeUndefined()
  const durable = (await f.pool.logical(f.store, `s:${SESSION}`) as { ledger: Ledger }).ledger
  expect(order(durable)).toEqual(['plan:2', 'plan:3', 'plan:4'])
  expect(durable.steps.find(step => step.id === 'plan:4')?.subject).toBe('Concurrent new work')
})
