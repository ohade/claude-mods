// FIXTURE: T31-2 receipts must name completed capacity deletions, even if the
// subsequent import fails. These tests use registered commands and save tools.
import { expect, mock, test } from 'claude-code/testing'
import { checksumOf, describeCheckpoint } from '../hooks/checkpoint'
import { EMPTY, SESSION, atomStore, blobPool, pluginStore, trackCommand } from './kit'
import type { Engine, On } from './kit'

const VICTIM = '00000000-0000-4000-8000-000000000001'
const TARGET = '00000000-0000-4000-8000-000000000002'
const LIVE = '00000000-0000-4000-8000-000000000003'
const OTHER_LIVE = '00000000-0000-4000-8000-000000000004'
const INCOMING = '00000000-0000-4000-8000-000000000005'
const BUNDLE = '/eviction-receipts.json'
const body = (session: string, padding = 0, savedAt = 1) => ({
  v: 1, session_id: session, savedAt,
  ledger: { ...EMPTY, session_id: session }, padding: 'p'.repeat(padding),
})

const fixture = async (on: On, options: { full?: boolean; victimLive?: boolean; checkpointPool?: true } = {}) => {
  const target = {
    ...body(TARGET, options.full ? 800000 : 0, 2),
    generation: '11111111-2222-4333-8444-555555555555',
    checkpoint: await describeCheckpoint({ ...EMPTY, session_id: TARGET }, TARGET),
  }
  const incoming = body(INCOMING)
  const records = [{ key: `s:${TARGET}`, value: target }, { key: `s:${INCOMING}`, value: incoming }]
  const checksum = await checksumOf(records)
  const source = JSON.stringify({ v: 1, source_identity: '/fixture-source', checksum, records })
  const initial: Record<string, unknown> = {
    cleanup: { v: 1, lastAttempt: Date.now(), cursor: '' },
    [`s:${SESSION}`]: body(SESSION),
    [`s:${TARGET}`]: { ...target, import_provenance: { source_identity: '/fixture-source', bundle_checksum: checksum, source_session: TARGET } },
    [`h:${TARGET}`]: { v: 1, session_id: TARGET, generation: target.generation, checkpoint: target.checkpoint },
  }
  if (options.full) {
    initial[`s:${VICTIM}`] = body(VICTIM, 800000)
    initial[`s:${LIVE}`] = body(LIVE, 800000, 3)
    initial[`s:${OTHER_LIVE}`] = body(OTHER_LIVE, 800000, 4)
  }
  initial.saved = Object.fromEntries(Object.entries(initial).filter(([key]) => key.startsWith('s:')).map(([key]) => [key.slice(2), { at: 1, bytes: 800100, unfinished: false }]))
  const states: Record<string, 'live' | 'closed'> = {
    [VICTIM]: options.victimLive ? 'live' : 'closed', [TARGET]: 'closed', [INCOMING]: 'closed', [LIVE]: 'live', [OTHER_LIVE]: 'live',
  }
  atomStore(on, 'ledger', EMPTY)
  if (!options.checkpointPool) mock.env(on, { CLAUDE_CONFIG_DIR: '/fixture/config' })
  const store = pluginStore(on, initial, undefined, { guardStates: states })
  const history = Object.entries(initial).filter(([key]) => key.startsWith('s:') || key.startsWith('h:')).map(([key, value]) => [key, JSON.stringify(value)] as const)
  const files = new Map([[BUNDLE, source]])
  const toasts: string[] = []
  on('session.id', () => ({ value: SESSION }))
  if (options.checkpointPool) {
    on('fs.read', { path: /^(?!\/fixture\/config\/state\/track\/blobs\/[0-9a-f]{64}\.json$)/ }, (_, e) => ({ value: files.get(e.path) ?? '' }))
  } else {
    on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  }
  on('fs.write', (_, e) => { files.set(e.path, String(e.text)); return { value: undefined } })
  on('ui.toast', (_, e) => { toasts.push(String(e.text)); return { value: undefined } })
  const pool = options.checkpointPool ? blobPool(on, { files }) : undefined
  return { store, history, files, source, toasts, pool }
}

const importReceipt = async ($: Engine) => JSON.parse((await trackCommand($, `import ${BUNDLE}`)).text!)
const evictionToasts = (toasts: string[]) => toasts.filter(text => /evict/i.test(text))

test('TRACK-31 successful import names the completed victim and preserves protected history and source bytes', async ($, on) => {
  const { store, history, files, source, toasts } = await fixture(on, { full: true })
  const receipt = await importReceipt($)
  expect(receipt.ok).toBe(true)
  expect(receipt.imported).toEqual([INCOMING])
  expect(receipt.verified).toEqual([TARGET, INCOMING])
  expect(store.held.has(`s:${VICTIM}`)).toBe(false)
  for (const [key, bytes] of history.filter(([key]) => key !== `s:${VICTIM}`)) expect(JSON.stringify(store.held.get(key))).toBe(bytes)
  expect(files.get(BUNDLE)).toBe(source)
  expect((store.held.get(`s:${INCOMING}`) as { session_id: string }).session_id).toBe(INCOMING)
  expect(receipt.evicted).toEqual([VICTIM])
  expect(evictionToasts(toasts)).toHaveLength(1)
  expect(evictionToasts(toasts)[0]).toContain(VICTIM)
  expect(evictionToasts(toasts)[0]).toContain('closed history')
  expect(evictionToasts(toasts)[0]).toContain('make room')
})

test('TRACK-31 import with enough room reports no eviction and emits no eviction toast', async ($, on) => {
  const { store, toasts } = await fixture(on)
  const receipt = await importReceipt($)
  expect(receipt.ok).toBe(true)
  expect(receipt.imported).toEqual([INCOMING])
  expect(store.held.has(`s:${INCOMING}`)).toBe(true)
  expect(evictionToasts(toasts)).toEqual([])
  expect(receipt.evicted).toEqual([])
})

test('TRACK-31 failed import still names a victim deleted before the target write failed', async ($, on) => {
  on('store.set', { key: `s:${INCOMING}` }, () => ({ deny: 'injected import target write failure' }))
  const { store, history, toasts, files, source } = await fixture(on, { full: true })
  const receipt = await importReceipt($)
  expect(receipt.ok).toBe(false)
  expect(receipt.reason).toContain('injected import target write failure')
  expect(store.held.has(`s:${VICTIM}`)).toBe(false)
  expect(store.held.has(`s:${INCOMING}`)).toBe(false)
  for (const [key, bytes] of history.filter(([key]) => key !== `s:${VICTIM}`)) expect(JSON.stringify(store.held.get(key))).toBe(bytes)
  expect(files.get(BUNDLE)).toBe(source)
  expect(receipt.evicted).toEqual([VICTIM])
  expect(evictionToasts(toasts)).toHaveLength(1)
  expect(evictionToasts(toasts)[0]).toContain(VICTIM)
})

test('TRACK-31 saved-index failure cannot hide an already completed eviction', async ($, on) => {
  on('store.set', { key: 'saved' }, () => ({ deny: 'injected saved-index failure' }))
  const { store, toasts } = await fixture(on, { full: true })
  const receipt = await importReceipt($)
  expect(receipt.ok).toBe(false)
  expect(receipt.reason).toContain('injected saved-index failure')
  expect(store.held.has(`s:${VICTIM}`)).toBe(false)
  expect(receipt.evicted).toEqual([VICTIM])
  expect(evictionToasts(toasts)).toHaveLength(1)
  expect(evictionToasts(toasts)[0]).toContain(VICTIM)
})

test('TRACK-31 failed victim deletion emits no completed eviction receipt or toast', async ($, on) => {
  on('store.delete', { key: `s:${VICTIM}` }, () => ({ deny: 'injected victim body delete failure' }))
  const { store, history, toasts, files, source } = await fixture(on, { full: true })
  const receipt = await importReceipt($)
  expect(receipt.ok).toBe(false)
  expect(receipt.evicted).toEqual([])
  expect(evictionToasts(toasts)).toEqual([])
  expect(JSON.stringify(store.held.get(`s:${VICTIM}`))).toBe(history.find(([key]) => key === `s:${VICTIM}`)![1])
  expect(store.held.has(`s:${INCOMING}`)).toBe(false)
  expect(files.get(BUNDLE)).toBe(source)
})

test('TRACK-31 checkpoint visibly names its completed eviction exactly once', async ($, on) => {
  const { store, history, toasts, pool, files, source } = await fixture(on, { full: true, checkpointPool: true })
  expect(pool).toBeDefined()
  const original = JSON.parse(history.find(([key]) => key === `s:${TARGET}`)![1])
  const originalSaved = { ...(store.held.get('saved') as Record<string, Record<string, unknown>>)[TARGET] }
  const expectedText = JSON.stringify(original.ledger)
  const expectedRef = { checksum: await checksumOf(original.ledger), bytes: new TextEncoder().encode(expectedText).byteLength }
  const expectedPointer = Object.fromEntries(Object.entries(original).map(([key, value]) =>
    key === 'v' ? [key, 2] : key === 'ledger' ? ['ledger_blob', expectedRef] : [key, value]))
  const inlineBytes = new TextEncoder().encode(JSON.stringify({ [`s:${TARGET}`]: original })).byteLength
  const pointerBytes = new TextEncoder().encode(JSON.stringify({ [`s:${TARGET}`]: expectedPointer })).byteLength
  expect(pointerBytes - inlineBytes).toBe(-21)
  const receipt = JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result))
  expect(receipt.ok).toBe(true)
  expect(store.held.has(`s:${VICTIM}`)).toBe(false)
  for (const [key, bytes] of history.filter(([key]) => key !== `s:${VICTIM}` && key !== `s:${SESSION}` && key !== `s:${TARGET}`)) expect(JSON.stringify(store.held.get(key)) === bytes).toBe(true)
  expect(JSON.stringify(store.held.get(`s:${TARGET}`)) === JSON.stringify(expectedPointer)).toBe(true)
  expect(Object.hasOwn(store.held.get(`s:${TARGET}`) as object, 'ledger')).toBe(false)
  const storedText = files.get(`/fixture/config/state/track/blobs/${expectedRef.checksum}.json`)
  expect(storedText).toBe(expectedText)
  expect(await checksumOf(JSON.parse(storedText!))).toBe(expectedRef.checksum)
  expect(new TextEncoder().encode(storedText).byteLength).toBe(expectedRef.bytes)
  expect(JSON.stringify(await pool!.logical(store, `s:${TARGET}`)) === JSON.stringify(original)).toBe(true)
  const saved = store.held.get('saved') as Record<string, unknown>
  expect(saved[TARGET]).toEqual({ ...originalSaved, bytes: pointerBytes + 1 })
  expect(Object.keys(saved).sort()).toEqual([SESSION, TARGET, LIVE, OTHER_LIVE].sort())
  const sizes = (store.held.get('capacitySizes') as { sizes: Record<string, number> }).sizes
  expect(Object.hasOwn(sizes, `s:${VICTIM}`)).toBe(false)
  expect(sizes[`s:${TARGET}`]).toBe(pointerBytes - 2)
  expect(files.get(BUNDLE) === source).toBe(true)
  expect(evictionToasts(toasts)).toHaveLength(1)
  expect(evictionToasts(toasts)[0]).toContain(VICTIM)
  expect(evictionToasts(toasts)[0]).toContain('closed history')
  expect(evictionToasts(toasts)[0]).toContain('make room')
  const rawOwnSave = store.held.get(`s:${SESSION}`) as { v?: number } | undefined
  expect(rawOwnSave?.v).toBe(2)
  expect(Object.hasOwn(rawOwnSave!, 'ledger')).toBe(false)
  expect((await pool!.logical(store, `s:${SESSION}`) as { ledger: unknown }).ledger).toEqual({ ...EMPTY, session_id: SESSION })
})

test('TRACK-31 a protected and live-only full store reports no eviction and preserves every history byte', async ($, on) => {
  const { store, history, toasts, files, source } = await fixture(on, { full: true, victimLive: true })
  const receipt = await importReceipt($)
  expect(receipt.ok).toBe(false)
  expect(receipt.reason).toContain('capacity:')
  for (const [key, bytes] of history) expect(JSON.stringify(store.held.get(key))).toBe(bytes)
  expect(files.get(BUNDLE)).toBe(source)
  expect(evictionToasts(toasts)).toEqual([])
  expect(receipt.evicted).toEqual([])
})
