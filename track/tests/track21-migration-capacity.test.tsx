import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

const FOREIGN = '11111111-2222-4333-8444-555555555555'
const WEEK = 7 * 24 * 60 * 60 * 1000

test('TRACK-21 imported legacy rows have explicit owners, provenance and a matching durable head', async ($, on) => {
  const row = { id: 1, head: 'imported row', status: 'open', at: 1, turnId: 'old' }
  const legacy = { v: 1, savedAt: 1, ledger: { ...EMPTY, nextQuestionId: 2, questions: [row] } }
  atomStore(on, 'ledger', EMPTY)
  const store = pluginStore(on, { [`s:${FOREIGN}`]: legacy }, undefined, { guardStates: { [FOREIGN]: 'closed' } })
  const files = new Map<string, string>()
  on('session.id', () => ({ value: SESSION }))
  on('fs.write', (_, e) => { files.set(e.path, String(e.text)); return { value: undefined } })
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  await $.command.run({ command: 'track', args: 'export /backup.json' })
  const source = JSON.parse(files.get('/backup.json')!)
  store.held.delete(`s:${FOREIGN}`)
  const result = await $.command.run({ command: 'track', args: 'import /backup.json' })
  expect(JSON.parse(result.text!).ok).toBe(true)
  const saved = store.held.get(`s:${FOREIGN}`) as any
  expect(saved.session_id).toBe(FOREIGN)
  expect(saved.ledger.questions).toEqual([{ ...row, session_id: FOREIGN }])
  expect(saved.import_provenance).toEqual({ source_identity: source.source_identity, bundle_checksum: source.checksum, source_session: FOREIGN })
  expect(store.held.get(`h:${FOREIGN}`)).toEqual({ v: 1, session_id: FOREIGN, generation: saved.generation, checkpoint: saved.checkpoint })
  expect(saved.generation).toMatch(/^[0-9a-f-]{36}$/)
  expect(saved.checkpoint.revision).toBeGreaterThan(0)
})

test('TRACK-21 capacity refusal names capacity and a later expired cleanup permits saving', async ($, on) => {
  const states: Record<string, 'live' | 'closed'> = {}
  const initial: Record<string, unknown> = {}
  for (let n = 1; n <= 16; n++) {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    states[id] = 'live'
    initial[`s:${id}`] = { v: 1, session_id: id, ledger: EMPTY, padding: 'p'.repeat(200000) }
  }
  atomStore(on, 'ledger', EMPTY)
  const store = pluginStore(on, initial, undefined, { guardStates: states })
  on('session.id', () => ({ value: SESSION }))
  const checkpoint = async () => JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result))
  const first = await checkpoint()
  expect(first.ok).toBe(false)
  expect(first.reason).toContain('capacity:')
  expect(first.reason).not.toContain('stale writer revision')
  for (const [key, value] of Object.entries(initial)) expect(store.held.get(key)).toEqual(value)
  for (const [key, value] of Object.entries(initial)) {
    states[key.slice(2)] = 'closed'
    store.held.set(key, { ...(value as object), closedAt: Date.now() - WEEK - 1000 })
  }
  store.held.set('cleanup', { v: 1, lastCleanup: Date.now() - 60 * 60 * 1000 - 1000, cursor: '' })
  const second = await checkpoint()
  expect(second.ok).toBe(true)
  expect(store.held.has(`s:${SESSION}`)).toBe(true)
})
