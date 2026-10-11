// FIXTURE, TRACK-21 refuter 5 (2026-10-11): a valid but mismatched cleanup
// journal must not lock its returning owner out; import must not create one.
import { expect, test } from 'claude-code/testing'
import { describeCheckpoint } from '../hooks/checkpoint'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'

const FOREIGN = '11111111-2222-4333-8444-555555555555'
const GEN = '22222222-3333-4444-8555-666666666666'

test('the returning owner archives a mismatched stamp journal and can save again', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  const savedLedger = { ...EMPTY, session_id: SESSION, nextQuestionId: 2, questions: [{ id: 1, head: 'kept history', at: 1, turnId: null, status: 'open' as const, session_id: SESSION }] }
  const cp = await describeCheckpoint(savedLedger, SESSION)
  const body = { v: 1, session_id: SESSION, generation: GEN, savedAt: 1, ledger: savedLedger, checkpoint: cp }
  const head = { v: 1, session_id: SESSION, generation: GEN, checkpoint: cp }
  const journal = { v: 1, session_id: SESSION, entries: [{ key: `h:${SESSION}`, missing: true, after: { v: 1, retentionOnly: true, session_id: SESSION, closedAt: 1 } }] }
  const store = pluginStore(on, { [`s:${SESSION}`]: body, [`h:${SESSION}`]: head, [`cleanup:${SESSION}`]: journal })
  on('session.id', () => ({ value: SESSION }))
  logs(on)
  const receipt = JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result))
  expect(receipt.ok).toBe(true)
  expect(store.held.has(`cleanup:${SESSION}`)).toBe(false)
  expect((store.held.get(`s:${SESSION}`) as any).ledger.questions.map((row: any) => row.head)).toEqual(['kept history'])
  const archives = [...store.held.entries()].filter(([key]) => key.startsWith(`r:${SESSION}:cleanup-conflict-`)).map(([, value]) => value as any)
  expect(archives).toHaveLength(1)
  expect(archives[0].value.recovery).toEqual(journal)
  expect(archives[0].value.values).toEqual([{ key: `h:${SESSION}`, value: head }])
})

test('import refuses a pending cleanup journal without changing source or destination', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  const source = { v: 1, savedAt: 1, ledger: EMPTY }
  const store = pluginStore(on, { [`s:${FOREIGN}`]: source }, undefined, { guardStates: { [FOREIGN]: 'closed' } })
  const files = new Map<string, string>()
  on('session.id', () => ({ value: SESSION }))
  on('fs.write', (_, e) => { files.set(e.path, String(e.text)); return { value: undefined } })
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  await $.command.run({ command: 'track', args: 'export /backup.json' })
  const bundle = files.get('/backup.json')
  store.held.delete(`s:${FOREIGN}`)
  const journal = { v: 1, session_id: FOREIGN, entries: [{ key: `h:${FOREIGN}`, missing: true, after: { v: 1, retentionOnly: true, session_id: FOREIGN, closedAt: 1 } }] }
  store.held.set(`cleanup:${FOREIGN}`, journal)
  const imported = JSON.parse((await $.command.run({ command: 'track', args: 'import /backup.json' })).text!)
  expect(imported.ok).toBe(false)
  expect(imported.reason).toContain('pending cleanup')
  expect(store.held.has(`s:${FOREIGN}`)).toBe(false)
  expect(store.held.has(`h:${FOREIGN}`)).toBe(false)
  expect(store.held.get(`cleanup:${FOREIGN}`)).toEqual(journal)
  expect(files.get('/backup.json')).toBe(bundle)
})
