// FIXTURE: TRACK-43 wiring. A save's hourly cleanup converts other CLOSED v:1 sessions to v:2 blob
// pointers through the real compactBody. The kit's lock stream models writer-lock.py protocol 2 in
// memory and its blob pool models blob-fs.py; neither proves host atomicity, file modes (0600) or LIVE use.
import { expect, mock, test } from 'claude-code/testing'
import { describeCheckpoint } from '../hooks/checkpoint'
import { EMPTY, SESSION, atomStore, blobPool, logs, pluginStore } from './kit'
import type { Engine, LockGrant, On } from './kit'

const CONFIG = '/fixture/config'
const BLOBS = `${CONFIG}/state/track/blobs`
const BLOB_HELPER = /\/hooks\/blob-fs\.py$/
const DURABLE = /^(?:set|delete|publish|write):/
const DAY = 24 * 3600000
const DRIVE_MS = 10000
const GENERATION = '43434343-4343-4343-8343-434343434343'
const FOREIGN = '00000000-0000-4000-8000-000000004301'
const OTHER = '00000000-0000-4000-8000-000000004302'
const encoder = new TextEncoder()
const utf8 = (text: string) => encoder.encode(text).length
const sha256 = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))), b => b.toString(16).padStart(2, '0')).join('')
// The exact size one stored entry has in the saved index.
const rawBytes = (key: string, value: unknown) => utf8(JSON.stringify({ [key]: value })) + 1

type Locks = ReturnType<typeof pluginStore>['locks']
type Options = { records?: Record<string, unknown>; guardStates?: Record<string, 'live' | 'closed'> }

const fixture = (on: On, options: Options = {}) => {
  const clock = mock.clock(on)
  const files = new Map<string, string>()
  const ledger = atomStore<Record<string, unknown>>(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on, JSON.parse(JSON.stringify(options.records ?? {})) as Record<string, unknown>, undefined, { guardStates: options.guardStates })
  on('fs.read', { path: /\/state\/track\/blobs\/[0-9a-f]{64}\.json$/ }, (_, e, next) => {
    store.locks.timeline.push(`read:${e.path}`)
    return next(e)
  })
  const pool = blobPool(on, { configDir: CONFIG, files })
  on('session.id', () => ({ value: SESSION }))
  const lines = logs(on)
  return { clock, store, pool, locks: store.locks, files, lines, ledger }
}
type Fixture = ReturnType<typeof fixture>

const checkpoint = async ($: Engine) =>
  JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result ?? '{}'))
// Settles one public call on the stationary mock clock, as the TRACK-39 tests do.
const drive = async <T,>(f: Fixture, call: Promise<T>): Promise<T> => {
  let finished = false
  void call.then(() => { finished = true }, () => { finished = true })
  await f.clock.settle()
  if (!finished) await f.clock.advance(DRIVE_MS)
  if (!finished) {
    f.locks.deadman()
    await f.clock.settle()
  }
  return call
}
const protocolViolations = (locks: Locks) => locks.spawns.flatMap(spawn => {
  const env = spawn.env ?? {}
  return env.TRACK_LOCK_PROTOCOL === '2' && env.CLAUDE_CONFIG_DIR === CONFIG && Object.keys(env).length === 2
    ? [] : [`${spawn.argv[2]} spawn env ${JSON.stringify(spawn.env ?? null)}`]
})
// Durable work happens only inside an open write grant, before that grant's request; one request each.
const orderViolations = (timeline: readonly string[]) => {
  const violations: string[] = []
  let open: string | undefined
  let requested = false
  for (const event of timeline) {
    if (event.startsWith('deadman')) violations.push(`${event}: the deadman ended an open helper stream`)
    else if (event.startsWith('grant:')) {
      open = event.slice('grant:'.length)
      requested = false
    } else if (event.startsWith('request:')) {
      if (event !== `request:${open}` || requested) violations.push(`${event} outside its open grant`)
      requested = true
    } else if (open !== undefined && event === `close:${open}`) open = undefined
    else if (DURABLE.test(event) && (open === undefined || requested)) violations.push(`${event} ${open === undefined ? 'without a write grant' : 'after the completion request'}`)
  }
  return violations
}
const completion = (locks: Locks, grant: LockGrant) => ({
  requests: locks.requests.filter(request => request.path === grant.path).map(request => request.text === grant.nonce ? 'nonce' : request.text),
  ack: locks.timeline.includes(`ack:${grant.id}`),
  exit: locks.timeline.find(event => event.startsWith(`exit:${grant.id}:`))?.split(':').at(-1),
})
const COMPLETED = { requests: ['nonce'], ack: true, exit: '0' }
const NO_REQUEST = { requests: [], ack: false, exit: undefined }
const ownerOf = (locks: Locks, event: string) => {
  let open: string | undefined
  for (const entry of locks.timeline) {
    if (entry.startsWith('grant:')) open = entry.slice('grant:'.length)
    else if (open !== undefined && entry === `close:${open}`) open = undefined
    else if (entry === event) return locks.grants.find(grant => grant.id === open)
  }
  return undefined
}

type Closed = { body: Record<string, unknown>; head: Record<string, unknown>; text: string; checksum: string }
// A v:1 body big enough that its v:2 pointer is smaller, so compaction has something to gain.
const sessionOf = async (session: string, savedAt: number, extra: Record<string, unknown> = {}, closedAt?: number): Promise<Closed> => {
  const ledger = { ...EMPTY, session_id: session, nextQuestionId: 2, questions: [{ id: 1, head: `Question of ${session}`, at: 1, turnId: 'old', status: 'deferred', note: 'n'.repeat(3000), session_id: session }] }
  const checkpoint = await describeCheckpoint(ledger as never, session)
  const text = JSON.stringify(ledger)
  return {
    body: { v: 1, session_id: session, generation: GENERATION, savedAt, ledger, checkpoint, ...extra },
    head: { v: 1, session_id: session, generation: GENERATION, checkpoint, ...(closedAt !== undefined && { closedAt }) },
    text, checksum: await sha256(text),
  }
}
const seed = (session: string, closed: Closed, savedIndex = true) => ({
  [`s:${session}`]: closed.body,
  [`h:${session}`]: closed.head,
  ...(savedIndex && { saved: { [session]: { at: closed.body.savedAt, bytes: rawBytes(`s:${session}`, closed.body), unfinished: true } } }),
})
const provenance = { source_identity: '/legacy', bundle_checksum: 'fixture', source_session: FOREIGN }

// Asserts a converted session: logical ledger, metadata, checkpoint, owner, head and exact saved-index bytes.
const expectConverted = async (f: Fixture, session: string, closed: Closed, headClosedAt: 'seeded' | 'stamped') => {
  const raw = f.store.held.get(`s:${session}`) as Record<string, unknown>
  expect(raw.v).toBe(2)
  expect(Object.hasOwn(raw, 'ledger')).toBe(false)
  expect(raw.ledger_blob).toEqual({ checksum: closed.checksum, bytes: utf8(closed.text) })
  expect(f.files.get(`${BLOBS}/${closed.checksum}.json`)).toBe(closed.text)
  expect(await f.pool.logical(f.store, `s:${session}`)).toEqual(closed.body)
  const { ledger: _ledger, v: _v, ...metadata } = closed.body
  const { v: _rawV, ledger_blob: _blob, ...rawMetadata } = raw
  expect(rawMetadata).toEqual(metadata)
  expect(raw.checkpoint).toEqual(closed.body.checkpoint)
  expect(raw.session_id).toBe(session)
  expect(Object.keys(raw)).toEqual(Object.keys(closed.body).map(name => name === 'ledger' ? 'ledger_blob' : name))
  const head = f.store.held.get(`h:${session}`) as Record<string, unknown>
  if (headClosedAt === 'seeded') expect(head).toEqual(closed.head)
  else expect(head).toEqual({ ...closed.head, closedAt: expect.any(Number) })
  const saved = f.store.held.get('saved') as Record<string, { at: number; bytes: number; unfinished?: boolean }>
  expect(saved[session]).toEqual({ at: closed.body.savedAt, unfinished: true, bytes: utf8(JSON.stringify({ [`s:${session}`]: raw })) + 1 })
  expect(saved[SESSION]).toBeDefined()
}

for (const [label, closedAt] of [['with a closing clock', 'seeded'], ['at first sighting without one', 'stamped']] as const) {
  test(`TRACK-43 N1 a save with cleanup due converts another CLOSED recent v:1 session to a verified v:2 pointer ${label}`, async ($, on) => {
    const closed = await sessionOf(FOREIGN, Date.now() - DAY, {}, closedAt === 'seeded' ? Date.now() - DAY : undefined)
    const f = fixture(on, { records: seed(FOREIGN, closed), guardStates: { [FOREIGN]: 'closed' } })
    const result = await drive(f, checkpoint($))
    expect(protocolViolations(f.locks)).toEqual([])
    expect(result.ok).toBe(true)
    await expectConverted(f, FOREIGN, closed, closedAt)
    expect((f.store.held.get(`s:${SESSION}`) as { v?: number }).v).toBe(2)
    // The caller's blob and the foreign blob.
    expect(f.pool.publishes).toBe(2)
    const grant = ownerOf(f.locks, `set:s:${SESSION}`)!
    expect(completion(f.locks, grant)).toEqual(COMPLETED)
    expect(orderViolations(f.locks.timeline)).toEqual([])
    expect((f.store.held.get('cleanup') as { lastCleanup?: unknown }).lastCleanup).toEqual(expect.any(Number))
  })
}

test('TRACK-43 N2 a LIVE v:1 session and an ambiguous one stay v:1 and unpublished', async ($, on) => {
  const live = await sessionOf(FOREIGN, Date.now() - DAY, {}, Date.now() - DAY)
  const ambiguous = await sessionOf(OTHER, Date.now() - DAY, { session_id: FOREIGN }, Date.now() - DAY)
  const records = { ...seed(FOREIGN, live), ...seed(OTHER, ambiguous, false) }
  const f = fixture(on, { records, guardStates: { [FOREIGN]: 'live', [OTHER]: 'closed' } })
  const result = await drive(f, checkpoint($))
  expect(protocolViolations(f.locks)).toEqual([])
  expect(result.ok).toBe(true)
  for (const key of [`s:${FOREIGN}`, `h:${FOREIGN}`, `s:${OTHER}`, `h:${OTHER}`]) expect(f.store.held.get(key)).toEqual(records[key as keyof typeof records])
  expect((f.store.held.get('saved') as Record<string, unknown>)[FOREIGN]).toEqual((records.saved as Record<string, unknown>)[FOREIGN])
  // Only the caller's own blob.
  expect(f.pool.publishes).toBe(1)
  expect(f.files.has(`${BLOBS}/${live.checksum}.json`)).toBe(false)
  expect(f.files.has(`${BLOBS}/${ambiguous.checksum}.json`)).toBe(false)
  expect(completion(f.locks, ownerOf(f.locks, `set:s:${SESSION}`)!)).toEqual(COMPLETED)
  expect(orderViolations(f.locks.timeline)).toEqual([])
})

// The FOREIGN publication is rejected after the caller's own publication succeeded. The helper receipt,
// or the read-back after a real publication, is what fails; only that candidate is kept.
for (const phase of ['receipt', 'readback'] as const) {
  test(`TRACK-43 N3 a foreign ${phase} failure keeps the foreign body, keeps the caller's save and withholds the completion`, async ($, on) => {
    const closed = await sessionOf(FOREIGN, Date.now() - DAY, {}, Date.now() - DAY)
    const original = JSON.stringify(seed(FOREIGN, closed))
    const seen: string[] = []
    on('process.run', { argv: BLOB_HELPER }, async (_, e, next) => {
      const result = await next(e)
      if (e.argv[4] !== closed.checksum) {
        seen.push('caller-helper')
        return result
      }
      seen.push('foreign-helper')
      if (phase !== 'receipt' || result.deny !== undefined) return result
      return { ...result, value: { ...result.value, stdout: JSON.stringify({ ok: true, checksum: '0'.repeat(64), bytes: 1 }) } }
    })
    on('fs.read', { path: new RegExp(`/state/track/blobs/${closed.checksum}\\.json$`) }, async (_, e, next) => {
      const result = await next(e)
      if (phase !== 'readback' || result.deny !== undefined) return result
      return { value: `${String(result.value).slice(0, -1)}!` }
    })
    const f = fixture(on, { records: seed(FOREIGN, closed), guardStates: { [FOREIGN]: 'closed' } })
    const result = await drive(f, checkpoint($))
    expect(protocolViolations(f.locks)).toEqual([])
    // The caller published first; the foreign candidate was then attempted.
    expect(seen).toEqual(['caller-helper', 'foreign-helper'])
    const why = phase === 'receipt' ? 'blob helper receipt does not match the ledger' : 'published blob does not match the ledger'
    expect(f.lines.some(line => line.includes(`compaction keeps ${FOREIGN}: ${why}`))).toBe(true)
    expect({ body: f.store.held.get(`s:${FOREIGN}`), head: f.store.held.get(`h:${FOREIGN}`), saved: (f.store.held.get('saved') as Record<string, unknown>)[FOREIGN] })
      .toEqual({ body: closed.body, head: closed.head, saved: (JSON.parse(original).saved as Record<string, unknown>)[FOREIGN] })
    expect(result.ok).toBe(true)
    expect((f.store.held.get(`s:${SESSION}`) as { v?: number }).v).toBe(2)
    expect(completion(f.locks, ownerOf(f.locks, `set:s:${SESSION}`)!)).toEqual(NO_REQUEST)
    expect(orderViolations(f.locks.timeline)).toEqual([])
  })
}

test('TRACK-43 N4 a CLOSED session saved at least 7 days ago is expired during a save', async ($, on) => {
  const closed = await sessionOf(FOREIGN, Date.now() - 8 * DAY)
  const records = { ...seed(FOREIGN, closed), [`r:${FOREIGN}:old`]: { v: 1, session_id: FOREIGN, value: 'archive' } }
  const f = fixture(on, { records, guardStates: { [FOREIGN]: 'closed' } })
  const result = await drive(f, checkpoint($))
  expect(protocolViolations(f.locks)).toEqual([])
  expect(result.ok).toBe(true)
  expect([...f.store.held.keys()].filter(key => key.includes(FOREIGN))).toEqual([])
  expect(f.pool.publishes).toBe(1)
  expect(completion(f.locks, ownerOf(f.locks, `set:s:${SESSION}`)!)).toEqual(COMPLETED)
  expect(orderViolations(f.locks.timeline)).toEqual([])
})

test('TRACK-43 N5 a CLOSED recent imported v:1 session stays inline with no foreign publication; an old savedAt alone does not expire an import', async ($, on) => {
  const recent = await sessionOf(FOREIGN, Date.now() - DAY, { import_provenance: provenance }, Date.now() - DAY)
  const old = await sessionOf(OTHER, Date.now() - 30 * DAY, { import_provenance: { ...provenance, source_session: OTHER } })
  const records = { ...seed(FOREIGN, recent), ...seed(OTHER, old, false), [`r:${OTHER}:old`]: { v: 1, session_id: OTHER, value: 'archive' } }
  const f = fixture(on, { records, guardStates: { [FOREIGN]: 'closed', [OTHER]: 'closed' } })
  const result = await drive(f, checkpoint($))
  expect(protocolViolations(f.locks)).toEqual([])
  expect(result.ok).toBe(true)
  for (const key of [`s:${FOREIGN}`, `h:${FOREIGN}`, `s:${OTHER}`, `r:${OTHER}:old`]) expect(f.store.held.get(key)).toEqual(records[key as keyof typeof records])
  expect((f.store.held.get('saved') as Record<string, unknown>)[FOREIGN]).toEqual((records.saved as Record<string, unknown>)[FOREIGN])
  // An import with no closing clock gets one stamped and is otherwise kept.
  expect(f.store.held.get(`h:${OTHER}`)).toEqual({ ...old.head, closedAt: expect.any(Number) })
  expect(f.pool.publishes).toBe(1)
  expect(f.files.has(`${BLOBS}/${recent.checksum}.json`)).toBe(false)
  expect(f.files.has(`${BLOBS}/${old.checksum}.json`)).toBe(false)
  expect(completion(f.locks, ownerOf(f.locks, `set:s:${SESSION}`)!)).toEqual(COMPLETED)
  expect(orderViolations(f.locks.timeline)).toEqual([])
})
