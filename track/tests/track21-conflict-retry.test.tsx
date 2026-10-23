// FIXTURE, TRACK-21 refuter 4 (2026-10-11): owner refusals must not be permanent.
import { expect, test } from 'claude-code/testing'
import { describeCheckpoint } from '../hooks/checkpoint'
import { EMPTY, SESSION, atomStore, blobPool, logs, pluginStore } from './kit'

const GEN = '22222222-3333-4444-8555-666666666666'
const q = (head: string) => ({ id: 1, head, at: 1, turnId: null, status: 'open' as const, session_id: SESSION })
const ledgerOf = (head: string) => ({ ...EMPTY, session_id: SESSION, nextQuestionId: 2, questions: [q(head)] })

test('TRACK-21 repeated conflict resumes without growing recovery copies', async ($, on) => {
  const base = ledgerOf('a')
  const cp1 = await describeCheckpoint(base, SESSION)
  const durableLedger = ledgerOf('c')
  const cp2 = await describeCheckpoint(durableLedger, SESSION, cp1)
  const body = { v: 1, session_id: SESSION, generation: GEN, savedAt: 1, ledger: durableLedger, checkpoint: cp2 }
  const memory = atomStore(on, 'ledger', ledgerOf('b'))
  atomStore(on, 'durability', { isUnsaved: false, reason: '', memorySession: SESSION, baseline: { session_id: SESSION, ledger: base, checkpoint: cp1, generation: GEN } })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on, { [`s:${SESSION}`]: body, [`h:${SESSION}`]: { v: 1, session_id: SESSION, generation: GEN, checkpoint: cp2 } })
  const pool = blobPool(on)
  on('session.id', () => ({ value: SESSION }))
  logs(on)
  const counts: number[] = []
  for (let i = 0; i < 6; i++) {
    await $.tool.call({ tool: 'mcp__track__track_question', summary: `probe question ${i}` } as never)
    counts.push([...store.held.keys()].filter(k => k.startsWith(`r:${SESSION}:`)).length)
  }
  expect(counts[5]).toBeLessThanOrEqual(2)
  const archived = [...store.held.entries()].filter(([key]) => key.startsWith(`r:${SESSION}:`)).map(([, value]) => JSON.stringify(value)).join('\n')
  expect(archived.includes('"head":"b"')).toBe(true)
  expect(archived.includes('probe question 0')).toBe(true)
  const receipt = JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result))
  expect(receipt.ok).toBe(true)
  expect((store.held.get(`s:${SESSION}`) as any).checkpoint.revision).toBeGreaterThan(2)
  const rawOwnSave = store.held.get(`s:${SESSION}`) as { v?: number } | undefined
  expect(rawOwnSave?.v).toBe(2)
  expect(Object.hasOwn(rawOwnSave!, 'ledger')).toBe(false)
  expect((await pool.logical(store, `s:${SESSION}`) as any).ledger).toEqual(memory.value)
})

test('TRACK-21 an unverified rewind can resume and acknowledge a later save', async ($, on) => {
  const durableLedger = ledgerOf('durable')
  const cp = await describeCheckpoint(durableLedger, SESSION)
  const body = { v: 1, session_id: SESSION, generation: GEN, savedAt: 1, ledger: durableLedger, checkpoint: cp }
  const memory = { ...EMPTY, nextQuestionId: 2, questions: [{ id: 1, head: 'made after failed resume', at: 5, turnId: null, status: 'open' as const }] }
  atomStore(on, 'ledger', memory)
  atomStore(on, 'durability', { isUnsaved: true, reason: 'resume: x', memorySession: SESSION, rewindBaseline: { session_id: SESSION, ledger: memory } })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on, { [`s:${SESSION}`]: body, [`h:${SESSION}`]: { v: 1, session_id: SESSION, generation: GEN, checkpoint: cp } })
  blobPool(on)
  on('session.id', () => ({ value: SESSION }))
  const debug = logs(on)
  const receipts: unknown[] = []
  for (let i = 0; i < 3; i++) {
    const r = JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result))
    receipts.push(r.ok === true ? 'ok' : String(r.reason).slice(0, 90))
  }
  expect(receipts[2]).toBe('ok')
})
