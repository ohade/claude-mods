// FIXTURE: TRACK-35 U2b. Before eviction, a write past the store budget converts other CLOSED
// sessions' v:1 inline bodies to v:2 pointers (ledger text in a verified blob), largest first,
// deleting nothing. Eviction runs unchanged only when compaction cannot make room.
import { expect, test } from 'claude-code/testing'
import { EMPTY, atomStore, logs, pluginStore, trackCommand } from './kit'
import type { Engine, On } from './kit'
import { describeCheckpoint, checksumOf } from '../hooks/checkpoint'
import { ensureCapacity } from '../hooks/retention'
import type { RetentionStore } from '../hooks/retention'
import { entryBytes } from '../hooks/size-index'

const CONFIG = '/fixture/config'
const BLOBS = `${CONFIG}/state/track/blobs`
const GENERATION = '99999999-8888-4777-8666-555555555555'
const UNCERTAIN = 'in an uncertain state'
const encoder = new TextEncoder()
const utf8 = (text: string) => encoder.encode(text).length
// One id family per test, so no module state carries a revision from one test into another.
const idOf = (family: number, n: number) => `cccccccc-0000-4000-8000-${String(family * 100 + n).padStart(12, '0')}`
const callerOf = (family: number) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(family).padStart(12, '0')}`
const sha256 = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))), b => b.toString(16).padStart(2, '0')).join('')

const ledgerOf = (session: string, pad: number) => ({
  v: 1, nextQuestionId: 2, prompts: [],
  questions: [{ id: 1, head: 'Closed question', at: 1, turnId: 'old', status: 'deferred', note: 'n'.repeat(pad), session_id: session }],
  steps: [{ id: 'plan:1', subject: 'Closed step', source: 'plan', status: 'in_progress', session_id: session }],
  session_id: session,
})

const durable = async (session: string, pad: number, savedAt: number) => {
  const ledger = ledgerOf(session, pad)
  const checkpoint = await describeCheckpoint(ledger as never, session)
  return {
    body: { v: 1, session_id: session, generation: GENERATION, savedAt, ledger, checkpoint } as Record<string, unknown>,
    head: { v: 1, session_id: session, generation: GENERATION, checkpoint },
  }
}

// The v:2 body compaction must write: every key mapped in place, `ledger` -> `ledger_blob`.
const pointerOf = async (body: Record<string, unknown>) => {
  const text = JSON.stringify(body.ledger)
  const blob = { checksum: await sha256(text), bytes: utf8(text) }
  return { text, blob, pointer: Object.fromEntries(Object.entries(body).map(([key, value]) =>
    key === 'v' ? [key, 2] : key === 'ledger' ? ['ledger_blob', blob] : [key, value])) }
}
// Big values compare by length and SHA-256, so a failure report stays small.
const print = async (value: unknown) => value === undefined ? 'absent' : `${JSON.stringify(value).length}:${await sha256(JSON.stringify(value))}`
const rawBytes = (key: string, value: unknown) => utf8(JSON.stringify({ [key]: value })) + 1

// Four CLOSED sessions, 3.2 MB of ledger text against the 3 MiB budget. `big` holds the most
// bytes; `oldest` is what eviction alone would delete.
const PADS = [950000, 800000, 750000, 700000]
const AGES = [3000, 4000, 2000, 1000]
const prefill = async (family: number) => {
  const sessions = PADS.map((_, n) => idOf(family, n + 1))
  const records: Record<string, unknown> = { cleanup: { v: 1, lastAttempt: Date.now(), cursor: '' } }
  const saved: Record<string, unknown> = {}
  const bodies: Record<string, Record<string, unknown>> = {}
  const states: Record<string, 'live' | 'closed'> = {}
  for (const [n, session] of sessions.entries()) {
    const { body, head } = await durable(session, PADS[n]!, AGES[n]!)
    bodies[session] = body
    records[`s:${session}`] = body
    records[`h:${session}`] = head
    saved[session] = { at: AGES[n]!, bytes: rawBytes(`s:${session}`, body), unfinished: true }
    states[session] = 'closed'
  }
  records.saved = saved
  const [big, second, , oldest] = sessions as [string, string, string, string]
  return { sessions, records, bodies, states, big, second, oldest }
}

type Fault = 'exit' | 'truncated' | 'receipt' | 'mismatch' | 'throw'
const setup = (on: On, caller: string, records: Record<string, unknown>, files: Map<string, string>, options: { states?: Record<string, 'live' | 'closed'>; helper?: false; config?: false; fault?: (checksum: string) => Fault | undefined; refuseSet?: (key: string, value: unknown) => string | undefined } = {}) => {
  const l = atomStore<any>(on, 'ledger', { v: 1, nextQuestionId: 1, prompts: [], questions: [], steps: [] })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on, records, undefined, { guardStates: options.states, refuseSet: options.refuseSet })
  const lines = logs(on)
  const published: string[] = []
  on('session.id', () => ({ value: caller }))
  on('env.get', (_, e) => ({ value: options.config !== false && e.name === 'CLAUDE_CONFIG_DIR' ? CONFIG : undefined }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT: no such file: ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => { files.set(e.path, String(e.text)); return { value: undefined } })
  if (options.helper !== false) on('process.run', { argv: /blob-fs\.py$/ }, async (_, e) => {
    expect(e.argv.length).toBe(5)
    expect(e.argv[0]).toBe('python3')
    expect(e.argv[1]).toMatch(/\/hooks\/blob-fs\.py$/)
    expect(e.argv.slice(2, 4)).toEqual(['publish', BLOBS])
    const text = String(e.init?.stdin ?? '')
    const checksum = e.argv[4]!
    expect(await sha256(text)).toBe(checksum)
    published.push(checksum)
    const fault = options.fault?.(checksum)
    if (fault === 'throw') throw new Error('helper unavailable')
    const path = `${BLOBS}/${checksum}.json`
    const existing = files.get(path)
    const answer = (exitCode: number, stdout: string, truncated = false) =>
      ({ value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'refused', isStdoutTruncated: truncated, isStderrTruncated: false } })
    // The real helper's no-clobber rule: a differing existing blob is refused and kept.
    if (fault === 'exit' || (existing !== undefined && existing !== text)) return answer(1, '')
    files.set(path, fault === 'mismatch' ? `${text.slice(0, -1)} ` : text)
    const receipt = fault === 'receipt' ? { ok: true, checksum: '0'.repeat(64), bytes: 1 } : { ok: true, checksum, bytes: utf8(text) }
    return answer(0, `${JSON.stringify(receipt)}\n`, fault === 'truncated')
  })
  return { l, store, lines, published }
}

const checkpoint = async ($: Engine, id: string) =>
  JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: id } as never)).result ?? '{}'))
const command = async ($: Engine, args: string) => JSON.parse((await trackCommand($, args)).text ?? '{}')

test('TRACK-35 U2b an over-budget save compacts the largest CLOSED body and evicts nothing', async ($, on) => {
  const caller = callerOf(1)
  const { sessions, records, bodies, states, big } = await prefill(1)
  const files = new Map<string, string>()
  const { store, lines } = setup(on, caller, records, files, { states })
  const result = await checkpoint($, caller)
  expect(result.reason).toBeUndefined()
  expect(result.ok).toBe(true)
  const expectedLedger = { ...EMPTY, session_id: caller }
  const ownText = JSON.stringify(expectedLedger)
  const ownRef = { checksum: await sha256(ownText), bytes: utf8(ownText) }
  const own = store.held.get(`s:${caller}`) as { v: number; ledger_blob?: unknown }
  expect(own.v).toBe(2)
  expect(Object.hasOwn(own, 'ledger')).toBe(false)
  expect(own.ledger_blob).toEqual(ownRef)
  const publishedOwnText = files.get(`${BLOBS}/${ownRef.checksum}.json`)!
  expect(publishedOwnText).toBe(ownText)
  expect({ checksum: await sha256(publishedOwnText), bytes: utf8(publishedOwnText) }).toEqual(ownRef)
  expect(lines.filter(line => line.includes('was evicted'))).toEqual([])
  const { text, blob, pointer } = await pointerOf(bodies[big]!)
  expect(await print(store.held.get(`s:${big}`))).toBe(await print(pointer))
  expect(await print(files.get(`${BLOBS}/${blob.checksum}.json`))).toBe(await print(text))
  for (const session of sessions.filter(session => session !== big)) {
    expect({ session, body: await print(store.held.get(`s:${session}`)) }).toEqual({ session, body: await print(bodies[session]) })
  }
  for (const session of sessions) expect(await print(store.held.get(`h:${session}`))).toBe(await print(records[`h:${session}`]))
  // Item 4: the compacted session's index entry is its raw v:2 size; `at` and `unfinished` are kept.
  const index = store.held.get('saved') as Record<string, unknown>
  expect(index[big]).toEqual({ at: AGES[0], bytes: rawBytes(`s:${big}`, pointer), unfinished: true })
  // Item 7: capacity counts the pointer's own bytes.
  const sizes = (store.held.get('capacitySizes') as { sizes: Record<string, number> }).sizes
  expect(sizes[`s:${big}`]).toBe(entryBytes(`s:${big}`, pointer))
  // U2a's logical view of every session is unchanged, byte for byte.
  const exported = await command($, 'export /backup.json')
  expect(exported.reason).toBeUndefined()
  const bundle = JSON.parse(files.get('/backup.json') ?? '{}') as { records: Array<{ key: string; value: unknown }> }
  for (const session of sessions) {
    const record = bundle.records.find(entry => entry.key === `s:${session}`)
    expect({ session, value: await print(record?.value) }).toEqual({ session, value: await print(bodies[session]) })
  }
})

test('TRACK-35 U2b an applied pointer write whose read-back fails counts as compacted', async ($, on) => {
  const caller = callerOf(2)
  const { sessions, records, bodies, states, big } = await prefill(2)
  const files = new Map<string, string>()
  const { store, lines } = setup(on, caller, records, files, { states })
  store.faults.mismatchAfterSet = `s:${big}`
  const result = await checkpoint($, caller)
  expect(result.reason).toBeUndefined()
  expect(result.ok).toBe(true)
  expect(lines.filter(line => line.includes('was evicted'))).toEqual([])
  for (const session of sessions) expect(store.held.has(`s:${session}`)).toBe(true)
  const { pointer } = await pointerOf(bodies[big]!)
  expect(await print(store.held.get(`s:${big}`))).toBe(await print(pointer))
  const exported = await command($, 'export /backup.json')
  expect(exported.reason).toBeUndefined()
  const bundle = JSON.parse(files.get('/backup.json') ?? '{}') as { records: Array<{ key: string; value: unknown }> }
  expect(await print(bundle.records.find(entry => entry.key === `s:${big}`)?.value)).toBe(await print(bodies[big]))
})

test('TRACK-35 U2b an altered value after the pointer write fails the save closed and keeps the evidence', async ($, on) => {
  const caller = callerOf(3)
  const { sessions, records, bodies, states, big } = await prefill(3)
  const files = new Map<string, string>()
  const { store, lines } = setup(on, caller, records, files, { states })
  store.faults.alteredAfterSet = `s:${big}`
  const result = await checkpoint($, caller)
  expect(result.ok).toBe(false)
  expect(String(result.reason)).toContain(`compaction left ${big} ${UNCERTAIN}`)
  expect(lines.filter(line => line.includes('was evicted'))).toEqual([])
  for (const session of sessions) expect(store.held.has(`s:${session}`)).toBe(true)
  for (const session of sessions) expect(store.held.has(`cleanup:${session}`)).toBe(false)
  const { pointer } = await pointerOf(bodies[big]!)
  expect(await print(store.held.get(`s:${big}`))).toBe(await print({ ...pointer, changedByStore: true }))
  expect(store.held.has(`s:${caller}`)).toBe(false)
})

test('TRACK-35 U2b a post-crash v:2 session resumes on a fresh load and the next over-budget save repairs the size index', async ($, on) => {
  const caller = callerOf(4)
  const { sessions, records, bodies, states } = await prefill(4)
  const own = await durable(caller, 200, 500)
  const { text, blob, pointer } = await pointerOf(own.body)
  const files = new Map<string, string>([[`${BLOBS}/${blob.checksum}.json`, text]])
  const staleBytes = rawBytes(`s:${caller}`, own.body)
  const crashed = {
    ...records,
    [`s:${caller}`]: pointer,
    [`h:${caller}`]: own.head,
    saved: { ...records.saved as object, [caller]: { at: 500, bytes: staleBytes, unfinished: true } },
    capacitySizes: { v: 1, sizes: { [`s:${caller}`]: staleBytes - 1 }, pending: `s:${caller}` },
  }
  const { l, store, lines } = setup(on, caller, crashed, files, { states })
  const result = await checkpoint($, caller)
  expect(result.reason).toBeUndefined()
  expect(result.ok).toBe(true)
  expect(l.value.questions.map((q: { head: string }) => q.head)).toEqual(['Closed question'])
  expect(l.value.steps.map((s: { subject: string }) => s.subject)).toEqual(['Closed step'])
  expect(lines.filter(line => line.includes('was evicted'))).toEqual([])
  for (const session of sessions) expect(store.held.has(`s:${session}`)).toBe(true)
  expect((store.held.get(`s:${sessions[0]!}`) as { v: number }).v).toBe(2)
  const index = store.held.get('capacitySizes') as { sizes: Record<string, number>; pending?: string }
  expect(index.pending).toBeUndefined()
  for (const [key, value] of store.held) if (key !== 'capacitySizes') expect({ key, bytes: index.sizes[key] }).toEqual({ key, bytes: entryBytes(key, value) })
  expect(await print(store.held.get(`s:${sessions[1]!}`))).toBe(await print(bodies[sessions[1]!]))
})

test('TRACK-35 U2b a refused pointer write keeps the v:1 body and eviction runs as today', async ($, on) => {
  const caller = callerOf(5)
  const { sessions, records, bodies, states, oldest } = await prefill(5)
  const files = new Map<string, string>()
  const refuseSet = (key: string, value: unknown) => key.startsWith('s:') && key !== `s:${caller}` && (value as { v?: unknown }).v === 2 ? 'pointer write refused' : undefined
  const { store, lines, published } = setup(on, caller, records, files, { states, refuseSet })
  const result = await checkpoint($, caller)
  expect(result.reason).toBeUndefined()
  expect(result.ok).toBe(true)
  expect(published.length).toBeGreaterThan(0)
  for (const session of sessions.filter(session => session !== oldest)) {
    expect(lines.some(line => line.startsWith(`track: compaction keeps ${session}: `))).toBe(true)
    expect(await print(store.held.get(`s:${session}`))).toBe(await print(bodies[session]))
  }
  expect(store.held.has(`s:${oldest}`)).toBe(false)
  expect(lines.some(line => line.includes(`session ${oldest} was evicted`))).toBe(true)
})

test('TRACK-35 U2b a damaged or differing blob is never overwritten and a v:2 body is never a source', async ($, on) => {
  const caller = callerOf(6)
  const { records, bodies, states, big, second, sessions, oldest } = await prefill(6)
  const third = sessions[2]!
  const files = new Map<string, string>()
  const target = await pointerOf(bodies[big]!)
  files.set(`${BLOBS}/${target.blob.checksum}.json`, 'damaged')
  // A v:2 body whose own bytes rank it first: it is skipped, never re-published.
  const extra = idOf(6, 9)
  const kept = await durable(extra, 100, 100)
  const damaged = await pointerOf({ ...kept.body, padding: 'q'.repeat(960000) })
  files.set(`${BLOBS}/${damaged.blob.checksum}.json`, 'also damaged')
  const before = new Map(files)
  const { store, lines, published } = setup(on, caller, { ...records, [`s:${extra}`]: damaged.pointer, [`h:${extra}`]: kept.head }, files, { states: { ...states, [extra]: 'closed' } })
  const result = await checkpoint($, caller)
  expect(result.reason).toBeUndefined()
  expect(result.ok).toBe(true)
  expect(lines.some(line => line.startsWith(`track: compaction keeps ${big}: `))).toBe(true)
  expect(await print(store.held.get(`s:${big}`))).toBe(await print(bodies[big]))
  expect(await print(store.held.get(`s:${extra}`))).toBe(await print(damaged.pointer))
  for (const [path, text] of before) expect({ path, text: files.get(path) }).toEqual({ path, text })
  expect(published).not.toContain(damaged.blob.checksum)
  for (const session of [second, third]) expect(await print(store.held.get(`s:${session}`))).toBe(await print((await pointerOf(bodies[session]!)).pointer))
  expect(await print(store.held.get(`s:${oldest}`))).toBe(await print(bodies[oldest]))
  expect(lines.filter(line => line.includes('was evicted'))).toEqual([])
})

test('TRACK-35 U2b a live session is never compacted', async ($, on) => {
  const caller = callerOf(7)
  const { records, bodies, states, big, second } = await prefill(7)
  const files = new Map<string, string>()
  const { store, lines } = setup(on, caller, records, files, { states: { ...states, [big]: 'live' } })
  const result = await checkpoint($, caller)
  expect(result.reason).toBeUndefined()
  expect(result.ok).toBe(true)
  expect(await print(store.held.get(`s:${big}`))).toBe(await print(bodies[big]))
  expect(await print(store.held.get(`s:${second}`))).toBe(await print((await pointerOf(bodies[second]!)).pointer))
  expect(lines.filter(line => line.includes('was evicted'))).toEqual([])
})

for (const fault of ['exit', 'truncated', 'receipt', 'mismatch'] as const) test(`TRACK-35 U2b a helper ${fault} keeps that v:1 body and compacts the next candidate`, async ($, on) => {
  const family = 10 + ['exit', 'truncated', 'receipt', 'mismatch'].indexOf(fault)
  const caller = callerOf(family)
  const { sessions, records, bodies, states, big, second } = await prefill(family)
  const files = new Map<string, string>()
  const bad = (await pointerOf(bodies[big]!)).blob.checksum
  const { store, lines } = setup(on, caller, records, files, { states, fault: checksum => checksum === bad ? fault : undefined })
  const result = await checkpoint($, caller)
  expect(result.reason).toBeUndefined()
  expect(result.ok).toBe(true)
  expect(lines.some(line => line.startsWith(`track: compaction keeps ${big}: `))).toBe(true)
  expect(await print(store.held.get(`s:${big}`))).toBe(await print(bodies[big]))
  expect(await print(store.held.get(`s:${second}`))).toBe(await print((await pointerOf(bodies[second]!)).pointer))
  for (const session of sessions) expect(store.held.has(`s:${session}`)).toBe(true)
})

for (const missing of ['helper', 'config'] as const) test(`TRACK-35 U2b unavailable own blob storage (${missing}) refuses a non-fitting inline save without compaction or eviction`, async ($, on) => {
  const family = 20 + (missing === 'helper' ? 0 : 1)
  const caller = callerOf(family)
  const { sessions, records, bodies, states } = await prefill(family)
  const files = new Map<string, string>()
  const { store, lines, published } = setup(on, caller, records, files, { states, ...(missing === 'helper' ? { helper: false } : { config: false }) })
  const result = await checkpoint($, caller)
  expect(result.ok).toBe(false)
  expect(String(result.reason)).toContain(missing === 'helper' ? 'blob helper unavailable' : 'blob directory unavailable')
  expect(String(result.reason)).toContain('capacity:')
  expect(store.held.has(`s:${caller}`)).toBe(false)
  expect(store.held.has(`h:${caller}`)).toBe(false)
  const saved = store.held.get('saved') as Record<string, unknown>
  for (const session of sessions) {
    expect(await print(store.held.get(`s:${session}`))).toBe(await print(bodies[session]))
    expect(await print(store.held.get(`h:${session}`))).toBe(await print(records[`h:${session}`]))
    expect(saved[session]).toEqual((records.saved as Record<string, unknown>)[session])
    expect(store.held.has(`cleanup:${session}`)).toBe(false)
  }
  expect(store.held.get('cleanup')).toEqual(records.cleanup)
  expect(lines.filter(line => line.includes('was evicted'))).toEqual([])
  expect(lines.filter(line => line.startsWith('track: compaction keeps '))).toEqual([])
  expect(published).toEqual([])
  expect([...files]).toEqual([])
})

test('TRACK-35 U2b a pre-compaction export imports after its session was compacted', async ($, on) => {
  const caller = callerOf(30)
  const { sessions, records, bodies, states, big } = await prefill(30)
  const files = new Map<string, string>()
  const { store } = setup(on, caller, records, files, { states })
  const exported = await command($, 'export /before.json')
  expect(exported.reason).toBeUndefined()
  const result = await checkpoint($, caller)
  expect(result.ok).toBe(true)
  const { pointer } = await pointerOf(bodies[big]!)
  expect(await print(store.held.get(`s:${big}`))).toBe(await print(pointer))
  const imported = await command($, 'import /before.json')
  expect(imported.reason).toBeUndefined()
  expect(imported).toMatchObject({ ok: true, imported: [], evicted: [] })
  expect([...imported.verified].sort()).toEqual([...sessions].sort())
  expect(await print(store.held.get(`s:${big}`))).toBe(await print(pointer))
})

test('TRACK-35 U2b an over-budget import compacts a CLOSED non-bundle session and patches its index entry', async ($, on) => {
  const caller = callerOf(31)
  const { sessions, records, bodies, states, big } = await prefill(31)
  const incoming = idOf(31, 8)
  const fresh = await durable(incoming, 300000, 9000)
  const bundleRecords = [{ key: `s:${incoming}`, value: fresh.body }]
  const files = new Map<string, string>([['/incoming.json', JSON.stringify({ v: 1, source_identity: '/elsewhere', checksum: await checksumOf(bundleRecords), records: bundleRecords })]])
  const { store } = setup(on, caller, records, files, { states: { ...states, [incoming]: 'closed' } })
  const imported = await command($, 'import /incoming.json')
  expect(imported.reason).toBeUndefined()
  expect(imported).toMatchObject({ ok: true, imported: [incoming], verified: [incoming], evicted: [] })
  for (const session of sessions) expect(store.held.has(`s:${session}`)).toBe(true)
  const { pointer } = await pointerOf(bodies[big]!)
  expect(await print(store.held.get(`s:${big}`))).toBe(await print(pointer))
  const index = store.held.get('saved') as Record<string, unknown>
  expect(index[big]).toEqual({ at: AGES[0], bytes: rawBytes(`s:${big}`, pointer), unfinished: true })
})

// Retention-level contract: eligibility is eviction's, order is largest raw body first, and
// compaction stops as soon as the write fits.
type Probe = (session: string) => Promise<{ state: 'closed' | 'live'; release: () => Promise<void> }>
type Outcome = 'compacted' | 'kept' | 'stop'
const capacity = ensureCapacity as unknown as (store: RetentionStore, replacements: Record<string, unknown>, budget: number,
  eviction: { caller: string; protect?: string[]; probe: Probe; compact?: (session: string, confirm: () => Promise<boolean>) => Promise<Outcome> }) => Promise<string[]>
const memory = (initial: Record<string, unknown>) => {
  const held = new Map<string, unknown>(Object.entries(JSON.parse(JSON.stringify(initial))))
  const store: RetentionStore = {
    get: async key => held.get(key), set: async (key, value) => { held.set(key, JSON.parse(JSON.stringify(value))) },
    delete: async key => { held.delete(key) }, keys: async () => [...held.keys()], log: () => undefined,
  }
  return { held, store }
}
const bodyOf = (session: string, pad: number, savedAt: number) => ({ v: 1, session_id: session, savedAt, ledger: { v: 1, pad: 'p'.repeat(pad) } })
const totalOf = (records: Record<string, unknown>) => {
  const entries = Object.entries(records)
  return 2 + entries.reduce((total, [key, value]) => total + entryBytes(key, value), 0) + Math.max(0, entries.length - 1)
}

test('TRACK-35 U2b retention compacts eviction candidates only, largest first, until the write fits', async () => {
  const [caller, guarded, pending, conflicted, small, large, middle] = [1, 2, 3, 4, 5, 6, 7].map(n => idOf(40, n)) as [string, string, string, string, string, string, string]
  const initial: Record<string, unknown> = {
    [`s:${caller}`]: bodyOf(caller, 9000, 1), [`s:${guarded}`]: bodyOf(guarded, 9000, 1),
    [`s:${pending}`]: bodyOf(pending, 9000, 1), [`cleanup:${pending}`]: { v: 1, session_id: pending, entries: [] },
    [`s:${conflicted}`]: bodyOf(conflicted, 9000, 1), [`r:${conflicted}:conflict-x`]: { v: 1, session_id: conflicted, kind: 'conflict', value: {} },
    [`s:${small}`]: bodyOf(small, 1000, 1), [`s:${large}`]: bodyOf(large, 5000, 3), [`s:${middle}`]: bodyOf(middle, 3000, 2),
  }
  for (const [need, expected] of [[4000, [large]], [7000, [large, middle]]] as const) {
    const { held, store } = memory(initial)
    const probed: string[] = []
    const compacted: string[] = []
    const probe: Probe = async session => { probed.push(session); return { state: 'closed', release: async () => undefined } }
    const compact = async (session: string, confirm: () => Promise<boolean>): Promise<Outcome> => {
      if (!(await confirm())) return 'kept'
      compacted.push(session)
      await store.set(`s:${session}`, { v: 2, session_id: session })
      return 'compacted'
    }
    const write = { [`s:${caller}`]: bodyOf(caller, 9000, 9) }
    await expect(capacity(store, write, totalOf({ ...initial, ...write }) - need, { caller, protect: [guarded], probe, compact })).resolves.toEqual([])
    expect(compacted).toEqual([...expected])
    expect(probed).toEqual([...expected])
    expect([...held.keys()].sort()).toEqual(Object.keys(initial).sort())
  }
})

test('TRACK-35 U2b retention propagates a compaction failure and evicts nothing', async () => {
  const [caller, first, second] = [1, 2, 3].map(n => idOf(41, n)) as [string, string, string]
  const initial = { [`s:${first}`]: bodyOf(first, 5000, 1), [`s:${second}`]: bodyOf(second, 4000, 2) }
  const { held, store } = memory(initial)
  const released: string[] = []
  const probe: Probe = async session => ({ state: 'closed', release: async () => { released.push(session) } })
  const compact = async (session: string, confirm: () => Promise<boolean>): Promise<Outcome> => {
    await confirm()
    throw new Error(`compaction left ${session} ${UNCERTAIN}: fixture`)
  }
  const write = { [`s:${caller}`]: bodyOf(caller, 3000, 9) }
  await expect(capacity(store, write, totalOf({ ...initial, ...write }) - 3000, { caller, probe, compact })).rejects.toThrow(`compaction left ${first} ${UNCERTAIN}`)
  expect(Object.fromEntries(held)).toEqual(initial)
  expect(released).toEqual([first])
})

test('TRACK-35 U2b retention falls through to unchanged eviction when compaction stops', async () => {
  const [caller, first, second] = [1, 2, 3].map(n => idOf(42, n)) as [string, string, string]
  const initial = { [`s:${first}`]: bodyOf(first, 5000, 2), [`s:${second}`]: bodyOf(second, 4000, 1) }
  const write = { [`s:${caller}`]: bodyOf(caller, 3000, 9) }
  const budget = totalOf({ ...initial, ...write }) - 3000
  const probe: Probe = async () => ({ state: 'closed', release: async () => undefined })
  const plain = memory(initial)
  const expected = await capacity(plain.store, write, budget, { caller, probe })
  const asked: string[] = []
  const stopped = memory(initial)
  const compact = async (session: string): Promise<Outcome> => { asked.push(session); return 'stop' }
  await expect(capacity(stopped.store, write, budget, { caller, probe, compact })).resolves.toEqual(expected)
  expect(asked).toEqual([first])
  expect(Object.fromEntries(stopped.held)).toEqual(Object.fromEntries(plain.held))
})
