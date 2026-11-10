// FIXTURE: the save journal's failure messages, driven through commitSave and rollbackSave with an
// in-memory store. Each message names one distinct failure a person sees as the unsaved reason.
import { expect, test } from 'claude-code/testing'
import { commitSave, rollbackSave } from '../hooks/save-journal'
import type { SaveJournal, SaveRecovery, SaveWrite } from '../hooks/save-journal'
import type { SessionHead } from '../hooks/durable-record'

// A journal over a Map.
const journalOver = (seed: Array<[string, unknown]>) => {
  const store = new Map<string, unknown>(seed)
  const journal: SaveJournal = {
    read: async key => store.get(key),
    keys: async () => [...store.keys()],
    set: async (key, value) => { store.set(key, value) },
    delete: async key => { store.delete(key) },
    writeVerified: async (key, value) => { store.set(key, value) },
    taint: () => {},
    restoreBlob: async () => {},
  }

  return { journal, store }
}

// The same journal, except the nth read of `key` (counting from 1) returns `value` instead.
const nthReadReturns = (journal: SaveJournal, key: string, nth: number, value: unknown): SaveJournal => {
  let reads = 0

  return { ...journal, read: async k => (k === key && ++reads === nth ? value : journal.read(k)) }
}

const head = { v: 1, session_id: 'x', generation: 'g2', checkpoint: {} } as unknown as SessionHead
const previousHead = { v: 1, session_id: 'x', generation: 'g1', checkpoint: {} }
const previous = { savedAt: 1 }
const bucket = { savedAt: 5, note: 'attempt' }
const previousIndex = { x: { at: 1, bytes: 30 } }
const index = { x: { at: 5, bytes: 40 } }
const write: SaveWrite = { previous, previousBlobText: undefined, bucket, previousHead, head, index }
const recovery = (overrides: Partial<SaveRecovery> = {}): SaveRecovery =>
  ({ previous, previousBlobText: undefined, bucket, previousHead, head, previousIndex, index, ...overrides })

test('a body that reads back different from what was written is refused', async () => {
  const { journal } = journalOver([['saved', previousIndex]])
  const lying = nthReadReturns(journal, 's:x', 1, { savedAt: 99 })
  await expect(commitSave(lying, new Map(), 'x', write)).rejects.toThrow('save read-back did not match the acknowledged ledger')
})

test('an index that reads back different from what was written is refused', async () => {
  const { journal } = journalOver([['saved', previousIndex]])
  const lying = nthReadReturns(journal, 'saved', 2, { x: { at: 5, bytes: 41 } })
  await expect(commitSave(lying, new Map(), 'x', write)).rejects.toThrow('save index read-back did not match')
})

test('rollback keeps a body another writer changed and says the session must be reloaded', async () => {
  const { journal, store } = journalOver([['s:x', { savedAt: 77 }], ['h:x', head], ['saved', index]])
  const map = new Map([['x', recovery()]])
  await expect(rollbackSave(journal, map, 'x')).rejects.toThrow('save recovery kept a changed durable ledger; reload this session before writing')
  expect(store.get('s:x')).toEqual({ savedAt: 77 })
  expect(map.has('x')).toBe(true)
})

test('rollback refuses a body whose restored value does not read back', async () => {
  const { journal } = journalOver([['s:x', bucket], ['h:x', previousHead], ['saved', previousIndex]])
  const lying = nthReadReturns(journal, 's:x', 2, { savedAt: 3 })
  await expect(rollbackSave(lying, new Map([['x', recovery()]]), 'x')).rejects.toThrow('save recovery read-back did not match the prior ledger')
})

test('rollback keeps a head another writer changed', async () => {
  const { journal } = journalOver([['s:x', previous], ['h:x', { v: 1, session_id: 'x', generation: 'g9', checkpoint: {} }], ['saved', previousIndex]])
  const map = new Map([['x', recovery()]])
  await expect(rollbackSave(journal, map, 'x')).rejects.toThrow('save recovery kept a changed durable head')
  expect(map.has('x')).toBe(true)
})

test('rollback refuses an index whose rebuilt value does not read back', async () => {
  const { journal } = journalOver([['s:x', previous], ['h:x', previousHead], ['saved', index]])
  const lying = nthReadReturns(journal, 'saved', 2, { x: { at: 0, bytes: 0 } })
  await expect(rollbackSave(lying, new Map([['x', recovery()]]), 'x')).rejects.toThrow('save recovery could not verify the rebuilt index')
})
