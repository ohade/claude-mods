// FIXTURE, TRACK-21 refuter 6 (2026-10-11): a failed first resume must
// recover a missing body from its retained head without a prior baseline.
import { expect, test } from 'claude-code/testing'
import { describeCheckpoint } from '../hooks/checkpoint'
import { EMPTY, SESSION, atomStore, blobPool, logs, pluginStore } from './kit'

test('failed startup and missing body recover once and allow later checkpoints', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const checkpoint = { ...await describeCheckpoint({ ...EMPTY, session_id: SESSION }, SESSION), revision: 7 }
  const head = { v: 1, session_id: SESSION, generation: '11111111-2222-4333-8444-555555555555', checkpoint }
  const body = { ...head, savedAt: 1, ledger: { ...EMPTY, session_id: SESSION } }
  const options: { leaseFailure?: string } = { leaseFailure: 'startup lease temporarily unavailable' }
  const store = pluginStore(on, { [`s:${SESSION}`]: body, [`h:${SESSION}`]: head }, undefined, options)
  const pool = blobPool(on)
  on('session.id', () => ({ value: SESSION }))
  on('classic.SessionStart', () => ({}))
  logs(on)
  await $.classic.SessionStart({ source: 'resume', session_id: SESSION } as never).catch(() => undefined)
  store.held.delete(`s:${SESSION}`)
  delete options.leaseFailure
  for (let round = 1; round <= 4; round++) {
    await $.tool.call({ tool: 'mcp__track__track_question', summary: `recovered row ${round}` } as never)
    const receipt = JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result))
    expect(receipt.ok).toBe(true)
    const rawOwnSave = store.held.get(`s:${SESSION}`) as { v?: number } | undefined
    expect(rawOwnSave?.v).toBe(2)
    expect(Object.hasOwn(rawOwnSave!, 'ledger')).toBe(false)
    const saved = store.held.get(`s:${SESSION}`) as any
    const logical = await pool.logical(store, `s:${SESSION}`) as any
    expect(saved.checkpoint.revision).toBe(7 + round)
    expect(logical.ledger.questions.map((row: any) => row.head)).toEqual(Array.from({ length: round }, (_, index) => `recovered row ${index + 1}`))
    expect((store.held.get(`h:${SESSION}`) as any).checkpoint).toEqual(saved.checkpoint)
    expect([...store.held.keys()].filter(key => key.startsWith(`r:${SESSION}:conflict-`))).toEqual([])
  }
})
