// FIXTURE, TRACK-21 refuter 7 (2026-10-11): old writers can publish a
// newer generation-less body while a new-code durable head already exists.
import { expect, mock, test } from 'claude-code/testing'
import { describeCheckpoint } from '../hooks/checkpoint'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'

for (const scenario of ['newer legacy', 'corrupt checksum', 'older legacy', 'foreign generation'] as const) test(`mixed-version resume handles ${scenario} without losing rows`, async ($, on) => {
  mock.clock(on)
  const memory = atomStore(on, 'ledger', EMPTY)
  const store = pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('classic.SessionStart', () => ({}))
  logs(on)
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'new-code row' } as never)
  const original = store.held.get(`s:${SESSION}`) as any
  const oldHead = structuredClone(store.held.get(`h:${SESSION}`)) as any
  const ledger = { ...original.ledger, nextQuestionId: 3, questions: [...original.ledger.questions,
    { id: 2, head: 'legacy row', at: 2, turnId: null, status: 'open', session_id: SESSION }] }
  const checkpoint = { ...await describeCheckpoint(ledger, SESSION), revision: oldHead.checkpoint.revision + 2 }
  const { generation, ...withoutGeneration } = original
  const legacy = { ...withoutGeneration, ledger, checkpoint,
    ...(scenario === 'corrupt checksum' && { checkpoint: { ...checkpoint, checksum: '0'.repeat(64) } }),
    ...(scenario === 'older legacy' && { checkpoint: { ...checkpoint, revision: oldHead.checkpoint.revision } }),
    ...(scenario === 'foreign generation' && { generation: '22222222-3333-4444-8555-666666666666' }),
  }
  store.held.set(`s:${SESSION}`, legacy)
  await $.classic.SessionStart({ source: 'resume', session_id: SESSION } as never).catch(() => undefined)
  // Head repair itself keeps the legacy body byte-identical.
  expect(store.held.get(`s:${SESSION}`)).toEqual(legacy)
  if (scenario !== 'newer legacy') {
    const receipt = JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result))
    expect(receipt.ok).toBe(false)
    expect(store.held.get(`h:${SESSION}`)).toEqual(oldHead)
    expect(store.held.get(`s:${SESSION}`)).toEqual(legacy)
    return
  }
  expect(memory.value.questions.map((row: any) => row.head)).toEqual(['new-code row', 'legacy row'])
  const archives = [...store.held.entries()].filter(([key]) => key.startsWith(`r:${SESSION}:legacy-head-`))
  expect(archives).toHaveLength(1)
  expect((archives[0]![1] as any).value).toEqual(oldHead)
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'after rollout' } as never)
  const receipt = JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result))
  expect(receipt.ok).toBe(true)
  const saved = store.held.get(`s:${SESSION}`) as any
  expect(saved.checkpoint.revision).toBe(checkpoint.revision + 1)
  expect(saved.ledger.questions.map((row: any) => row.head)).toEqual(['new-code row', 'legacy row', 'after rollout'])
  expect(saved.generation).toBe(oldHead.generation)
  expect((store.held.get(`h:${SESSION}`) as any).checkpoint).toEqual(saved.checkpoint)
})
