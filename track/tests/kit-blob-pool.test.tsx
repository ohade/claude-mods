// FIXTURE: opt-in blob publication and logical reads in memory. No host filesystem or atomicity proof.
import { expect, test } from 'claude-code/testing'
import type { ProcessRunResult } from 'claude-code'
import { EMPTY, atomStore, blobPool, logs, pluginStore, SESSION } from './kit'
import type { Engine, On } from './kit'
import { describeCheckpoint } from '../hooks/checkpoint'

const CONFIG = '/fixture/config'
const BLOBS = `${CONFIG}/state/track/blobs`
const HELPER = '/fixture/track/hooks/blob-fs.py'
const KEY = `s:${SESSION}`
const LEDGER = {
  v: 1, nextQuestionId: 2, prompts: [], questions: [],
  steps: [{ id: 'plan:1', subject: 'café 🚀', status: 'pending' }],
}
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length
const sha256 = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('')

const blobFixture = async (text = JSON.stringify(LEDGER)) => {
  const ref = { checksum: await sha256(text), bytes: utf8Bytes(text) }
  // The blob field sits between metadata fields: hydration must map keys in place.
  const pointer = { v: 2, session_id: SESSION, ledger_blob: ref, savedAt: 123, generation: 'generation-1', checkpoint: { revision: 3 }, imported: true, closedAt: 456 }
  const logical = { v: 1, session_id: SESSION, ledger: LEDGER, savedAt: 123, generation: 'generation-1', checkpoint: { revision: 3 }, imported: true, closedAt: 456 }
  return { text, ref, path: `${BLOBS}/${ref.checksum}.json`, pointer, logical }
}

// Capture both rejection and resolution for explicit error assertions.
const outcome = async <T,>(operation: () => Promise<T>) => {
  try { return { status: 'resolved' as const, value: await operation() } }
  catch (error) { return { status: 'rejected' as const, message: error instanceof Error ? error.message : String(error) } }
}

type RecordedEvent = 'env.get' | 'fs.read' | 'process.run'
type RecordedInput = { name?: string; path?: string; argv?: string[]; init?: { stdin?: string } }
type Registration = {
  event: RecordedEvent
  matcher: Record<string, RegExp>
  callback: (capabilities: unknown, input: RecordedInput) => unknown
}

// FIXTURE only: record blobPool's actual registrations and invoke their actual callbacks.
// This matcher inspection is not the native dispatcher and never calls host capabilities.
const recordRegistrations = () => {
  const registrations: Registration[] = []
  const on = ((event: RecordedEvent, matcher: Registration['matcher'], callback: Registration['callback']) => {
    registrations.push({ event, matcher, callback })
  }) as unknown as On
  const matching = (event: RecordedEvent, input: RecordedInput) => registrations.filter(registration =>
    registration.event === event && Object.entries(registration.matcher).every(([key, pattern]) => {
      const value = input[key as keyof RecordedInput]
      return Array.isArray(value) ? value.some(arg => pattern.test(arg)) : typeof value === 'string' && pattern.test(value)
    }))
  const invoke = async <T,>(event: RecordedEvent, input: RecordedInput): Promise<T> => {
    const matches = matching(event, input)
    expect(matches.length).toBe(1)
    const result = await matches[0]!.callback(undefined, input) as { value: T }
    return result.value
  }
  return { on, matching, invoke }
}

const invokePublication = (recorded: ReturnType<typeof recordRegistrations>, checksum: string, text: string, dir = BLOBS) =>
  recorded.invoke<ProcessRunResult>('process.run', { argv: ['python3', HELPER, 'publish', dir, checksum], init: { stdin: text } })

test('blobPool fixture uses native SHA-256 and UTF-8 bytes for unicode', async () => {
  expect(await sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(utf8Bytes('café 🚀')).toBe(10)
  expect('café 🚀'.length).toBe(7)
})

test('blobPool logical preserves v:1 object identity and absent values', async (_, on) => {
  const pool = blobPool(on)
  const body = { v: 1, session_id: SESSION, ledger: LEDGER, savedAt: 123 }
  const store = pluginStore(on, { [KEY]: body })
  expect(await pool.logical(store, KEY)).toBe(body)
  expect(await pool.logical(store, 's:absent')).toBeUndefined()
  expect(pool.files.size).toBe(0)
  expect(pool.publishes).toBe(0)
})

test('blobPool logical hydrates v:2 exactly and keeps metadata, key order and raw identity', async (_, on) => {
  const pool = blobPool(on)
  const fixture = await blobFixture()
  pool.files.set(fixture.path, fixture.text)
  const store = pluginStore(on, { [KEY]: fixture.pointer })
  const before = JSON.stringify(fixture.pointer)
  const hydrated = await pool.logical(store, KEY)
  expect(hydrated).toEqual(fixture.logical)
  expect(JSON.stringify(hydrated)).toBe(JSON.stringify(fixture.logical))
  expect(store.held.get(KEY)).toBe(fixture.pointer)
  expect(JSON.stringify(store.held.get(KEY))).toBe(before)
  expect(pool.files.get(fixture.path)).toBe(fixture.text)
  expect(pool.publishes).toBe(0)
})

test('blobPool logical uses a custom config directory', async (_, on) => {
  const pool = blobPool(on, { configDir: '/fixture/custom-config' })
  const fixture = await blobFixture()
  pool.files.set(`/fixture/custom-config/state/track/blobs/${fixture.ref.checksum}.json`, fixture.text)
  const store = pluginStore(on, { [KEY]: fixture.pointer })
  expect(await pool.logical(store, KEY)).toEqual(fixture.logical)
})

for (const damage of ['missing', 'same-length content', 'wrong byte count', 'UTF-16 count', 'empty content'] as const) {
  test(`blobPool logical rejects ${damage} and preserves the raw pointer`, async (_, on) => {
    const pool = blobPool(on)
    const fixture = await blobFixture()
    const pointer = {
      ...fixture.pointer,
      ledger_blob: { ...fixture.ref, bytes: damage === 'wrong byte count' ? fixture.ref.bytes + 1 : damage === 'UTF-16 count' ? fixture.text.length : fixture.ref.bytes },
    }
    if (damage !== 'missing') pool.files.set(fixture.path, damage === 'same-length content' ? fixture.text.replace('pending', 'running') : damage === 'empty content' ? '' : fixture.text)
    if (damage === 'same-length content') expect(utf8Bytes(pool.files.get(fixture.path)!)).toBe(fixture.ref.bytes)
    const store = pluginStore(on, { [KEY]: pointer })
    const before = JSON.stringify(pointer)
    const result = await outcome(() => pool.logical(store, KEY))
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') expect(result.message).toMatch(/blob|checksum|bytes|missing|damaged/i)
    expect(store.held.get(KEY)).toBe(pointer)
    expect(JSON.stringify(pointer)).toBe(before)
    expect(pool.publishes).toBe(0)
  })
}

test('blobPool logical rejects invalid ledger JSON even when its checksum and byte count match', async (_, on) => {
  const pool = blobPool(on)
  const fixture = await blobFixture('{broken JSON')
  pool.files.set(fixture.path, fixture.text)
  const store = pluginStore(on, { [KEY]: fixture.pointer })
  expect((await outcome(() => pool.logical(store, KEY))).status).toBe('rejected')
  expect(store.held.get(KEY)).toBe(fixture.pointer)
})

test('FIXTURE blobPool recorded env callback returns the default config directory', async () => {
  const recorded = recordRegistrations()
  blobPool(recorded.on)
  expect(await recorded.invoke('env.get', { name: 'CLAUDE_CONFIG_DIR' })).toBe(CONFIG)
})

test('FIXTURE blobPool recorded env callback returns an explicit config directory', async () => {
  const recorded = recordRegistrations()
  blobPool(recorded.on, { configDir: '/fixture/custom-config' })
  expect(await recorded.invoke('env.get', { name: 'CLAUDE_CONFIG_DIR' })).toBe('/fixture/custom-config')
})

test('FIXTURE blobPool recorded env callback returns undefined for HOME', async () => {
  const recorded = recordRegistrations()
  blobPool(recorded.on)
  expect(await recorded.invoke('env.get', { name: 'HOME' })).toBeUndefined()
})

test('FIXTURE blobPool recorded fs callback reads unicode and reports ENOENT for a missing blob', async () => {
  const recorded = recordRegistrations()
  const pool = blobPool(recorded.on)
  const fixture = await blobFixture()
  pool.files.set(fixture.path, fixture.text)
  expect(await recorded.invoke('fs.read', { path: fixture.path })).toBe(fixture.text)
  const missingPath = `${BLOBS}/${'0'.repeat(64)}.json`
  // Assert registration admission separately: a missing registration cannot prove ENOENT.
  expect(recorded.matching('fs.read', { path: missingPath }).length).toBe(1)
  const missing = await outcome(() => recorded.invoke('fs.read', { path: missingPath }))
  expect(missing.status).toBe('rejected')
  if (missing.status === 'rejected') expect(missing.message).toContain('ENOENT')
})

test('FIXTURE blobPool recorded fs callback uses the explicit pool directory', async () => {
  const recorded = recordRegistrations()
  const pool = blobPool(recorded.on, { configDir: '/fixture/custom-config' })
  const path = `/fixture/custom-config/state/track/blobs/${'1'.repeat(64)}.json`
  pool.files.set(path, 'custom text')
  expect(await recorded.invoke('fs.read', { path })).toBe('custom text')
  expect(recorded.matching('fs.read', { path: `${BLOBS}/${'1'.repeat(64)}.json` }).length).toBe(0)
})

test('FIXTURE blobPool recorded publish callback stores a missing blob, returns an exact receipt, and counts calls', async () => {
  const recorded = recordRegistrations()
  const pool = blobPool(recorded.on)
  const fixture = await blobFixture()
  expect(pool.publishes).toBe(0)
  const first = await invokePublication(recorded, fixture.ref.checksum, fixture.text)
  expect(first).toMatchObject({ exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  expect(JSON.parse(first.stdout)).toEqual({ ok: true, checksum: fixture.ref.checksum, bytes: fixture.ref.bytes })
  expect([...pool.files]).toEqual([[fixture.path, fixture.text]])
  expect(pool.publishes).toBe(1)
  // An equal publication is accepted without changing any existing text.
  const before = JSON.stringify([...pool.files])
  const second = await invokePublication(recorded, fixture.ref.checksum, fixture.text)
  expect(second.exitCode).toBe(0)
  expect(JSON.parse(second.stdout)).toEqual({ ok: true, checksum: fixture.ref.checksum, bytes: fixture.ref.bytes })
  expect(JSON.stringify([...pool.files])).toBe(before)
  expect(pool.publishes).toBe(2)
})

test('FIXTURE blobPool recorded publish callback uses the explicit pool directory', async () => {
  const recorded = recordRegistrations()
  const dir = '/fixture/custom-config/state/track/blobs'
  const pool = blobPool(recorded.on, { configDir: '/fixture/custom-config' })
  const fixture = await blobFixture()
  const result = await invokePublication(recorded, fixture.ref.checksum, fixture.text, dir)
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ ok: true, checksum: fixture.ref.checksum, bytes: fixture.ref.bytes })
  expect([...pool.files]).toEqual([[`${dir}/${fixture.ref.checksum}.json`, fixture.text]])
  expect(pool.publishes).toBe(1)
})

for (const existing of ['same-length damaged', 'empty damaged'] as const) {
  test(`FIXTURE blobPool recorded publish callback refuses ${existing} and preserves it`, async () => {
    const recorded = recordRegistrations()
    const pool = blobPool(recorded.on)
    const fixture = await blobFixture()
    const damaged = existing === 'empty damaged' ? '' : fixture.text.replace('pending', 'running')
    if (existing === 'same-length damaged') expect(utf8Bytes(damaged)).toBe(fixture.ref.bytes)
    pool.files.set(fixture.path, damaged)
    const before = JSON.stringify([...pool.files])
    const result = await invokePublication(recorded, fixture.ref.checksum, fixture.text)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/differ|kept|refus|damag/i)
    expect(JSON.stringify([...pool.files])).toBe(before)
    expect(pool.publishes).toBe(1)
  })
}

for (const invalid of ['wrong checksum', 'uppercase checksum', 'short checksum', 'extra arg', 'missing arg', 'wrong interpreter', 'wrong operation', 'wrong directory'] as const) {
  test(`FIXTURE blobPool recorded publish callback refuses ${invalid} without changing files`, async () => {
    const recorded = recordRegistrations()
    const pool = blobPool(recorded.on)
    const fixture = await blobFixture()
    pool.files.set(`${BLOBS}/preserved.json`, 'kept')
    const argv = ['python3', HELPER, 'publish', BLOBS, fixture.ref.checksum]
    if (invalid === 'wrong checksum') argv[4] = '0'.repeat(64)
    if (invalid === 'uppercase checksum') argv[4] = fixture.ref.checksum.toUpperCase()
    if (invalid === 'short checksum') argv[4] = 'abc'
    if (invalid === 'extra arg') argv.push('extra')
    if (invalid === 'missing arg') argv.pop()
    if (invalid === 'wrong interpreter') argv[0] = 'python'
    if (invalid === 'wrong operation') argv[2] = 'remove'
    if (invalid === 'wrong directory') argv[3] = '/fixture/elsewhere'
    const before = JSON.stringify([...pool.files])
    const result = await recorded.invoke<ProcessRunResult>('process.run', { argv, init: { stdin: fixture.text } })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/invalid|checksum/i)
    expect(pool.publishes).toBe(1)
    expect(JSON.stringify([...pool.files])).toBe(before)
  })
}

for (const enabled of [false, true]) test(`FIXTURE blobPool recorded matchers ignore unrelated requests with pool ${enabled ? 'enabled' : 'absent'}`, async () => {
  const recorded = recordRegistrations()
  const pool = enabled ? blobPool(recorded.on) : undefined
  const requests: Array<[RecordedEvent, RecordedInput]> = [
    ['env.get', { name: 'TRACK_BLOB_POOL_UNRELATED' }],
    ['env.get', { name: 'CLAUDE_CONFIG_DIR_OTHER' }],
    ['env.get', { name: 'HOME_OTHER' }],
    ['fs.read', { path: '/fixture/unrelated.json' }],
    ['fs.read', { path: `${BLOBS}-sibling/${'0'.repeat(64)}.json` }],
    ['fs.read', { path: `${BLOBS}/../${'0'.repeat(64)}.json` }],
    ['process.run', { argv: ['fixture-unrelated-command'] }],
    ['process.run', { argv: ['python3', '/fixture/track/hooks/not-blob-fs.py', 'publish', BLOBS, '0'.repeat(64)] }],
  ]
  for (const [event, input] of requests) expect(recorded.matching(event, input).length).toBe(0)
  if (pool !== undefined) {
    expect(pool.files.size).toBe(0)
    expect(pool.publishes).toBe(0)
  }
})

// Real Track hooks dispatch capabilities into blobPool, over in-memory FIXTURE records.
// Families 80–87 keep the real hooks' per-session state separate from other test modules.
const CUSTOM_CONFIG = '/fixture/custom-config'
const GENERATION = '99999999-8888-4777-8666-555555555555'
const callerOf = (family: number) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(family).padStart(12, '0')}`
const closedIdOf = (family: number, n: number) => `cccccccc-0000-4000-8000-${String(family * 100 + n).padStart(12, '0')}`
const integrationLedger = (session: string, pad = 0) => ({
  v: 1, nextQuestionId: 2, prompts: [],
  questions: [{ id: 1, head: 'Saved question', at: 1, turnId: 'old', status: 'deferred', note: 'n'.repeat(pad), session_id: session }],
  steps: [{ id: 'plan:1', subject: 'café 🚀', source: 'plan', status: 'in_progress', session_id: session }],
  session_id: session,
})

const durableSession = async (session: string, pad = 0, savedAt = 1000) => {
  const ledger = integrationLedger(session, pad)
  const checkpoint = await describeCheckpoint(ledger as never, session)
  return {
    body: { v: 1, session_id: session, generation: GENERATION, savedAt, ledger, checkpoint },
    head: { v: 1, session_id: session, generation: GENERATION, checkpoint },
  }
}

const pointerFor = async (body: Record<string, unknown>) => {
  const text = JSON.stringify(body.ledger)
  const ref = { checksum: await sha256(text), bytes: utf8Bytes(text) }
  const pointer = Object.fromEntries(Object.entries(body).map(([key, value]) =>
    key === 'v' ? [key, 2] : key === 'ledger' ? ['ledger_blob', ref] : [key, value]))
  return { text, ref, pointer }
}

// Keep large assertion failures bounded, while checking both UTF-8 size and content digest.
const textFingerprint = async (text: string) => ({ bytes: utf8Bytes(text), checksum: await sha256(text) })
const recordFingerprint = async (value: unknown) => value === undefined ? 'absent' : textFingerprint(JSON.stringify(value))

const setupTrack = (on: On, session: string, records: Record<string, unknown>, options: { configDir?: string; states?: Record<string, 'live' | 'closed'> } = {}) => {
  const pool = blobPool(on, { configDir: options.configDir })
  const memory = atomStore<any>(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on, records, undefined, { guardStates: options.states })
  const lines = logs(on)
  on('session.id', () => ({ value: session }))
  return { pool, memory, store, lines }
}

const checkpoint = async ($: Engine, session: string) =>
  JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: session } as never)).result ?? '{}'))

for (const [index, configDir] of [undefined, CUSTOM_CONFIG].entries()) {
  test(`FIXTURE real Track checkpoint reads unicode v:2 rows through blobPool with ${configDir === undefined ? 'default' : 'custom'} config`, async ($, on) => {
    const session = callerOf(80 + index)
    const { body, head } = await durableSession(session)
    const fixture = await pointerFor(body)
    const { pool, memory } = setupTrack(on, session, { [`s:${session}`]: fixture.pointer, [`h:${session}`]: head }, { configDir })
    pool.files.set(`${configDir ?? CONFIG}/state/track/blobs/${fixture.ref.checksum}.json`, fixture.text)
    const receipt = await checkpoint($, session)
    expect(receipt.reason).toBeUndefined()
    expect(receipt.ok).toBe(true)
    expect(receipt.counts).toEqual({ questions: 1, answers: 0, steps: 1 })
    expect(receipt.open_steps).toEqual([{ id: 'plan:1', status: 'in_progress', subject: 'café 🚀' }])
    expect(memory.value.questions.map((question: { head: string }) => question.head)).toEqual(['Saved question'])
    expect(memory.value.steps.map((step: { subject: string }) => step.subject)).toEqual(['café 🚀'])
    expect(pool.publishes).toBe(0)
  })
}

for (const [index, damage] of ['wrong-directory-only', 'missing'].entries()) {
  test(`FIXTURE real Track checkpoint fails closed for a ${damage} blob and keeps raw pointer and head`, async ($, on) => {
    const session = callerOf(82 + index)
    const { body, head } = await durableSession(session)
    const fixture = await pointerFor(body)
    const configDir = damage === 'wrong-directory-only' ? CUSTOM_CONFIG : undefined
    const { pool, memory, store } = setupTrack(on, session, { [`s:${session}`]: fixture.pointer, [`h:${session}`]: head }, { configDir })
    if (damage === 'wrong-directory-only') pool.files.set(`${BLOBS}/${fixture.ref.checksum}.json`, fixture.text)
    const before = JSON.stringify({ pointer: fixture.pointer, head, files: [...pool.files] })
    const receipt = await checkpoint($, session)
    expect(receipt.ok).toBe(false)
    expect(receipt.reason).toContain('saved history blob is missing or damaged')
    expect(receipt.reason).toContain('pointer was kept')
    expect(pool.publishes).toBe(0)
    expect(JSON.stringify({ pointer: store.held.get(`s:${session}`), head: store.held.get(`h:${session}`), files: [...pool.files] })).toBe(before)
    expect(memory.value.questions).toEqual([])
    expect(memory.value.steps).toEqual([])
  })
}

// 3.2 MB against the 3 MiB budget: compacting either the 950k or 800k body suffices.
const PADS = [950000, 800000, 750000, 700000]
const AGES = [3000, 4000, 2000, 1000]
const prefillClosed = async (family: number) => {
  const sessions = PADS.map((_, index) => closedIdOf(family, index + 1))
  const records: Record<string, unknown> = { cleanup: { v: 1, lastAttempt: Date.now(), cursor: '' } }
  const saved: Record<string, unknown> = {}
  const bodies: Record<string, Record<string, unknown>> = {}
  const states: Record<string, 'live' | 'closed'> = {}
  for (const [index, session] of sessions.entries()) {
    const { body, head } = await durableSession(session, PADS[index]!, AGES[index]!)
    bodies[session] = body
    records[`s:${session}`] = body
    records[`h:${session}`] = head
    saved[session] = { at: AGES[index]!, bytes: utf8Bytes(JSON.stringify({ [`s:${session}`]: body })) + 1, unfinished: true }
    states[session] = 'closed'
  }
  records.saved = saved
  return { sessions, records, bodies, states, big: sessions[0]!, second: sessions[1]! }
}

const expectClosedKept = async (store: ReturnType<typeof pluginStore>, seeded: Awaited<ReturnType<typeof prefillClosed>>, compacted: string) => {
  for (const session of seeded.sessions) {
    expect(store.held.has(`s:${session}`)).toBe(true)
    expect(await recordFingerprint(store.held.get(`h:${session}`))).toEqual(await recordFingerprint(seeded.records[`h:${session}`]))
    if (session !== compacted) {
      expect(await recordFingerprint(store.held.get(`s:${session}`))).toEqual(await recordFingerprint(seeded.bodies[session]))
    }
  }
}

for (const [index, configDir] of [undefined, CUSTOM_CONFIG].entries()) {
  test(`FIXTURE real Track CLOSED compaction publishes once through blobPool with ${configDir === undefined ? 'default' : 'custom'} config and evicts nothing`, async ($, on) => {
    const family = 84 + index
    const caller = callerOf(family)
    const seeded = await prefillClosed(family)
    const { pool, store, lines } = setupTrack(on, caller, seeded.records, { configDir, states: seeded.states })
    const receipt = await checkpoint($, caller)
    expect(receipt.reason).toBeUndefined()
    expect(receipt.ok).toBe(true)
    expect(pool.publishes).toBe(1)
    expect(lines.filter(line => line.includes('was evicted'))).toEqual([])
    const raw = store.held.get(`s:${seeded.big}`) as { v: number; ledger?: unknown }
    expect(raw.v).toBe(2)
    expect(Object.hasOwn(raw, 'ledger')).toBe(false)
    const fixture = await pointerFor(seeded.bodies[seeded.big]!)
    const path = `${configDir ?? CONFIG}/state/track/blobs/${fixture.ref.checksum}.json`
    expect([...pool.files.keys()]).toEqual([path])
    expect(await recordFingerprint(raw)).toEqual(await recordFingerprint(fixture.pointer))
    expect(await textFingerprint(pool.files.get(path)!)).toEqual(fixture.ref)
    expect(await recordFingerprint(await pool.logical(store, `s:${seeded.big}`))).toEqual(await recordFingerprint(seeded.bodies[seeded.big]))
    await expectClosedKept(store, seeded, seeded.big)
  })
}

for (const [index, damage] of ['same-length', 'empty'].entries()) {
  test(`FIXTURE real Track CLOSED compaction refuses a ${damage} existing blob and compacts the second body without eviction`, async ($, on) => {
    const family = 86 + index
    const caller = callerOf(family)
    const seeded = await prefillClosed(family)
    const big = await pointerFor(seeded.bodies[seeded.big]!)
    const damaged = damage === 'empty' ? '' : big.text.replace('café', 'cafè')
    if (damage === 'same-length') expect(utf8Bytes(damaged)).toBe(big.ref.bytes)
    expect(await sha256(damaged)).not.toBe(big.ref.checksum)
    const { pool, store, lines } = setupTrack(on, caller, seeded.records, { states: seeded.states })
    const damagedPath = `${BLOBS}/${big.ref.checksum}.json`
    pool.files.set(damagedPath, damaged)
    const receipt = await checkpoint($, caller)
    expect(receipt.reason).toBeUndefined()
    expect(receipt.ok).toBe(true)
    expect(pool.publishes).toBe(2)
    expect(lines.some(line => line.startsWith(`track: compaction keeps ${seeded.big}:`))).toBe(true)
    expect(lines.filter(line => line.includes('was evicted'))).toEqual([])
    expect((store.held.get(`s:${seeded.big}`) as { v: number }).v).toBe(1)
    expect((store.held.get(`s:${seeded.second}`) as { v: number }).v).toBe(2)
    const second = await pointerFor(seeded.bodies[seeded.second]!)
    const secondPath = `${BLOBS}/${second.ref.checksum}.json`
    expect([...pool.files.keys()].sort()).toEqual([damagedPath, secondPath].sort())
    expect(await textFingerprint(pool.files.get(damagedPath)!)).toEqual(await textFingerprint(damaged))
    expect(await textFingerprint(pool.files.get(secondPath)!)).toEqual(second.ref)
    expect(await recordFingerprint(store.held.get(`s:${seeded.second}`))).toEqual(await recordFingerprint(second.pointer))
    expect(await recordFingerprint(await pool.logical(store, `s:${seeded.second}`))).toEqual(await recordFingerprint(seeded.bodies[seeded.second]))
    await expectClosedKept(store, seeded, seeded.second)
  })
}

test('FIXTURE blobPool shares a supplied file map without copying or losing seeded data', async () => {
  const recorded = recordRegistrations()
  const sentinel = 'kept café 🧭 שלום'
  const files = new Map<string, string>([['/backup.json', '{"backup":true}'], ['/sentinel.txt', sentinel]])
  const options = { configDir: CONFIG, files }
  const pool = blobPool(recorded.on, options)
  expect(pool.files).toBe(files)
  expect([...files]).toEqual([['/backup.json', '{"backup":true}'], ['/sentinel.txt', sentinel]])
  const ledger = { ...LEDGER, steps: [{ id: 'plan:2', subject: 'naïve 🌍 שלום', status: 'pending' }] }
  const text = JSON.stringify(ledger)
  const ref = { checksum: await sha256(text), bytes: utf8Bytes(text) }
  const fixture = await blobFixture(text)
  const receipt = await invokePublication(recorded, ref.checksum, text)
  expect(receipt).toEqual({
    exitCode: 0, stdout: `${JSON.stringify({ ok: true, ...ref })}\n`, stderr: '',
    isStdoutTruncated: false, isStderrTruncated: false,
  })
  expect(files.get(`${BLOBS}/${ref.checksum}.json`)).toBe(text)
  expect(files.get('/backup.json')).toBe('{"backup":true}')
  expect(files.get('/sentinel.txt')).toBe(sentinel)
  expect(files.size).toBe(3)
  expect(pool.publishes).toBe(1)
  const store = { held: new Map<string, unknown>([[KEY, fixture.pointer]]) }
  const before = JSON.stringify(fixture.pointer)
  expect(await pool.logical(store, KEY)).toEqual({ ...fixture.logical, ledger })
  expect(store.held.get(KEY)).toBe(fixture.pointer)
  expect(JSON.stringify(store.held.get(KEY))).toBe(before)
})

test('FIXTURE blobPool external read providers register only its real publisher', async () => {
  const recorded = recordRegistrations()
  const files = new Map<string, string>([['/backup.json', 'kept café 🚀']])
  const options = { configDir: CONFIG, files, readProviders: 'external' as const }
  const pool = blobPool(recorded.on, options)
  const fixture = await blobFixture()
  expect(recorded.matching('env.get', { name: 'CLAUDE_CONFIG_DIR' }).length).toBe(0)
  expect(recorded.matching('env.get', { name: 'HOME' }).length).toBe(0)
  expect(recorded.matching('fs.read', { path: fixture.path }).length).toBe(0)
  expect(recorded.matching('process.run', { argv: ['python3', HELPER, 'publish', BLOBS, fixture.ref.checksum] }).length).toBe(1)
  const receipt = await invokePublication(recorded, fixture.ref.checksum, fixture.text)
  expect(receipt).toEqual({
    exitCode: 0, stdout: `${JSON.stringify({ ok: true, ...fixture.ref })}\n`, stderr: '',
    isStdoutTruncated: false, isStderrTruncated: false,
  })
  expect(files.get(fixture.path)).toBe(fixture.text)
  expect(files.get('/backup.json')).toBe('kept café 🚀')
  expect(files.size).toBe(2)
  expect(pool.publishes).toBe(1)
})
