// FIXTURE: TRACK-39 P1b1 client transactions through public tools, commands and hooks. The kit's
// lock stream models writer-lock.py protocol 2 in memory; the helper tests own real markers, flock
// and fsync. No LIVE SDK cancellation, unload or power-loss proof.
import { expect, mock, test } from 'claude-code/testing'
import { checksumOf, describeCheckpoint } from '../hooks/checkpoint'
import { EMPTY, SESSION, TX_REQUEST, atomStore, blobPool, logs, pluginStore, trackCommand, writerLocks } from './kit'
import type { Engine, GrantFault, LockAck, LockGrant, On, WriterLockOptions } from './kit'

const CONFIG = '/fixture/config'
const HELPER = /\/hooks\/writer-lock\.py$/
const BLOB_HELPER = /\/hooks\/blob-fs\.py$/
// Durable work: store mutations, blob publications and bundle file writes.
const DURABLE = /^(?:set|delete|publish|write):/
const ON = 'track: the Haiku question classifier is on. Each typed prompt costs one small Haiku call; /track classifier off stops it.'
const OFF = 'track: the Haiku question classifier is off; the wording check decides. /track classifier on starts it.'
const UNCONFIRMED = 'completion-unconfirmed'
const LOCK_CONFIG = 'writer lock configuration unavailable'
const FOREIGN = '00000000-0000-4000-8000-000000000391'
const TARGET = '00000000-0000-4000-8000-000000000392'
const GENERATION = '39393939-3939-4939-8939-393939393939'
// Virtual time a driven call may use for its receipt and acknowledgement deadlines (4000 ms and 2000 ms).
const DRIVE_MS = 10000
const sha256 = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('')

type Locks = ReturnType<typeof pluginStore>['locks']
type Options = {
  records?: Record<string, unknown>
  ledger?: Record<string, unknown>
  config?: string
  locks?: WriterLockOptions
  guardStates?: Record<string, 'live' | 'closed'>
  refuseSet?: (key: string, value: unknown) => string | undefined
  beforeLockSpawn?: (request: { argv: readonly string[] }) => void
  splitLockReceipt?: true
  files?: Map<string, string>
  failPublish?: () => boolean
  holdSet?: RegExp
}

const fixture = (on: On, options: Options = {}) => {
  const clock = mock.clock(on)
  const config = options.config ?? CONFIG
  const files = options.files ?? new Map<string, string>()
  const ledger = atomStore<Record<string, unknown>>(on, 'ledger', options.ledger ?? EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  let release = () => {}
  const released = new Promise<void>(resolve => { release = resolve })
  const hold = { used: false, waiting: false, release }
  let store!: ReturnType<typeof pluginStore>
  // Observers precede the kit's providers and pass each call down unchanged.
  on('process.run', { argv: BLOB_HELPER }, (_, e, next) => {
    store.locks.timeline.push('publish:blob')
    if (options.failPublish?.() === true) throw new Error('fixture blob helper aborted')
    return next(e)
  })
  if (options.holdSet !== undefined) on('store.set', { key: options.holdSet }, async (_, e, next) => {
    if (!hold.used) {
      hold.used = true
      hold.waiting = true
      await released
      hold.waiting = false
    }
    return next(e)
  })
  // The seeded records are copied, so the expected values never see the store's mutations.
  store = pluginStore(on, JSON.parse(JSON.stringify(options.records ?? {})) as Record<string, unknown>, undefined, {
    guardStates: options.guardStates, refuseSet: options.refuseSet, beforeLockSpawn: options.beforeLockSpawn,
    splitLockReceipt: options.splitLockReceipt, locks: options.locks,
  })
  // Blob reads are recorded before the pool's own read provider answers them.
  on('fs.read', { path: /\/state\/track\/blobs\/[0-9a-f]{64}\.json$/ }, (_, e, next) => {
    store.locks.timeline.push(`read:${e.path}`)
    return next(e)
  })
  const pool = blobPool(on, { configDir: config, files })
  // Bundle files for export and import. Completion requests stay with the kit's matcher above.
  on('fs.write', (_, e) => {
    store.locks.timeline.push(`write:${e.path}`)
    files.set(e.path, String(e.text))
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    store.locks.timeline.push(`read:${e.path}`)
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT: no such file: ${e.path}` } : { value: text }
  })
  on('session.id', () => ({ value: SESSION }))
  const lines = logs(on)
  return { clock, store, pool, locks: store.locks, files, lines, hold, ledger }
}
type Fixture = ReturnType<typeof fixture>

const checkpoint = async ($: Engine) =>
  JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result ?? '{}'))
// Starts a public save without awaiting it; `finished` turns true once its result is back.
const startCheckpoint = ($: Engine) => {
  const call = { finished: false, result: undefined as Promise<Record<string, unknown>> | undefined }
  call.result = checkpoint($).then(result => {
    call.finished = true
    return result
  })
  return call
}
const command = async ($: Engine, args: string) => (await trackCommand($, args)).text ?? ''
// Settles one started public call on the stationary mock clock. A client still waiting for a receipt
// or an acknowledgement reaches its own deadline within DRIVE_MS; past that, the kit's deadman ends
// every open helper stream with SIGKILL (never an acknowledgement), which orderViolations reports.
// The timing tests keep their own explicit clock schedule instead.
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
// Ends with every write grant closed, on the same bounded schedule as drive.
const closeAll = async (f: Fixture) => {
  const open = () => f.locks.grants.some(grant => !f.locks.timeline.includes(`close:${grant.id}`))
  await f.clock.settle()
  if (open()) await f.clock.advance(DRIVE_MS)
  if (open()) {
    f.locks.deadman()
    await f.clock.settle()
  }
}
const unconfirmed = (lines: readonly string[]) => lines.filter(line => line.includes(UNCONFIRMED))

// Every writer-lock spawn passes exactly protocol 2 and the config string the client resolved.
const protocolViolations = (locks: Locks, config = CONFIG) => locks.spawns.flatMap(spawn => {
  const env = spawn.env ?? {}
  return env.TRACK_LOCK_PROTOCOL === '2' && env.CLAUDE_CONFIG_DIR === config && Object.keys(env).length === 2
    ? [] : [`${spawn.argv[2]} spawn env ${JSON.stringify(spawn.env ?? null)}`]
})
// Argument vector and working directory stay as before: python3, the helper, mode, session, token.
const argvViolations = (locks: Locks) => locks.spawns.flatMap(spawn => {
  const [interpreter, helper = '', mode, , token] = spawn.argv
  const root = helper.replace(HELPER, '')
  return spawn.argv.length === 5 && interpreter === 'python3' && HELPER.test(helper) && spawn.cwd === root &&
    ['lease', 'write', 'guard'].includes(mode ?? '') && token === locks.spawns[0]?.argv[4]
    ? [] : [`spawn ${JSON.stringify(spawn)}`]
})
// Durable work happens only inside an open write grant, before that grant's request; one request each.
const orderViolations = (timeline: readonly string[]) => {
  const violations: string[] = []
  let open: string | undefined
  let requested = false
  for (const event of timeline) {
    if (event.startsWith('deadman')) {
      violations.push(`${event}: the deadman ended an open helper stream`)
    } else if (event.startsWith('grant:')) {
      open = event.slice('grant:'.length)
      requested = false
    } else if (event.startsWith('request:')) {
      if (event !== `request:${open}` || requested) violations.push(`${event} outside its open grant`)
      requested = true
    } else if (open !== undefined && event === `close:${open}`) {
      open = undefined
    } else if (DURABLE.test(event) && (open === undefined || requested)) {
      violations.push(`${event} ${open === undefined ? 'without a write grant' : 'after the completion request'}`)
    }
  }
  return violations
}
// What one grant's stream saw: its requests' bytes, the acknowledgement and how it exited.
const completion = (locks: Locks, grant: LockGrant) => ({
  requests: locks.requests.filter(request => request.path === grant.path).map(request => request.text === grant.nonce ? 'nonce' : request.text),
  ack: locks.timeline.includes(`ack:${grant.id}`),
  exit: locks.timeline.find(event => event.startsWith(`exit:${grant.id}:`))?.split(':').at(-1),
})
const COMPLETED = { requests: ['nonce'], ack: true, exit: '0' }
const NO_REQUEST = { requests: [], ack: false, exit: undefined }
// The write grant open when `event` first happened.
const ownerOf = (locks: Locks, event: string) => {
  let open: string | undefined
  for (const entry of locks.timeline) {
    if (entry.startsWith('grant:')) open = entry.slice('grant:'.length)
    else if (open !== undefined && entry === `close:${open}`) open = undefined
    else if (entry === event) return locks.grants.find(grant => grant.id === open)
  }
  return undefined
}
const windowOf = (locks: Locks, grant: LockGrant) => {
  const start = locks.timeline.indexOf(`grant:${grant.id}`)
  const request = locks.timeline.indexOf(`request:${grant.id}`, start)
  return locks.timeline.slice(start + 1, request < 0 ? locks.timeline.indexOf(`close:${grant.id}`, start) : request)
}
// The full grant-to-close interval, including what follows the request.
const intervalOf = (locks: Pick<Locks, 'timeline'>, grant: Pick<LockGrant, 'id'>) => {
  const start = locks.timeline.indexOf(`grant:${grant.id}`)
  const close = locks.timeline.indexOf(`close:${grant.id}`, start)
  return locks.timeline.slice(start + 1, close < 0 ? undefined : close)
}
// Each write's final verification is the LAST matching read after its last write, up to the close,
// and it must precede the request: an earlier internal read-back does not cover a later one.
const unverified = (locks: Pick<Locks, 'timeline'>, grant: Pick<LockGrant, 'id'>, checks: Array<[write: string, read: (event: string) => boolean]>) => {
  const interval = intervalOf(locks, grant)
  const request = interval.indexOf(`request:${grant.id}`)
  return checks.flatMap(([write, read]) => {
    const last = interval.lastIndexOf(write)
    let check = -1
    for (let n = interval.length - 1; n > last && check < 0; n--) if (read(interval[n]!)) check = n
    return last >= 0 && check > last && request > check ? [] : [`${write} is not read back before the request`]
  })
}
const ownVerification = (session: string): Array<[string, (event: string) => boolean]> => [
  [`set:s:${session}`, event => event === `get:s:${session}`],
  [`set:h:${session}`, event => event === `get:h:${session}`],
  ['set:saved', event => event === 'get:saved'],
  ['set:capacitySizes', event => event === 'get:capacitySizes'],
]
// Every guard taken under the grant is released before its request; none is taken or released after it.
const guardsAtRequest = (locks: Locks, grant: LockGrant) => {
  const interval = intervalOf(locks, grant)
  const request = interval.indexOf(`request:${grant.id}`)
  const before = interval.slice(0, request < 0 ? undefined : request)
  const taken = before.filter(event => event === 'spawn:guard').length
  return { taken: taken > 0, released: before.filter(event => event === 'close:guard').length === taken,
    after: request < 0 ? [] : interval.slice(request + 1).filter(event => event === 'spawn:guard' || event === 'close:guard') }
}
const durableEvents = (locks: Locks) => locks.timeline.filter(event => DURABLE.test(event))

const closedBody = async (session: string, pad = 0, savedAt = 1) => {
  const ledger = { ...EMPTY, session_id: session, nextQuestionId: 2, questions: [{ id: 1, head: 'Closed question', at: 1, turnId: 'old', status: 'deferred', note: 'n'.repeat(pad), session_id: session }] }
  const checkpoint = await describeCheckpoint(ledger as never, session)
  return {
    body: { v: 1, session_id: session, generation: GENERATION, savedAt, ledger, checkpoint } as Record<string, unknown>,
    head: { v: 1, session_id: session, generation: GENERATION, checkpoint },
  }
}
// Four CLOSED foreign v:1 bodies that put the caller's save over budget; the largest compacts first.
const overBudget = async () => {
  const pads = [950000, 800000, 750000, 700000]
  const sessions = pads.map((_, n) => `cccccccc-0000-4000-8000-0000000039${n}0`)
  const records: Record<string, unknown> = { cleanup: { v: 1, lastAttempt: Date.now(), cursor: '' } }
  const saved: Record<string, unknown> = {}
  for (const [n, session] of sessions.entries()) {
    const { body, head } = await closedBody(session, pads[n]!, 1000 + n)
    records[`s:${session}`] = body
    records[`h:${session}`] = head
    saved[session] = { at: 1000 + n, bytes: new TextEncoder().encode(JSON.stringify({ [`s:${session}`]: body })).length + 1, unfinished: true }
  }
  records.saved = saved
  return { records, sessions, big: sessions[0]!, guardStates: Object.fromEntries(sessions.map(session => [session, 'closed' as const])) }
}

test('TRACK-39 P1b own save completes its protocol-2 transaction after its last durable write', async ($, on) => {
  const f = fixture(on)
  const result = await drive(f, checkpoint($))
  // Primary RED: the public save has returned; production catches callback failures.
  expect(protocolViolations(f.locks)).toEqual([])
  expect(f.locks.spawns.length > 0).toBe(true)
  expect(argvViolations(f.locks)).toEqual([])
  expect(result.ok).toBe(true)
  // Zero requests is not success: the save's own grant must name and finish a transaction.
  const grant = ownerOf(f.locks, `set:s:${SESSION}`)
  expect(grant?.config).toBe(CONFIG)
  expect(grant?.path.startsWith(`${CONFIG}/state/track/locks/tx/${grant?.id}.`)).toBe(true)
  for (const event of ['publish:blob', `set:s:${SESSION}`, `set:h:${SESSION}`, 'set:saved', 'set:capacitySizes']) {
    expect({ event, before: windowOf(f.locks, grant!).includes(event) }).toEqual({ event, before: true })
  }
  // Final body, head, index, size-index and blob read-backs all precede the request.
  expect(unverified(f.locks, grant!, [...ownVerification(SESSION),
    ['publish:blob', event => event.startsWith(`read:${CONFIG}/state/track/blobs/`)]])).toEqual([])
  for (const each of f.locks.grants) expect({ id: each.id, ...completion(f.locks, each) }).toEqual({ id: each.id, ...COMPLETED })
  expect(f.locks.timeline.filter(event => event === 'request:unmatched')).toEqual([])
  expect(orderViolations(f.locks.timeline)).toEqual([])
  expect(unconfirmed(f.lines)).toEqual([])
  const stored = f.store.held.get(`s:${SESSION}`) as { v?: number }
  expect(stored.v).toBe(2)
  expect((await f.pool.logical(f.store, `s:${SESSION}`) as { ledger?: unknown }).ledger).toEqual({ ...EMPTY, session_id: SESSION })
})

test('TRACK-39 P1b a held store write holds back its request and the queued classifier gets no overlapping grant', async ($, on) => {
  const f = fixture(on, { holdSet: /^saved$/ })
  const saving = startCheckpoint($)
  let classifying: Promise<string> | undefined
  let held = { waiting: false, requests: -1, writes: -1 }
  try {
    await f.clock.settle()
    held = { waiting: f.hold.waiting, requests: f.locks.requests.length, writes: 0 }
    classifying = command($, 'classifier on')
    await f.clock.settle()
    held.writes = f.locks.timeline.filter(event => event === 'spawn:write').length
  } finally {
    f.hold.release()
    await drive(f, saving.result!).catch(() => undefined)
    if (classifying !== undefined) await drive(f, classifying).catch(() => undefined)
  }
  expect(protocolViolations(f.locks)).toEqual([])
  // While the index write was held: no completion request, and only the saving grant existed.
  expect(held).toEqual({ waiting: true, requests: 0, writes: 1 })
  expect((await saving.result)?.ok).toBe(true)
  expect(await classifying).toBe(ON)
  const save = ownerOf(f.locks, 'set:saved')!
  const classifier = ownerOf(f.locks, 'set:classifier')!
  expect(save.id === classifier.id).toBe(false)
  expect(completion(f.locks, save)).toEqual(COMPLETED)
  expect(completion(f.locks, classifier)).toEqual(COMPLETED)
  expect(f.locks.timeline.indexOf(`close:${save.id}`) < f.locks.timeline.indexOf(`grant:${classifier.id}`)).toBe(true)
  expect(orderViolations(f.locks.timeline)).toEqual([])
})

test('TRACK-39 P1b classifier on and off complete after the classifier, size index and read-back', async ($, on) => {
  const f = fixture(on)
  expect(await drive(f, command($, 'classifier on'))).toBe(ON)
  expect(await drive(f, command($, 'classifier off'))).toBe(OFF)
  expect(protocolViolations(f.locks)).toEqual([])
  expect(f.locks.grants.length).toBe(2)
  for (const grant of f.locks.grants) {
    expect(completion(f.locks, grant)).toEqual(COMPLETED)
    const window = windowOf(f.locks, grant)
    const data = window.lastIndexOf('set:classifier')
    const sizes = window.lastIndexOf('set:capacitySizes')
    const readBack = window.lastIndexOf('get:capacitySizes')
    expect({ data: data >= 0, sizesAfterData: sizes > data, readBackAfterSizes: readBack > sizes }).toEqual({ data: true, sizesAfterData: true, readBackAfterSizes: true })
    expect(unverified(f.locks, grant, [['set:classifier', event => event === 'get:classifier'], ['set:capacitySizes', event => event === 'get:capacitySizes']])).toEqual([])
  }
  expect(f.store.held.get('classifier')).toEqual({ isOn: false })
  expect(orderViolations(f.locks.timeline)).toEqual([])
  expect(unconfirmed(f.lines)).toEqual([])
})

test('TRACK-39 P1b the read-only classifier query starts no helper and writes nothing', async ($, on) => {
  const f = fixture(on, { records: { classifier: { isOn: true } } })
  expect(await drive(f, command($, 'classifier'))).toBe(ON)
  expect(f.locks.spawns).toEqual([])
  expect(f.locks.requests).toEqual([])
  expect(durableEvents(f.locks)).toEqual([])
})

test('TRACK-39 P1b resume completes only after it repaired the durable head', async ($, on) => {
  const question = { id: 1, head: 'acknowledged history', at: 1, turnId: null, status: 'open' as const }
  const before = { ...EMPTY, session_id: SESSION, nextQuestionId: 2, questions: [question] }
  const after = { ...before, nextQuestionId: 3, questions: [question, { ...question, id: 2, head: 'saved before the head write' }] }
  const priorCheckpoint = await describeCheckpoint(before as never, SESSION)
  const body = { v: 1, session_id: SESSION, generation: GENERATION, savedAt: 1, ledger: after, checkpoint: await describeCheckpoint(after as never, SESSION, priorCheckpoint) }
  const f = fixture(on, { records: { [`s:${SESSION}`]: body, [`h:${SESSION}`]: { v: 1, session_id: SESSION, generation: GENERATION, checkpoint: priorCheckpoint } } })
  on('classic.SessionStart', () => ({}))
  await drive(f, $.classic.SessionStart({ source: 'resume', session_id: SESSION } as never))
  expect(protocolViolations(f.locks)).toEqual([])
  expect(f.store.held.get(`h:${SESSION}`)).toEqual({ v: 1, session_id: SESSION, generation: GENERATION, checkpoint: body.checkpoint })
  const grant = ownerOf(f.locks, `set:h:${SESSION}`)
  expect(grant === undefined).toBe(false)
  const window = windowOf(f.locks, grant!)
  expect(window.lastIndexOf(`get:h:${SESSION}`) > window.indexOf(`set:h:${SESSION}`)).toBe(true)
  expect(unverified(f.locks, grant!, [[`set:h:${SESSION}`, event => event === `get:h:${SESSION}`]])).toEqual([])
  expect(completion(f.locks, grant!)).toEqual(COMPLETED)
  expect(orderViolations(f.locks.timeline)).toEqual([])
  expect(unconfirmed(f.lines)).toEqual([])
})

test('TRACK-39 P1b export completes after its bundle write and read-back', async ($, on) => {
  const { body } = await closedBody(FOREIGN)
  const f = fixture(on, { records: { [`s:${FOREIGN}`]: body } })
  const receipt = JSON.parse(await drive(f, command($, 'export /fixture/export.json')))
  expect(protocolViolations(f.locks)).toEqual([])
  expect(receipt.ok).toBe(true)
  expect(receipt.records).toBe(1)
  const grant = ownerOf(f.locks, 'write:/fixture/export.json')
  expect(grant === undefined).toBe(false)
  const window = windowOf(f.locks, grant!)
  expect(window.indexOf('write:/fixture/export.json') < window.lastIndexOf('read:/fixture/export.json')).toBe(true)
  expect(unverified(f.locks, grant!, [['write:/fixture/export.json', event => event === 'read:/fixture/export.json']])).toEqual([])
  expect(completion(f.locks, grant!)).toEqual(COMPLETED)
  expect(orderViolations(f.locks.timeline)).toEqual([])
  expect(unconfirmed(f.lines)).toEqual([])
})

const importBundle = async () => {
  const { body } = await closedBody(TARGET)
  const records = [{ key: `s:${TARGET}`, value: body }]
  return { body, text: JSON.stringify({ v: 1, source_identity: '/fixture-source', checksum: await checksumOf(records), records }) }
}

test('TRACK-39 P1b import completes after its writes and verification', async ($, on) => {
  const bundle = await importBundle()
  const f = fixture(on, { files: new Map([['/fixture/import.json', bundle.text]]), guardStates: { [TARGET]: 'closed' } })
  const receipt = JSON.parse(await drive(f, command($, 'import /fixture/import.json')))
  expect(protocolViolations(f.locks)).toEqual([])
  expect(receipt.reason ?? 'import success').toBe('import success')
  expect(receipt.imported).toEqual([TARGET])
  const grant = ownerOf(f.locks, `set:s:${TARGET}`)
  expect(grant === undefined).toBe(false)
  const window = windowOf(f.locks, grant!)
  for (const event of [`set:h:${TARGET}`, 'set:saved']) expect({ event, before: window.includes(event) }).toEqual({ event, before: true })
  expect(window.lastIndexOf(`get:s:${TARGET}`) > window.indexOf(`set:s:${TARGET}`)).toBe(true)
  // Final verification and every import guard's release precede the request.
  expect(unverified(f.locks, grant!, ownVerification(TARGET))).toEqual([])
  expect(guardsAtRequest(f.locks, grant!)).toEqual({ taken: true, released: true, after: [] })
  expect(completion(f.locks, grant!)).toEqual(COMPLETED)
  expect(orderViolations(f.locks.timeline)).toEqual([])
  expect(unconfirmed(f.lines)).toEqual([])
})

test('TRACK-39 P1b a failed import returns its ok:false receipt and never completes', async ($, on) => {
  const bundle = await importBundle()
  const corrupt = JSON.stringify({ ...JSON.parse(bundle.text), checksum: '0'.repeat(64) })
  const f = fixture(on, { files: new Map([['/fixture/import.json', corrupt]]) })
  const receipt = JSON.parse(await drive(f, command($, 'import /fixture/import.json')))
  expect(protocolViolations(f.locks)).toEqual([])
  expect(receipt.ok).toBe(false)
  expect(receipt.reason).toBe('migration bundle is corrupt or incompatible')
  expect(f.locks.grants.length).toBe(1)
  expect(completion(f.locks, f.locks.grants[0]!)).toEqual(NO_REQUEST)
  expect(f.store.held.has(`s:${TARGET}`)).toBe(false)
  // The next independent transaction is unaffected.
  expect((await drive(f, checkpoint($))).ok).toBe(true)
  expect(completion(f.locks, ownerOf(f.locks, `set:s:${SESSION}`)!)).toEqual(COMPLETED)
})

test('TRACK-39 P1b a refused head write never completes, even after its rollback succeeds', async ($, on) => {
  let refused = false
  const f = fixture(on, { refuseSet: key => {
    if (key !== `h:${SESSION}` || refused) return undefined
    refused = true
    return 'fixture head write refused'
  } })
  const failed = await drive(f, checkpoint($))
  expect(protocolViolations(f.locks)).toEqual([])
  expect(failed.ok).toBe(false)
  const grant = ownerOf(f.locks, `set:h:${SESSION}`)!
  // The rollback ran under the same grant and succeeded: the body it wrote is gone again.
  const window = windowOf(f.locks, grant)
  expect(window.indexOf(`delete:s:${SESSION}`) > window.indexOf(`set:h:${SESSION}`)).toBe(true)
  expect(f.store.held.has(`s:${SESSION}`)).toBe(false)
  expect(completion(f.locks, grant)).toEqual(NO_REQUEST)
  const saved = await drive(f, checkpoint($))
  expect(saved.ok).toBe(true)
  const next = f.locks.grants.at(-1)!
  expect(next.id === grant.id).toBe(false)
  expect(completion(f.locks, next)).toEqual(COMPLETED)
  expect(orderViolations(f.locks.timeline)).toEqual([])
})

test('TRACK-39 P1b a size-index read-back failure inside a kept compaction taints the save that continues', async ($, on) => {
  const { records, sessions, big, guardStates } = await overBudget()
  const original = JSON.stringify(records[`s:${big}`])
  let store: ReturnType<typeof pluginStore> | undefined
  let armed = false
  const f = fixture(on, {
    records, guardStates,
    // The candidate's CLOSED guard comes right before its pointer write: the next size-index
    // write is applied, then its read-back misses, inside the real indexed store.
    beforeLockSpawn: request => {
      if (armed || request.argv[2] !== 'guard' || request.argv[3] !== big) return
      armed = true
      store!.faults.mismatchAfterSet = 'capacitySizes'
    },
  })
  store = f.store
  expect(sessions.length).toBe(4)
  const result = await drive(f, checkpoint($))
  expect(protocolViolations(f.locks)).toEqual([])
  expect(armed).toBe(true)
  expect(f.lines.some(line => line.includes(`compaction keeps ${big}: pointer write failed`) && line.includes('capacity size index read-back mismatch'))).toBe(true)
  expect(JSON.stringify(f.store.held.get(`s:${big}`))).toBe(original)
  expect(result.ok).toBe(true)
  const grant = ownerOf(f.locks, `set:s:${SESSION}`)!
  expect(completion(f.locks, grant)).toEqual(NO_REQUEST)
  expect(orderViolations(f.locks.timeline)).toEqual([])
})

test('TRACK-39 P1b a size-index read-back failure inside foreign cleanup taints the save that continues', async ($, on) => {
  const { body, head } = await closedBody(FOREIGN, 0, Date.now())
  let store: ReturnType<typeof pluginStore> | undefined
  let armed = false
  const f = fixture(on, {
    // No cleanup record, so cleanup is due; no size index, so cleanup's first load publishes one.
    records: { [`s:${FOREIGN}`]: body, [`h:${FOREIGN}`]: head }, guardStates: { [FOREIGN]: 'closed' },
    // Cleanup's CLOSED guard comes right before its size-index load: the fresh index write is
    // applied, then its read-back misses, inside the real indexed store.
    beforeLockSpawn: request => {
      if (armed || request.argv[2] !== 'guard' || request.argv[3] !== FOREIGN) return
      armed = true
      store!.faults.mismatchAfterSet = 'capacitySizes'
    },
  })
  store = f.store
  const result = await drive(f, checkpoint($))
  expect(protocolViolations(f.locks)).toEqual([])
  expect({ armed, consumed: f.store.faults.mismatchAfterSet === '' }).toEqual({ armed: true, consumed: true })
  expect(f.lines.some(line => line.includes(`cleanup keeps ${FOREIGN}; deferred`) && line.includes('capacity size index read-back mismatch'))).toBe(true)
  expect(f.lines.some(line => line.includes('foreign cleanup deferred; caller save continues'))).toBe(true)
  expect(result.ok).toBe(true)
  expect((f.store.held.get(`s:${SESSION}`) as { v?: number }).v).toBe(2)
  expect(f.store.held.get(`s:${FOREIGN}`)).toEqual(body)
  expect(f.store.held.get(`h:${FOREIGN}`)).toEqual(head)
  const grant = ownerOf(f.locks, `set:s:${SESSION}`)!
  expect(completion(f.locks, grant)).toEqual(NO_REQUEST)
  // The one-shot fault is spent; the next independent save completes.
  const retryStart = f.lines.length
  expect((await drive(f, checkpoint($))).ok).toBe(true)
  const later = f.locks.grants.at(-1)!
  expect(later.id === grant.id).toBe(false)
  expect(completion(f.locks, later)).toEqual(COMPLETED)
  expect(unconfirmed(f.lines.slice(retryStart))).toEqual([])
  expect(orderViolations(f.locks.timeline)).toEqual([])
})

test('TRACK-39 P1b a caught foreign cleanup failure keeps the save but never completes it', async ($, on) => {
  const { body, head } = await closedBody(FOREIGN, 0, Date.now())
  const f = fixture(on, {
    records: { [`s:${FOREIGN}`]: body, [`h:${FOREIGN}`]: head }, guardStates: { [FOREIGN]: 'closed' },
    refuseSet: key => key === `h:${FOREIGN}` ? 'fixture foreign head write refused' : undefined,
  })
  const result = await drive(f, checkpoint($))
  expect(protocolViolations(f.locks)).toEqual([])
  expect(f.lines.some(line => line.includes('foreign cleanup deferred; caller save continues'))).toBe(true)
  expect(result.ok).toBe(true)
  expect((f.store.held.get(`s:${SESSION}`) as { v?: number }).v).toBe(2)
  expect(f.store.held.get(`h:${FOREIGN}`)).toEqual(head)
  const grant = ownerOf(f.locks, `set:s:${SESSION}`)!
  expect(windowOf(f.locks, grant).includes(`set:h:${FOREIGN}`)).toBe(true)
  expect(completion(f.locks, grant)).toEqual(NO_REQUEST)
  expect(orderViolations(f.locks.timeline)).toEqual([])
})

// The largest candidate's publication is rejected by its helper receipt, or by its read-back after a
// real publication. Compaction keeps that body and the caller's own save still succeeds.
for (const phase of ['receipt', 'readback'] as const) {
  test(`TRACK-39 P1b a rejected foreign compaction ${phase} keeps that body and never completes the save that continues`, async ($, on) => {
    const { records, big, guardStates } = await overBudget()
    const original = JSON.stringify(records[`s:${big}`])
    const checksum = await sha256(JSON.stringify((records[`s:${big}`] as { ledger: unknown }).ledger))
    const seen: string[] = []
    let cleared = false
    on('process.run', { argv: BLOB_HELPER }, async (_, e, next) => {
      const result = await next(e)
      if (e.argv[4] !== checksum) return result
      seen.push(`helper:${result.deny === undefined && result.value.exitCode === 0 ? 'published' : 'failed'}`)
      if (phase !== 'receipt' || cleared || result.deny !== undefined) return result
      seen.push('receipt-rejected')
      return { ...result, value: { ...result.value, stdout: JSON.stringify({ ok: true, checksum: '0'.repeat(64), bytes: 1 }) } }
    })
    on('fs.read', { path: new RegExp(`/state/track/blobs/${checksum}\\.json$`) }, async (_, e, next) => {
      const result = await next(e)
      seen.push('read')
      if (phase !== 'readback' || cleared || result.deny !== undefined) return result
      seen.push('readback-rejected')
      return { value: `${String(result.value).slice(0, -1)}!` }
    })
    const f = fixture(on, { records, guardStates })
    const result = await drive(f, checkpoint($))
    expect(protocolViolations(f.locks)).toEqual([])
    expect(seen).toEqual(phase === 'receipt' ? ['helper:published', 'receipt-rejected'] : ['helper:published', 'read', 'readback-rejected'])
    const why = phase === 'receipt' ? 'blob helper receipt does not match the ledger' : 'published blob does not match the ledger'
    expect(f.lines.some(line => line.includes(`compaction keeps ${big}: ${why}`))).toBe(true)
    expect(JSON.stringify(f.store.held.get(`s:${big}`))).toBe(original)
    expect(result.ok).toBe(true)
    expect((f.store.held.get(`s:${SESSION}`) as { v?: number }).v).toBe(2)
    const grant = ownerOf(f.locks, `set:s:${SESSION}`)!
    expect(completion(f.locks, grant)).toEqual(NO_REQUEST)
    expect(orderViolations(f.locks.timeline)).toEqual([])
    cleared = true
    const retryStart = f.lines.length
    expect((await drive(f, checkpoint($))).ok).toBe(true)
    const later = f.locks.grants.at(-1)!
    expect(later.id === grant.id).toBe(false)
    expect(completion(f.locks, later)).toEqual(COMPLETED)
    expect(unconfirmed(f.lines.slice(retryStart))).toEqual([])
    expect(orderViolations(f.locks.timeline)).toEqual([])
  })
}

test('TRACK-39 P1b an aborted blob publication with the inline fallback never completes; a published save does', async ($, on) => {
  let publishes = 0
  const f = fixture(on, { failPublish: () => ++publishes === 1 })
  const inline = await drive(f, checkpoint($))
  expect(protocolViolations(f.locks)).toEqual([])
  expect(inline.ok).toBe(true)
  expect((f.store.held.get(`s:${SESSION}`) as { v?: number }).v).toBe(1)
  expect(f.lines.some(line => line.includes('saved inline because blob storage is unavailable'))).toBe(true)
  const fallback = ownerOf(f.locks, 'publish:blob')!
  expect(completion(f.locks, fallback)).toEqual(NO_REQUEST)
  const published = await drive(f, checkpoint($))
  expect(published.ok).toBe(true)
  expect((f.store.held.get(`s:${SESSION}`) as { v?: number }).v).toBe(2)
  const next = f.locks.grants.at(-1)!
  expect(next.id === fallback.id).toBe(false)
  expect(windowOf(f.locks, next).includes('publish:blob')).toBe(true)
  expect(completion(f.locks, next)).toEqual(COMPLETED)
  expect(orderViolations(f.locks.timeline)).toEqual([])
})

const WRITE_FAULTS: GrantFault[] = ['legacy', 'protocol-1', 'flat', 'no-transaction', 'bad-id', 'bad-nonce', 'upper-nonce', 'wrong-token', 'wrong-mode', 'oversized']
for (const fault of WRITE_FAULTS) {
  test(`TRACK-39 P1b a ${fault} write grant permits no durable work`, async ($, on) => {
    const f = fixture(on, { locks: { grantFault: mode => mode === 'write' ? fault : undefined } })
    const result = await drive(f, checkpoint($))
    expect(protocolViolations(f.locks)).toEqual([])
    expect(result.ok).toBe(false)
    expect(f.locks.grants.length > 0).toBe(true)
    expect(durableEvents(f.locks)).toEqual([])
    expect(f.locks.requests).toEqual([])
    expect(f.store.held.size).toBe(0)
  })
}

test('TRACK-39 P1b a legacy lease receipt under protocol 2 permits no write', async ($, on) => {
  const f = fixture(on, { locks: { grantFault: mode => mode === 'lease' ? 'legacy' : undefined } })
  const result = await drive(f, checkpoint($))
  expect(protocolViolations(f.locks)).toEqual([])
  expect(result.ok).toBe(false)
  expect(f.locks.timeline.includes('spawn:write')).toBe(false)
  expect(durableEvents(f.locks)).toEqual([])
})

test('TRACK-39 P1b a protocol-1 guard receipt refuses the import before any target write', async ($, on) => {
  const bundle = await importBundle()
  const f = fixture(on, { files: new Map([['/fixture/import.json', bundle.text]]), guardStates: { [TARGET]: 'closed' },
    locks: { grantFault: mode => mode === 'guard' ? 'protocol-1' : undefined } })
  const receipt = JSON.parse(await drive(f, command($, 'import /fixture/import.json')))
  expect(protocolViolations(f.locks)).toEqual([])
  expect(receipt.ok).toBe(false)
  expect(f.locks.timeline.includes('spawn:guard')).toBe(true)
  expect(durableEvents(f.locks).filter(event => event.includes(TARGET))).toEqual([])
  for (const grant of f.locks.grants) expect(completion(f.locks, grant)).toEqual(NO_REQUEST)
})

test('TRACK-39 P1b fragmented protocol-2 receipts still grant and complete', async ($, on) => {
  const f = fixture(on, { splitLockReceipt: true })
  const result = await drive(f, checkpoint($))
  expect(protocolViolations(f.locks)).toEqual([])
  expect(result.ok).toBe(true)
  expect(f.locks.grants.length > 0).toBe(true)
  for (const grant of f.locks.grants) expect(completion(f.locks, grant)).toEqual(COMPLETED)
  expect(orderViolations(f.locks.timeline)).toEqual([])
  expect(unconfirmed(f.lines)).toEqual([])
})

// After its request, a transaction is confirmed only by its own named acknowledgement and a normal exit.
// A refused receipt, or one with a wrong nonce, transaction, protocol, mode or token, already decides it,
// so the client may close the stream without reading the helper's exit; an end of stream, a nonzero exit
// or a signal decides only at the exit.
const UNCONFIRMED_ACKS: Array<[LockAck, { ack: boolean; exit?: string }]> = [
  ['refuse', { ack: false }], ['wrong-nonce', { ack: true }], ['stale', { ack: true }],
  ['wrong-protocol', { ack: true }], ['wrong-mode', { ack: true }], ['wrong-token', { ack: true }],
  ['eof', { ack: false, exit: '0' }], ['nonzero', { ack: true, exit: '1' }], ['signal', { ack: true, exit: 'SIGKILL' }],
]
for (const [ack, seen] of UNCONFIRMED_ACKS) {
  test(`TRACK-39 P1b a ${ack} answer leaves the completion unconfirmed without a same-id retry`, async ($, on) => {
    const f = fixture(on, { locks: { ack: grant => f.locks.grants.indexOf(grant) === 0 ? ack : 'normal' } })
    const result = await drive(f, checkpoint($))
    expect(protocolViolations(f.locks)).toEqual([])
    // The save's own outcome stands; only its completion is unconfirmed.
    expect(result.ok).toBe(true)
    const first = f.locks.grants[0]!
    const { exit, ...decided } = completion(f.locks, first)
    expect({ ...decided, ...(seen.exit !== undefined && { exit }) }).toEqual({ requests: ['nonce'], ...seen })
    expect(f.lines.some(line => line.includes(UNCONFIRMED))).toBe(true)
    // Its stream is closed before the next transaction's grant.
    expect(f.locks.timeline.includes(`close:${first.id}`)).toBe(true)
    const retryStart = f.lines.length
    const next = await drive(f, checkpoint($))
    expect(next.ok).toBe(true)
    expect(completion(f.locks, first).requests).toEqual(['nonce'])
    const later = f.locks.grants.at(-1)!
    expect(later.id === first.id).toBe(false)
    expect(f.locks.timeline.indexOf(`close:${first.id}`) < f.locks.timeline.indexOf(`grant:${later.id}`)).toBe(true)
    expect(completion(f.locks, later)).toEqual(COMPLETED)
    // The healthy retry is confirmed, not merely free of errors.
    expect(unconfirmed(f.lines.slice(retryStart))).toEqual([])
    expect(orderViolations(f.locks.timeline)).toEqual([])
  })
}

test('TRACK-39 P1b a refused completion request is attempted once and stays unconfirmed', async ($, on) => {
  let refusals = 0
  const f = fixture(on, { locks: { refuseRequest: () => ++refusals === 1 ? 'fixture request write refused' : undefined } })
  const result = await drive(f, checkpoint($))
  expect(protocolViolations(f.locks)).toEqual([])
  expect(result.ok).toBe(true)
  const first = f.locks.grants[0]!
  expect(completion(f.locks, first)).toEqual({ requests: ['nonce'], ack: false, exit: undefined })
  expect(f.lines.some(line => line.includes(UNCONFIRMED))).toBe(true)
  const retryStart = f.lines.length
  expect((await drive(f, checkpoint($))).ok).toBe(true)
  expect(completion(f.locks, first).requests).toEqual(['nonce'])
  const later = f.locks.grants.at(-1)!
  expect(later.id === first.id).toBe(false)
  expect(completion(f.locks, later)).toEqual(COMPLETED)
  expect(unconfirmed(f.lines.slice(retryStart))).toEqual([])
})

test('TRACK-39 P1b a missing acknowledgement times out 2000 ms after the request', async ($, on) => {
  let releaseAck = () => {}
  const ackHold = new Promise<void>(resolve => { releaseAck = resolve })
  let releaseWrite = () => {}
  const writeHold = new Promise<void>(resolve => { releaseWrite = resolve })
  // Holds the first completion request's own write, so its 2000 ms can start only once that write is done.
  let writes = 0
  on('fs.write', { path: TX_REQUEST }, async (_, e, next) => {
    if (++writes === 1) await writeHold
    return next(e)
  })
  const f = fixture(on, { locks: { ackHold, ack: grant => f.locks.grants.indexOf(grant) === 0 ? 'hold' : 'normal' } })
  const saving = startCheckpoint($)
  let violations: string[] = []
  const seen = { writing: -1, whileWriting: true, requests: -1, written: true, before: true, at: false }
  try {
    await f.clock.settle()
    violations = protocolViolations(f.locks)
    seen.writing = writes
    await f.clock.advance(3000)
    seen.whileWriting = saving.finished
    releaseWrite()
    await f.clock.settle()
    seen.requests = f.locks.requests.length
    seen.written = saving.finished
    await f.clock.advance(1999)
    seen.before = saving.finished
    await f.clock.advance(1)
    seen.at = saving.finished
  } finally {
    releaseWrite()
    releaseAck()
    await drive(f, saving.result!)
  }
  expect(violations).toEqual([])
  expect(seen).toEqual({ writing: 1, whileWriting: false, requests: 1, written: false, before: false, at: true })
  expect((await saving.result)?.ok).toBe(true)
  const first = f.locks.grants[0]!
  expect(completion(f.locks, first)).toEqual({ requests: ['nonce'], ack: false, exit: undefined })
  expect(f.lines.some(line => line.includes(UNCONFIRMED))).toBe(true)
  expect((await drive(f, checkpoint($))).ok).toBe(true)
  expect(completion(f.locks, first).requests).toEqual(['nonce'])
  const later = f.locks.grants.at(-1)!
  expect(later.id === first.id).toBe(false)
  expect(completion(f.locks, later)).toEqual(COMPLETED)
})

// The engine collapses '.' segments in file paths before any hook sees them, so a changed
// CLAUDE_CONFIG_DIR is what tells a re-resolved request path apart: it changes once the write grant
// spawned. Blob publication may resolve either string; both reach the one in-memory pool.
test('TRACK-39 P1b the request path keeps the exact config string passed to the helper', async ($, on) => {
  const config = '/fixture/lock-config'
  let spawned = false
  on('env.get', { name: /^CLAUDE_CONFIG_DIR$/ }, (_, e, next) => spawned ? next(e) : { value: config })
  const toPool = (text: string) => text.replace(`${config}/state/track/blobs`, `${CONFIG}/state/track/blobs`)
  on('process.run', { argv: BLOB_HELPER }, (_, e, next) => next({ ...e, argv: e.argv.map(toPool) }))
  on('fs.read', { path: /^\/fixture\/lock-config\/state\/track\/blobs\// }, (_, e, next) => next({ ...e, path: toPool(e.path) }))
  const f = fixture(on, { beforeLockSpawn: request => { if (request.argv[2] === 'write') spawned = true } })
  // A request at any other path gets no acknowledgement; its deadline or the deadman ends the save.
  const result = await drive(f, checkpoint($))
  expect(protocolViolations(f.locks, config)).toEqual([])
  expect(spawned).toBe(true)
  expect(result.ok).toBe(true)
  expect(f.locks.grants.length > 0).toBe(true)
  for (const grant of f.locks.grants) {
    expect(grant.config).toBe(config)
    expect(f.locks.requests.filter(request => request.path.startsWith(`${config}/state/track/locks/tx/${grant.id}.`)).length).toBe(1)
    expect(completion(f.locks, grant)).toEqual(COMPLETED)
  }
  expect(f.locks.timeline.filter(event => event === 'request:unmatched')).toEqual([])
  expect(orderViolations(f.locks.timeline)).toEqual([])
})

// An absolute HOME with no CLAUDE_CONFIG_DIR selects HOME/.claude, as stop-gate.py and writer-lock.py do.
test('TRACK-39 P1b an absolute HOME with no CLAUDE_CONFIG_DIR locks and completes under HOME/.claude', async ($, on) => {
  const config = '/fixture/home/.claude'
  on('env.get', { name: /^CLAUDE_CONFIG_DIR$/ }, () => ({ value: undefined }))
  on('env.get', { name: /^HOME$/ }, () => ({ value: '/fixture/home' }))
  const f = fixture(on, { config })
  const result = await drive(f, checkpoint($))
  expect(protocolViolations(f.locks, config)).toEqual([])
  expect(f.locks.spawns.length > 0).toBe(true)
  expect(result.ok).toBe(true)
  expect((f.store.held.get(`s:${SESSION}`) as { v?: number }).v).toBe(2)
  for (const grant of f.locks.grants) {
    expect(grant.path.startsWith(`${config}/state/track/locks/tx/${grant.id}.`)).toBe(true)
    expect(completion(f.locks, grant)).toEqual(COMPLETED)
  }
  expect(orderViolations(f.locks.timeline)).toEqual([])
  expect(unconfirmed(f.lines)).toEqual([])
})

// Neither CLAUDE_CONFIG_DIR nor HOME, or a relative CLAUDE_CONFIG_DIR: there is no lock config.
for (const [kind, value] of [['missing', undefined], ['relative', 'fixture/config']] as const) {
  test(`TRACK-39 P1b a ${kind} lock config refuses the save before any helper or store call; a valid config saves later`, async ($, on) => {
    let unavailable = true
    on('env.get', { name: /^CLAUDE_CONFIG_DIR$/ }, (_, e, next) => unavailable ? { value } : next(e))
    const { body, head } = await closedBody(FOREIGN)
    const f = fixture(on, { records: { [`s:${FOREIGN}`]: body, [`h:${FOREIGN}`]: head }, guardStates: { [FOREIGN]: 'closed' } })
    const before = JSON.stringify([...f.store.held])
    const result = await drive(f, checkpoint($))
    expect(result.ok).toBe(false)
    expect(String(result.reason)).toContain(LOCK_CONFIG)
    expect(f.lines.some(line => line.includes('unsaved') && line.includes(LOCK_CONFIG))).toBe(true)
    expect(f.locks.spawns).toEqual([])
    expect(f.locks.requests).toEqual([])
    expect(durableEvents(f.locks)).toEqual([])
    expect(f.pool.publishes).toBe(0)
    expect(JSON.stringify([...f.store.held])).toBe(before)
    unavailable = false
    const saved = await drive(f, checkpoint($))
    expect(protocolViolations(f.locks)).toEqual([])
    expect(saved.ok).toBe(true)
    expect(completion(f.locks, ownerOf(f.locks, `set:s:${SESSION}`)!)).toEqual(COMPLETED)
    expect(orderViolations(f.locks.timeline)).toEqual([])
  })
}

test('TRACK-39 P1b a save started while a transaction is sealed gets its own later grant', async ($, on) => {
  let during: ReturnType<typeof startCheckpoint> | undefined
  const f = fixture(on, { locks: { onRequest: request => {
    if (during === undefined && request.grant !== undefined) during = startCheckpoint($)
  } } })
  const first = await drive(f, checkpoint($))
  expect(protocolViolations(f.locks)).toEqual([])
  expect(first?.ok).toBe(true)
  expect(during === undefined).toBe(false)
  expect((await drive(f, during!.result!))?.ok).toBe(true)
  const [sealed, later] = f.locks.grants
  expect(later === undefined).toBe(false)
  expect(sealed!.id === later!.id).toBe(false)
  expect(completion(f.locks, sealed!)).toEqual(COMPLETED)
  expect(completion(f.locks, later!)).toEqual(COMPLETED)
  expect(f.locks.timeline.indexOf(`close:${sealed!.id}`) < f.locks.timeline.indexOf(`grant:${later!.id}`)).toBe(true)
  expect(orderViolations(f.locks.timeline)).toEqual([])
})

// As in track.test.tsx's rewind-redraw test: a PromptHint redraw schedules the real rewind check
// (REWIND_CHECK_DELAY_MS, 1000 ms). Here it fires while the first save waits, sealed, for its
// acknowledgement, and drops a question whose tracking call left the transcript.
const REWOUND = {
  ...EMPTY, session_id: SESSION, nextQuestionId: 3,
  questions: [
    { id: 1, head: 'kept question', at: 1000, turnId: 't1', status: 'open', trackedBy: 'toolu_kept', session_id: SESSION },
    { id: 2, head: 'rewound question', at: 1200, turnId: 't2', status: 'open', trackedBy: 'toolu_rewound', session_id: SESSION },
  ],
}
const AFTER_REWIND = [
  { role: 'user' as const, text: 'is the first question kept?', toolUses: [] },
  { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'toolu_kept', tool: 'mcp__track__track_question', input: { summary: 'kept question' } }] },
]
const PROMPT_HINT = { plugin: 'track', surface: 'terminal' as const, component: 'PromptHint' as const, requestId: 'hint', props: { isDraft: true, isWorking: false, hint: '' } }
test('TRACK-39 P1b a rewind timer that fires while a transaction is sealed saves under its own later grant', async ($, on) => {
  let releaseAck = () => {}
  const ackHold = new Promise<void>(resolve => { releaseAck = resolve })
  let mounting: Promise<unknown> | undefined
  const f = fixture(on, { ledger: REWOUND, locks: {
    ackHold, ack: grant => f.locks.grants.indexOf(grant) === 0 ? 'hold' : 'normal',
    onRequest: request => { if (mounting === undefined && request.grant !== undefined) mounting = $.ui.mount(PROMPT_HINT) },
  } })
  on('session.messages', () => ({ value: AFTER_REWIND }))
  on('ui.render', { component: 'PromptHint' }, () => ({ type: 'Text', props: {}, children: ['hint'] }))
  const questions = () => (f.ledger.value.questions as Array<{ id: number }>).map(question => question.id)
  // Past REWIND_CHECK_GAP_MS, so the first redraw schedules its check.
  await f.clock.advance(3000)
  const saving = startCheckpoint($)
  const sealed = { mounted: false, memory: [] as number[], grants: -1, afterRequest: ['unread'] }
  try {
    await f.clock.settle()
    sealed.mounted = mounting !== undefined
    await mounting
    await f.clock.settle()
    await f.clock.advance(1000)
    await f.clock.settle()
    sealed.memory = questions()
    sealed.grants = f.locks.grants.length
    const first = f.locks.grants[0]
    const interval = first === undefined ? [] : intervalOf(f.locks, first)
    sealed.afterRequest = interval.slice(interval.indexOf(`request:${first?.id}`) + 1).filter(event => DURABLE.test(event) || event.startsWith('grant:'))
  } finally {
    releaseAck()
    await f.clock.settle()
    await mounting
    await drive(f, saving.result!)
    await closeAll(f)
  }
  expect(protocolViolations(f.locks)).toEqual([])
  // While sealed: the timer already dropped the rewound row in memory, and no second grant or
  // durable work followed the first request.
  expect(sealed).toEqual({ mounted: true, memory: [1], grants: 1, afterRequest: [] })
  expect((await saving.result)?.ok).toBe(true)
  const [first, later] = f.locks.grants
  expect(later === undefined).toBe(false)
  expect(first!.id === later!.id).toBe(false)
  expect(f.locks.timeline.indexOf(`close:${first!.id}`) < f.locks.timeline.indexOf(`grant:${later!.id}`)).toBe(true)
  expect(completion(f.locks, first!)).toEqual(COMPLETED)
  expect(completion(f.locks, later!)).toEqual(COMPLETED)
  expect(windowOf(f.locks, later!).includes(`set:s:${SESSION}`)).toBe(true)
  const stored = await f.pool.logical(f.store, `s:${SESSION}`) as { ledger?: { questions?: Array<{ id: number }> } }
  expect((stored.ledger?.questions ?? []).map(question => question.id)).toEqual([1])
  expect(orderViolations(f.locks.timeline)).toEqual([])
  expect(unconfirmed(f.lines)).toEqual([])
})

// FIXTURE self-checks: the kit's helper stream must not hide a wrong client. As in
// kit-blob-pool.test.tsx, they record the kit's registrations and call them directly.
type Registration = { event: string; matcher?: { path?: RegExp }; hook: (capabilities: unknown, input: { path: string; text: string }) => unknown }
const recordKit = () => {
  const registrations: Registration[] = []
  const on = ((event: string, ...rest: unknown[]) => {
    registrations.push({ event, ...(rest.length === 2 && { matcher: rest[0] as Registration['matcher'] }), hook: rest.at(-1) as Registration['hook'] })
  }) as unknown as On
  const locks = writerLocks(on)
  const request = registrations.find(registration => registration.event === 'fs.write')!
  return { locks, request, write: (path: string, text: string) => request.hook(undefined, { path, text }) }
}
const lockRequest = (mode: string, env?: Record<string, string>) =>
  ({ argv: ['python3', '/fixture/track/hooks/writer-lock.py', mode, SESSION, 'fixture-token'], cwd: '/fixture/track', ...(env !== undefined && { env }) })
const PROTOCOL_2 = { TRACK_LOCK_PROTOCOL: '2', CLAUDE_CONFIG_DIR: CONFIG }

test('kit: without protocol 2 the lock stream answers the legacy receipt byte for byte', async () => {
  const kit = recordKit()
  const stream = kit.locks.serve(lockRequest('write'), new AbortController().signal)
  expect(await stream.next()).toEqual({ done: false, value: { stream: 'stdout', text: '{"ok":true,"mode":"write","token":"fixture-token"}' } })
  expect(await stream.next()).toEqual({ done: true, value: { value: { code: 0, signal: null } } })
  expect(kit.locks.grants).toEqual([])
})

test('kit: only the exact nonce at the grant\'s own path completes that grant', async () => {
  const kit = recordKit()
  const first = kit.locks.serve(lockRequest('write', PROTOCOL_2), new AbortController().signal)
  const closing = new AbortController()
  const second = kit.locks.serve(lockRequest('write', PROTOCOL_2), closing.signal)
  const firstGrant = JSON.parse(((await first.next()).value as { text: string }).text)
  const secondGrant = JSON.parse(((await second.next()).value as { text: string }).text)
  expect(Object.keys(firstGrant)).toEqual(['ok', 'protocol', 'mode', 'token', 'transaction'])
  expect(firstGrant.transaction.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(firstGrant.transaction.nonce).toMatch(/^[0-9a-f]{64}$/)
  expect(secondGrant.transaction.id === firstGrant.transaction.id || secondGrant.transaction.nonce === firstGrant.transaction.nonce).toBe(false)
  const [a, b] = kit.locks.grants
  expect(a!.path).toBe(`${CONFIG}/state/track/locks/tx/${a!.id}.${a!.nonce}.complete`)
  expect(kit.request.matcher?.path?.test(a!.path)).toBe(true)
  const pending = first.next()
  // A different nonce, a newline, another grant's nonce: P1a keeps all of them pending.
  kit.write(a!.path, b!.nonce)
  kit.write(a!.path, `${a!.nonce}\n`)
  kit.write(b!.path, a!.nonce)
  await Promise.resolve()
  expect([a!.requested, b!.requested]).toEqual([false, false])
  kit.write(a!.path, a!.nonce)
  expect(await pending).toEqual({ done: false, value: { stream: 'stdout', text: `${JSON.stringify({ ok: true, protocol: 2, mode: 'completed', token: 'fixture-token', transaction: { id: a!.id, nonce: a!.nonce } })}\n` } })
  expect(await first.next()).toEqual({ done: true, value: { value: { code: 0, signal: null } } })
  // The unanswered grant ends when its client closes the stream, without an acknowledgement.
  const unanswered = second.next()
  closing.abort()
  expect(await unanswered).toEqual({ done: true, value: { value: { code: null, signal: 'SIGTERM' } } })
  expect(b!.requested).toBe(false)
  expect(kit.locks.timeline.includes(`ack:${b!.id}`)).toBe(false)
  expect(kit.locks.timeline.includes(`close:${b!.id}`)).toBe(true)
})

test('kit: other tx-directory paths are not completion requests, so they pass on', () => {
  const kit = recordKit()
  const stray = [`${CONFIG}/state/track/locks/tx/not-a-request.complete`, `${CONFIG}/state/track/locks/tx/${crypto.randomUUID().toUpperCase()}.${'a'.repeat(64)}.complete`,
    `${CONFIG}/state/track/locks/tx/${crypto.randomUUID()}.${'A'.repeat(64)}.complete`, `${CONFIG}/state/track/locks/tx/${crypto.randomUUID()}.json`]
  // The matcher keeps them away from the request hook, so the providers beneath receive them.
  for (const path of stray) expect({ path, matched: kit.request.matcher?.path?.test(path) }).toEqual({ path, matched: false })
  expect(kit.locks.requests).toEqual([])
})

test('oracle: a read-back after the request does not count as the final verification', () => {
  const verify: Array<[string, (event: string) => boolean]> = [['set:saved', event => event === 'get:saved']]
  const late = ['grant:x', 'set:saved', 'get:saved', 'request:x', 'get:saved', 'close:x']
  expect(unverified({ timeline: late }, { id: 'x' }, verify)).toEqual(['set:saved is not read back before the request'])
  const final = ['grant:x', 'set:saved', 'get:saved', 'get:saved', 'request:x', 'close:x', 'get:saved']
  expect(unverified({ timeline: final }, { id: 'x' }, verify)).toEqual([])
})

test('kit: the deadman ends an unanswered grant with SIGKILL, never an acknowledgement', async () => {
  const kit = recordKit()
  const stream = kit.locks.serve(lockRequest('write', PROTOCOL_2), new AbortController().signal)
  await stream.next()
  const [grant] = kit.locks.grants
  const pending = stream.next()
  kit.locks.deadman()
  expect(await pending).toEqual({ done: true, value: { value: { code: null, signal: 'SIGKILL' } } })
  expect(kit.locks.timeline.includes(`ack:${grant!.id}`)).toBe(false)
  expect(kit.locks.timeline.includes(`deadman:${grant!.id}`)).toBe(true)
})
