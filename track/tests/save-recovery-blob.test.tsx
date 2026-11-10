// FIXTURE: a failed v:2 save whose rollback is refused stays pending; the next resume retries it. These
// cases damage the previous blob file in between. Real handlers, store and blob pool in memory.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, TX_REQUEST, atomStore, blobPool, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'
import { describeCheckpoint } from '../hooks/checkpoint'
import type { Ledger } from '../types'

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000501'
const BLOBS = '/fixture/config/state/track/blobs'
const GENERATION = '99999999-8888-4777-8666-555555555555'
const encoder = new TextEncoder()
const sha256 = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))), b => b.toString(16).padStart(2, '0')).join('')
const checkpoint = async ($: Engine) =>
  JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: ID } as never)).result ?? '{}'))

const saved: Ledger = {
  v: 1, nextQuestionId: 1, prompts: [], questions: [], session_id: ID,
  steps: [{ id: 'plan:1', source: 'plan', subject: 'Continue the work', status: 'in_progress', startedAt: 2, activeTurnId: 'saved-turn', session_id: ID }],
}

// The session was saved as a v:2 pointer. A later save (memory has one more row) is written, then
// throws, and the rollback of its body is refused once, so the recovery record stays in memory.
const pendingRecovery = async ($: Engine, on: On) => {
  const text = JSON.stringify(saved)
  const ref = { checksum: await sha256(text), bytes: encoder.encode(text).length }
  const oldPath = `${BLOBS}/${ref.checksum}.json`
  const files = new Map([[oldPath, text]])
  const stamp = await describeCheckpoint(saved, ID)
  const pointer = { v: 2, session_id: ID, generation: GENERATION, savedAt: 1000, ledger_blob: ref, checkpoint: stamp }
  const head = { v: 1, session_id: ID, generation: GENERATION, checkpoint: stamp }
  const controls = { failKey: '', refuseRollbackKey: '' }
  mock.clock(on)
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/fixture/config' : undefined }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)

    return text === undefined ? { deny: `ENOENT: missing blob ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e, next) => TX_REQUEST.test(e.path) ? next(e) : { value: undefined })
  const pool = blobPool(on, { files, readProviders: 'external' })
  on('store.set', { key: /^(?:s:|h:|saved$)/ }, async (_, e, next) => {
    if (e.key === controls.refuseRollbackKey && controls.failKey === '') {
      controls.refuseRollbackKey = ''
      return { deny: `fixture refused rollback ${e.key}` }
    }
    const result = await next(e)
    if (result.deny !== undefined || e.key !== controls.failKey) return result
    controls.failKey = ''

    return { deny: `fixture applied-then-threw ${e.key}` }
  })
  const memory = atomStore<Ledger>(on, 'ledger', { ...EMPTY, session_id: ID })
  atomStore(on, 'turn', { currentId: 'saved-turn', gatedTurnId: null, eventOrder: 0 })
  const durability = atomStore(on, 'durability', { isUnsaved: false, reason: '', memorySession: ID })
  on('session.id', () => ({ value: ID }))
  on('classic.SessionStart', () => ({}))
  const store = pluginStore(on, { [`s:${ID}`]: pointer, [`h:${ID}`]: head, saved: { [ID]: { at: 1000, bytes: 1, unfinished: true } } })
  const lines = logs(on)
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  memory.value = { ...saved, steps: [...saved.steps, { id: 'plan:2', source: 'plan', subject: 'Added later', status: 'pending', session_id: ID }] }
  controls.failKey = `s:${ID}`
  controls.refuseRollbackKey = `s:${ID}`
  const failed = await checkpoint($)
  expect(failed.ok).toBe(false)
  expect(failed.reason).toContain('recovery pending')
  const attempted = JSON.stringify(store.held.get(`s:${ID}`))
  expect(attempted).not.toBe(JSON.stringify(pointer))

  return { files, oldPath, oldText: text, pointer, attempted, store, durability, lines, pool }
}

test('rollback publishes the previous blob again when its file is gone, then restores the old pointer', async ($, on) => {
  const f = await pendingRecovery($, on)
  f.files.delete(f.oldPath)
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  expect(f.files.get(f.oldPath)).toBe(f.oldText)
  expect(JSON.stringify(f.store.held.get(`s:${ID}`))).toBe(JSON.stringify(f.pointer))
})

test('rollback keeps a previous blob file that no longer matches and leaves the attempted pointer in place', async ($, on) => {
  const f = await pendingRecovery($, on)
  f.files.set(f.oldPath, `${f.oldText} damaged`)
  const publishes = f.pool.publishes
  await $.classic.SessionStart({ source: 'resume', session_id: ID })
  expect(f.files.get(f.oldPath)).toBe(`${f.oldText} damaged`)
  expect(f.pool.publishes).toBe(publishes)
  expect(JSON.stringify(f.store.held.get(`s:${ID}`))).toBe(f.attempted)
  expect(f.durability.value.isUnsaved).toBe(true)
  expect(f.durability.value.reason).toContain('previous blob changed or invalid; existing file was kept')
})
