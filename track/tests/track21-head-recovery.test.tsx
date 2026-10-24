import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

// TRACK-21 (2026-10-11): a missing body does not give a stale writer authority
// to replace a genuinely newer durable head with its older memory.
test('TRACK-21 missing newer body preserves the newer head byte for byte', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  mock.env(on, { CLAUDE_CONFIG_DIR: '/fixture/config' })
  const store = pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'acknowledged local row' } as never)
  const oldHead = store.held.get(`h:${SESSION}`) as any
  const newer = { ...oldHead, generation: 'newer-generation', checkpoint: { ...oldHead.checkpoint, revision: oldHead.checkpoint.revision + 3 } }
  store.held.set(`h:${SESSION}`, newer)
  store.held.delete(`s:${SESSION}`)
  const result = await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)
  expect(JSON.parse(String(result.result)).ok).toBe(false)
  expect(JSON.stringify(store.held.get(`h:${SESSION}`))).toBe(JSON.stringify(newer))
  expect(store.held.has(`s:${SESSION}`)).toBe(false)
  const snapshots = [...store.held.keys()].filter(key => key.startsWith(`r:${SESSION}:`))
  expect(snapshots.length).toBeGreaterThan(0)
})
