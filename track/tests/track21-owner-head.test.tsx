// FIXTURE, TRACK-21 (2026-10-11): revision equality alone cannot authorize
// overwriting a conflicting head, or reassign ambiguous imported ownership.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

const FOREIGN = '11111111-2222-4333-8444-555555555555'

test('TRACK-21 import refuses a conflicting embedded ledger owner and keeps the source bundle', async ($, on) => {
  const legacy = { v: 1, savedAt: 1, ledger: { ...EMPTY, session_id: SESSION } }
  atomStore(on, 'ledger', EMPTY)
  const store = pluginStore(on, { [`s:${FOREIGN}`]: legacy }, undefined, { guardStates: { [FOREIGN]: 'closed' } })
  const files = new Map<string, string>()
  on('session.id', () => ({ value: SESSION }))
  on('fs.write', (_, e) => { files.set(e.path, String(e.text)); return { value: undefined } })
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  await $.command.run({ command: 'track', args: 'export /backup.json' })
  const source = files.get('/backup.json')
  store.held.delete(`s:${FOREIGN}`)
  const imported = JSON.parse((await $.command.run({ command: 'track', args: 'import /backup.json' })).text!)
  expect(imported.ok).toBe(false)
  expect(imported.reason).toContain('identity')
  expect(store.held.has(`s:${FOREIGN}`)).toBe(false)
  expect(store.held.has(`h:${FOREIGN}`)).toBe(false)
  expect(files.get('/backup.json')).toBe(source)
})

test('TRACK-21 equal head revision with a conflicting checksum preserves both records', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  const store = pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  const checkpoint = async () => JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result))
  expect((await checkpoint()).ok).toBe(true)
  const body = structuredClone(store.held.get(`s:${SESSION}`))
  const head = store.held.get(`h:${SESSION}`) as any
  const conflicting = { ...head, checkpoint: { ...head.checkpoint, checksum: '0'.repeat(64) } }
  store.held.set(`h:${SESSION}`, conflicting)
  const result = await checkpoint()
  expect(result.ok).toBe(false)
  expect(store.held.get(`s:${SESSION}`)).toEqual(body)
  expect(store.held.get(`h:${SESSION}`)).toEqual(conflicting)
})
