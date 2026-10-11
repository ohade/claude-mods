// FIXTURE, TRACK-21 refuter 5 (2026-10-11): a concurrent atom write during
// store I/O must survive conflict adoption, reconciliation and session changes.
import { expect, test } from 'claude-code/testing'
import { describeCheckpoint } from '../hooks/checkpoint'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'

const GEN = '22222222-3333-4444-8555-666666666666'
const OTHER = '11111111-2222-4333-8444-555555555555'
const question = (id: number, head: string) => ({ id, head, at: id, turnId: null, status: 'open' as const, session_id: SESSION })
const ledgerOf = (...questions: ReturnType<typeof question>[]) => ({ ...EMPTY, session_id: SESSION, nextQuestionId: Math.max(1, ...questions.map(row => row.id + 1)), questions })
const checkpoint = async ($: any, session = SESSION) => JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: session } as never)).result))

test('conflict archives preserve a row added during the first archive write and dedupe unchanged retries', async ($, on) => {
  const base = ledgerOf(question(1, 'base'))
  const cp1 = await describeCheckpoint(base, SESSION)
  const durable = ledgerOf(question(1, 'peer edit'))
  const cp2 = await describeCheckpoint(durable, SESSION, cp1)
  const memory = atomStore(on, 'ledger', ledgerOf(question(1, 'local edit')))
  atomStore(on, 'durability', { isUnsaved: false, reason: '', memorySession: SESSION, baseline: { session_id: SESSION, ledger: base, checkpoint: cp1, generation: GEN } })
  const body = { v: 1, session_id: SESSION, generation: GEN, savedAt: 1, ledger: durable, checkpoint: cp2 }
  let injected = false
  const store = pluginStore(on, { [`s:${SESSION}`]: body, [`h:${SESSION}`]: { v: 1, session_id: SESSION, generation: GEN, checkpoint: cp2 } }, undefined, {
    beforeGet: key => {
      if (!injected && key.startsWith(`r:${SESSION}:conflict-`) && store.held.has(key)) {
        injected = true
        memory.value = ledgerOf(...memory.value.questions, question(2, 'arrived during archive'))
        memory.version++
      }
    },
  })
  on('session.id', () => ({ value: SESSION }))
  logs(on)
  expect((await checkpoint($)).reason).toContain('ledger changed during conflict recovery')
  expect(injected).toBe(true)
  await checkpoint($)
  const archives = [...store.held.entries()].filter(([key]) => key.startsWith(`r:${SESSION}:conflict-`)).map(([, value]) => value as any)
  expect(archives).toHaveLength(2)
  expect(archives.some(row => row.value.ledger.questions.some((q: any) => q.head === 'arrived during archive'))).toBe(true)
  expect((await checkpoint($)).ok).toBe(true)
  expect([...store.held.keys()].filter(key => key.startsWith(`r:${SESSION}:conflict-`))).toHaveLength(2)
})

test('a row added during a reconciled save keeps both peer and local rows on the next save', async ($, on) => {
  const base = ledgerOf(question(1, 'base'))
  const cp1 = await describeCheckpoint(base, SESSION)
  const durable = ledgerOf(question(1, 'base'), question(2, 'peer row'))
  const cp2 = await describeCheckpoint(durable, SESSION, cp1)
  const memory = atomStore(on, 'ledger', ledgerOf(question(1, 'base'), question(3, 'local row')))
  atomStore(on, 'durability', { isUnsaved: false, reason: '', memorySession: SESSION, baseline: { session_id: SESSION, ledger: base, checkpoint: cp1, generation: GEN } })
  let injected = false
  const body = { v: 1, session_id: SESSION, generation: GEN, savedAt: 1, ledger: durable, checkpoint: cp2 }
  const store = pluginStore(on, { [`s:${SESSION}`]: body, [`h:${SESSION}`]: { v: 1, session_id: SESSION, generation: GEN, checkpoint: cp2 } }, undefined, {
    beforeGet: key => {
      const saved = store.held.get(key) as any
      if (!injected && key === `s:${SESSION}` && saved?.checkpoint.revision > cp2.revision) {
        injected = true
        memory.value = ledgerOf(...memory.value.questions, question(4, 'arrived during save'))
        memory.version++
      }
    },
  })
  on('session.id', () => ({ value: SESSION }))
  logs(on)
  expect((await checkpoint($)).ok).toBe(true)
  expect(injected).toBe(true)
  expect(memory.value.questions.map(row => row.head).sort()).toEqual(['arrived during save', 'base', 'local row', 'peer row'])
  expect((await checkpoint($)).ok).toBe(true)
  expect((store.held.get(`s:${SESSION}`) as any).ledger.questions.map((row: any) => row.head).sort()).toEqual(['arrived during save', 'base', 'local row', 'peer row'])
})

for (const kind of ['question', 'step'] as const) test(`a ${kind} minted before a delayed save keeps its source session`, async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on)
  let session: string = SESSION
  on('session.id', () => ({ value: session }))
  // publishGate yields after the row was minted and before its queued save.
  on('env.set', { key: 'TRACK_GATE_SNAPSHOT' }, () => {
    session = OTHER
    return { value: undefined }
  })
  logs(on)
  await $.tool.call(kind === 'question'
    ? { tool: 'mcp__track__track_question', summary: 'minted in A' } as never
    : { tool: 'mcp__track__track_steps', steps: ['minted in A'] } as never)
  expect((await checkpoint($, OTHER)).ok).toBe(true)
  const destination = store.held.get(`s:${OTHER}`) as any
  expect(destination.ledger.questions).toEqual([])
  expect(destination.ledger.steps).toEqual([])
  const archives = [...store.held.entries()].filter(([key]) => key.startsWith(`r:${OTHER}:session-switch-`)).map(([, value]) => value as any)
  expect(archives).toHaveLength(1)
  expect(archives[0].value.source_session).toBe(SESSION)
  const rows = kind === 'question' ? archives[0].value.ledger.questions : archives[0].value.ledger.steps
  expect(rows[0][kind === 'question' ? 'head' : 'subject']).toBe('minted in A')
})
