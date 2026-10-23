// FIXTURE, TRACK-21 targeted refuter (2026-10-11): a valid legacy
// successor can omit a previously saved row. Its adoption must archive that
// row before three-way reconciliation interprets the omission as a deletion.
import { expect, mock, test } from 'claude-code/testing'
import { describeCheckpoint } from '../hooks/checkpoint'
import { EMPTY, SESSION, atomStore, blobPool, logs, pluginStore } from './kit'

for (const trigger of ['resume', 'save'] as const) test(`legacy ${trigger} preserves a saved row omitted by the legacy writer`, async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', EMPTY)
  const store = pluginStore(on)
  const pool = blobPool(on)
  on('session.id', () => ({ value: SESSION }))
  on('classic.SessionStart', () => ({}))
  logs(on)
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'saved new-code row' } as never)
  const rawOwnSave = store.held.get(`s:${SESSION}`) as { v?: number } | undefined
  expect(rawOwnSave?.v).toBe(2)
  expect(Object.hasOwn(rawOwnSave!, 'ledger')).toBe(false)
  const logical = await pool.logical(store, `s:${SESSION}`) as any
  const oldHead = structuredClone(store.held.get(`h:${SESSION}`)) as any
  const legacyLedger = { ...logical.ledger, nextQuestionId: 3, questions: [
    { id: 2, head: 'legacy row', at: 2, turnId: null, status: 'open', session_id: SESSION },
  ] }
  const checkpoint = { ...await describeCheckpoint(legacyLedger, SESSION), revision: oldHead.checkpoint.revision + 1 }
  const { generation, ...withoutGeneration } = logical
  store.held.set(`s:${SESSION}`, { ...withoutGeneration, v: 1, ledger: legacyLedger, checkpoint })
  if (trigger === 'resume') await $.classic.SessionStart({ source: 'resume', session_id: SESSION } as never)
  const receipt = JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result))
  expect(receipt.ok).toBe(true)
  const saved = store.held.get(`s:${SESSION}`) as any
  const savedLogical = await pool.logical(store, `s:${SESSION}`) as any
  expect(savedLogical.ledger.questions.some((row: any) => row.head === 'legacy row')).toBe(true)
  const archives = [...store.held.entries()].filter(([key]) => key.startsWith(`r:${SESSION}:conflict-`)).map(([, value]) => value as any)
  expect(archives.some(archive => archive.value.ledger.questions.some((row: any) => row.head === 'saved new-code row'))).toBe(true)
  expect(archives.some(archive => archive.value.durable.body.ledger.questions.some((row: any) => row.head === 'legacy row'))).toBe(true)
  expect((store.held.get(`h:${SESSION}`) as any).checkpoint).toEqual(saved.checkpoint)
})
