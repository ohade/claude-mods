// FIXTURE, TRACK-21 (2026-10-11): failed saves must not erase memory ownership.
import { expect, test } from 'claude-code/testing'
import { describeCheckpoint } from '../hooks/checkpoint'
import { EMPTY, SESSION, atomStore, blobPool, logs, pluginStore } from './kit'

const OTHER = '11111111-2222-4333-8444-555555555555'
for (const kind of ['question', 'step'] as const) test(`TRACK-21 unsaved ${kind} stays with its original session after a switch`, async ($, on) => {
  const memory = atomStore(on, 'ledger', EMPTY)
  const options = { leaseFailure: 'another loaded Track instance owns this session' }
  const destination = { ...EMPTY, session_id: OTHER, nextQuestionId: 2,
    questions: [{ id: 1, head: 'other history', at: 1, turnId: null, status: 'open' as const }] }
  const generation = '22222222-3333-4444-8555-666666666666'
  const checkpoint = await describeCheckpoint(destination, OTHER)
  const body = { v: 1, session_id: OTHER, generation, savedAt: 1, ledger: destination, checkpoint }
  const store = pluginStore(on, { [`s:${OTHER}`]: body, [`h:${OTHER}`]: { v: 1, session_id: OTHER, generation, checkpoint } }, undefined, options)
  const pool = blobPool(on)
  let session: string = SESSION
  on('session.id', () => ({ value: session }))
  on('session.end', () => ({ sessionId: session }))
  on('classic.SessionStart', () => ({}))
  logs(on)
  await $.tool.call(kind === 'question'
    ? { tool: 'mcp__track__track_question', summary: 'row minted in session A' } as never
    : { tool: 'mcp__track__track_steps', steps: ['step minted in session A'] } as never)
  const original = structuredClone(memory.value)
  await $.session.end({ reason: 'resume' } as never)
  delete (options as { leaseFailure?: string }).leaseFailure
  session = OTHER
  await $.classic.SessionStart({ source: 'resume', session_id: OTHER } as never)
  const receipt = JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: OTHER } as never)).result))
  expect(receipt.ok).toBe(true)
  const rawOwnSave = store.held.get(`s:${OTHER}`) as { v?: number } | undefined
  expect(rawOwnSave?.v).toBe(2)
  expect(Object.hasOwn(rawOwnSave!, 'ledger')).toBe(false)
  expect((await pool.logical(store, `s:${OTHER}`) as any).ledger.questions.map((row: any) => row.head)).toEqual(['other history'])
  expect((await pool.logical(store, `s:${OTHER}`) as any).ledger.steps).toEqual([])
  const archived = [...store.held.entries()].filter(([key]) => key.startsWith(`r:${OTHER}:session-switch-`)).map(([, value]) => value as any)
  expect(archived).toHaveLength(1)
  expect(archived[0].value.source_session).toBe(SESSION)
  expect(archived[0].value.ledger).toEqual(original)
})
