import type { TestBody } from 'claude-code/testing'
import type { PluginState } from 'claude-code'

// Stand-ins the track tests share: a state atom and the plugin's store, each held in the test.

export type Engine = Parameters<TestBody>[0]
export type On = Parameters<TestBody>[1]
export type StateKey = keyof PluginState['track']

export const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

export const EMPTY = { v: 1 as const, nextQuestionId: 1, prompts: [], questions: [], steps: [] }

// The test engine dispatches the event directly; real slash commands stamp these fields.
export const trackCommand = ($: Engine, args: string) => $.command.run({
  command: 'track', args, origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
})

// A direct test event needs the metadata the host stamps on a person's Enter.
export const trackPrompt = ($: Engine, text: string) => $.prompt.submit({
  text, wait: false, origin: { kind: 'composer' },
})

// The track pane's render event, docked beside the transcript or inline above the prompt.
export const pane = (placement: 'dock' | 'inline', bodyColumns = 60, bodyRows = 20) => ({
  plugin: 'track',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'track',
  viewport: { columns: 120, rows: 40, isFullscreen: placement === 'dock' },
  props: { title: 'Track', isFocused: false, bodyColumns, placement, scroll: { offset: 0, bodyRows }, view: {} },
})

// One state atom: every read sees the last write, each write is recorded, and a write given
// `ifVersion` misses once another write beat it, as the engine's compare-and-set does.
// `holdReads` holds the first that many reads until all of them arrived, so two calls in flight
// both read the same version before either writes.
export const atomStore = <T>(on: On, key: StateKey, initial: T, options: { holdReads?: number } = {}) => {
  const held = { value: initial, version: 1, writes: [] as T[] }
  let waiting = options.holdReads ?? 0
  const arrived: Array<() => void> = []
  on('state.get', { plugin: 'track', key: [key] }, async () => {
    if (waiting > 0) {
      waiting--
      await new Promise<void>(resolve => {
        arrived.push(resolve)
        if (waiting === 0) for (const go of arrived) go()
      })
    }

    return { value: { value: held.value, version: held.version } }
  })
  on('state.set', { plugin: 'track', key: [key] }, (_, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== held.version) {
      return { value: { isSet: false as const, version: held.version } }
    }
    held.value = e.value as T
    held.version += 1
    held.writes.push(e.value as T)

    return { value: { isSet: true as const, version: held.version } }
  })

  return held
}

type LockRequest = { argv: readonly string[]; cwd?: string; env?: Record<string, string> }
type LockChunk = { stream: 'stdout' | 'stderr'; text: string }
type LockEnd = { value: { code: number | null; signal: 'SIGTERM' | 'SIGKILL' | null } }
// How the fixture helper answers a protocol-2 write once its exact request arrived. The wrong-protocol,
// wrong-mode and wrong-token receipts name the right transaction and exit normally.
export type LockAck = 'normal' | 'hold' | 'refuse' | 'wrong-nonce' | 'stale' | 'wrong-protocol' | 'wrong-mode' | 'wrong-token' | 'eof' | 'nonzero' | 'signal'
// A protocol-2 receipt the client must refuse before any durable work.
export type GrantFault = 'legacy' | 'protocol-1' | 'flat' | 'no-transaction' | 'bad-id' | 'bad-nonce' | 'upper-nonce' | 'wrong-token' | 'wrong-mode' | 'oversized'
export type LockGrant = { id: string; nonce: string; token: string; config: string | undefined; path: string; fault?: GrantFault; requested: boolean; arrived: Promise<void>; arrive: () => void }
export type WriterLockOptions = {
  ack?: (grant: LockGrant) => LockAck
  // 'hold' waits for this before answering; a client that closes the stream ends the wait.
  ackHold?: Promise<void>
  grantFault?: (mode: string) => GrantFault | undefined
  refuseRequest?: (path: string) => string | undefined
  onRequest?: (request: { path: string; text: string; grant?: LockGrant }) => void
}

// The completion request P1a's helper polls for: <tx>/<UUID4 id>.<64 lowercase hex nonce>.complete.
// Any other path, in the tx directory or not, passes on to the providers beneath.
export const TX_REQUEST = /\/state\/track\/locks\/tx\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}\.complete$/
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('')
// Resolves 'done' once `wait` settles, 'closed' once the client closed the stream instead, or
// 'dead' once the deadman fired.
const until = (wait: Promise<void>, signal: AbortSignal, dead: Promise<void>): Promise<'done' | 'closed' | 'dead'> => signal.aborted ? Promise.resolve('closed') : new Promise(resolve => {
  const closed = () => resolve('closed')
  signal.addEventListener('abort', closed, { once: true })
  void wait.then(() => {
    signal.removeEventListener('abort', closed)
    resolve('done')
  })
  void dead.then(() => {
    signal.removeEventListener('abort', closed)
    resolve('dead')
  })
})

// FIXTURE: writer-lock.py's receipts in memory. Without TRACK_LOCK_PROTOCOL=2 in the spawn's env
// it answers the legacy receipt byte for byte. With it, a write grant names a fresh transaction and
// the stream waits for that grant's exact completion request (the nonce, no newline, at the config
// string the client passed) before it acknowledges and exits. Real flock, markers and fsync are
// exercised by the helper tests.
export const writerLocks = (on: On, options: WriterLockOptions = {}) => {
  const spawns: LockRequest[] = []
  const grants: LockGrant[] = []
  const requests: Array<{ path: string; text: string }> = []
  // Lock, request and (through pluginStore) store events in the order they happened.
  const timeline: string[] = []
  // A test driver's last resort for a client stuck on a stationary clock: every open protocol-2 wait
  // ends with SIGKILL and `deadman:<id>`, never with an acknowledgement.
  let deadman = () => {}
  const dead = new Promise<void>(resolve => { deadman = () => {
    timeline.push('deadman')
    resolve()
  } })
  const ended = (grant: LockGrant, why: 'closed' | 'dead'): LockEnd => {
    if (why === 'closed') return { value: { code: null, signal: 'SIGTERM' } }
    timeline.push(`deadman:${grant.id}`)
    return { value: { code: null, signal: 'SIGKILL' } }
  }
  on('fs.write', { path: TX_REQUEST }, (_, e) => {
    const text = String(e.text)
    const grant = grants.find(candidate => candidate.path === e.path)
    requests.push({ path: e.path, text })
    timeline.push(`request:${grant?.id ?? 'unmatched'}`)
    const refusal = options.refuseRequest?.(e.path)
    if (refusal !== undefined) return { deny: refusal }
    // P1a leaves a partial or different request pending: only the exact nonce wakes its own grant.
    if (grant !== undefined && text === grant.nonce && !grant.requested) {
      grant.requested = true
      grant.arrive()
    }
    options.onRequest?.({ path: e.path, text, grant })
    return { value: undefined }
  })
  const receipt = (e: LockRequest, mode: string, token: string, state: string | undefined, grant: LockGrant | undefined) => {
    const fault = e.env?.TRACK_LOCK_PROTOCOL === '2' ? options.grantFault?.(mode) : undefined
    if (e.env?.TRACK_LOCK_PROTOCOL !== '2' || fault === 'legacy') return { ok: true, mode, token, ...(state !== undefined && { state }) }
    const transaction = grant === undefined ? undefined : {
      id: fault === 'bad-id' ? `${grant.id.slice(0, 14)}1${grant.id.slice(15)}` : grant.id,
      nonce: fault === 'bad-nonce' ? grant.nonce.slice(1) : fault === 'upper-nonce' ? grant.nonce.toUpperCase() : grant.nonce,
    }
    return {
      ok: true, protocol: fault === 'protocol-1' ? 1 : 2, mode: fault === 'wrong-mode' ? 'lease' : mode,
      token: fault === 'wrong-token' ? `${token}-other` : token, ...(state !== undefined && { state }),
      ...(transaction !== undefined && fault !== 'no-transaction' && (fault === 'flat' ? transaction : { transaction })),
      ...(fault === 'oversized' && { padding: 'x'.repeat(4096) }),
    }
  }
  // One writer-lock.py child as its stream. `shape` carries pluginStore's legacy options.
  async function* serve(e: LockRequest, signal: AbortSignal, shape: { refusal?: string; state?: string; split?: boolean; ending?: Promise<void> } = {}): AsyncGenerator<LockChunk, LockEnd> {
    const [, , mode = '', , token = ''] = e.argv
    const isProtocol2 = e.env?.TRACK_LOCK_PROTOCOL === '2'
    spawns.push({ argv: [...e.argv], cwd: e.cwd, ...(e.env !== undefined && { env: { ...e.env } }) })
    timeline.push(`spawn:${mode}`)
    let grant: LockGrant | undefined
    if (isProtocol2 && mode === 'write' && shape.refusal === undefined) {
      const id = crypto.randomUUID()
      const nonce = randomHex(32)
      let arrive = () => {}
      const arrived = new Promise<void>(resolve => { arrive = resolve })
      const fault = options.grantFault?.(mode)
      grant = { id, nonce, token, config: e.env?.CLAUDE_CONFIG_DIR, path: `${e.env?.CLAUDE_CONFIG_DIR}/state/track/locks/tx/${id}.${nonce}.complete`, ...(fault !== undefined && { fault }), requested: false, arrived, arrive }
      grants.push(grant)
    }
    try {
      const text = JSON.stringify(shape.refusal !== undefined ? { ok: false, reason: shape.refusal } : receipt(e, mode, token, shape.state, grant))
      timeline.push(grant === undefined ? `receipt:${mode}` : `grant:${grant.id}`)
      if (shape.split) {
        yield { stream: 'stderr' as const, text: 'A harmless diagnostic\n' }
        yield { stream: 'stdout' as const, text: text.slice(0, 5) }
        yield { stream: 'stdout' as const, text: text.slice(5) + '\n' }
      } else {
        // The real helper ends each protocol-2 record with a newline.
        yield { stream: 'stdout' as const, text: isProtocol2 ? `${text}\n` : text }
      }
      if (shape.ending !== undefined) await shape.ending
      // Testing hooks wrap their final noun result in { value }; production
      // process.spawn hooks return the result directly. The consumer must be
      // able to reach a real, valid end-of-stream result.
      if (grant === undefined || grant.fault !== undefined) return { value: { code: shape.ending !== undefined ? 1 : 0, signal: null } }
      // The client reads on only after its awaited request; until then P1a keeps polling.
      const arrival = await until(grant.arrived, signal, dead)
      if (arrival !== 'done') return ended(grant, arrival)
      const ack = options.ack?.(grant) ?? 'normal'
      if (ack === 'hold') {
        const held = await until(options.ackHold ?? new Promise<void>(() => {}), signal, dead)
        if (held !== 'done') return ended(grant, held)
      }
      if (ack === 'eof') {
        timeline.push(`exit:${grant.id}:0`)
        return { value: { code: 0, signal: null } }
      }
      if (ack === 'refuse') {
        yield { stream: 'stdout' as const, text: `${JSON.stringify({ ok: false, reason: 'fixture completion refused' })}\n` }
        timeline.push(`exit:${grant.id}:1`)
        return { value: { code: 1, signal: null } }
      }
      const transaction = ack === 'wrong-nonce' ? { id: grant.id, nonce: randomHex(32) } : ack === 'stale' ? { id: crypto.randomUUID(), nonce: randomHex(32) } : { id: grant.id, nonce: grant.nonce }
      timeline.push(`ack:${grant.id}`)
      const answer = { ok: true, protocol: ack === 'wrong-protocol' ? 1 : 2, mode: ack === 'wrong-mode' ? 'write' : 'completed',
        token: ack === 'wrong-token' ? `${token}-other` : token, transaction }
      yield { stream: 'stdout' as const, text: `${JSON.stringify(answer)}\n` }
      const end: LockEnd['value'] = ack === 'nonzero' ? { code: 1, signal: null } : ack === 'signal' ? { code: null, signal: 'SIGKILL' } : { code: 0, signal: null }
      timeline.push(`exit:${grant.id}:${end.code ?? end.signal}`)
      return { value: end }
    } finally {
      timeline.push(`close:${grant?.id ?? mode}`)
    }
  }

  return { spawns, grants, requests, timeline, options, serve, deadman: () => deadman() }
}

// The plugin's $.store, in a Map. A set that would take the JSON text of the whole store past
// `capBytes` rejects, as the engine's store does past 4 MiB.
export const pluginStore = (on: On, initial: Record<string, unknown> = {}, capBytes = 4 * 1024 * 1024, options: { leaseFailure?: string; guardStates?: Record<string, 'live' | 'closed'>; guardWait?: Promise<void>; splitLockReceipt?: true; leaseEnding?: { count: number; wait: Promise<void> }; beforeGet?: (key: string) => void; beforeLockSpawn?: (request: { argv: readonly string[]; cwd?: string }) => void; refuseSet?: (key: string, value: unknown) => string | undefined; locks?: WriterLockOptions } = {}) => {
  const locks = writerLocks(on, options.locks)
  // FIXTURE: helper lock receipt. The real flock/exclusion is exercised by helper tests.
  on('process.spawn', { argv: /writer-lock\.py$/ }, async function* (_, e, next) {
    options.beforeLockSpawn?.(e)
    if (e.argv[2] === 'guard' && options.guardWait !== undefined) await options.guardWait
    const ending = e.argv[2] === 'lease' ? options.leaseEnding : undefined
    if (ending !== undefined) ending.count++
    return yield* locks.serve(e, next.signal, {
      refusal: e.argv[2] === 'lease' ? options.leaseFailure : undefined,
      state: e.argv[2] === 'guard' ? options.guardStates?.[e.argv[3]!] ?? 'live' : undefined,
      split: options.splitLockReceipt, ending: ending?.wait,
    })
  })
  const held = new Map<string, unknown>(Object.entries(initial))
  const faults = { write: '', mismatchAfterSet: '', alteredAfterSet: '', failRollback: false }
  let mismatchedRead = ''
  let refusesRollback = false
  const size = () => [...held.values()].reduce<number>((sum, v) => sum + JSON.stringify(v).length, 0)
  on('store.get', (_, e) => {
    locks.timeline.push(`get:${e.key}`)
    options.beforeGet?.(e.key)
    if (e.key === mismatchedRead) {
      mismatchedRead = ''
      refusesRollback = faults.failRollback
      faults.failRollback = false
      return { value: undefined }
    }
    return { value: held.get(e.key) as never }
  })
  on('store.set', (_, e) => {
    locks.timeline.push(`set:${e.key}`)
    // Opt-in: refuse one chosen write before it applies, leaving the stored value unchanged.
    const refusal = options.refuseSet?.(e.key, e.value)
    if (refusal !== undefined) return { deny: refusal }
    if (faults.write !== '') return { deny: faults.write }
    if (refusesRollback) {
      refusesRollback = false
      return { deny: 'rollback write temporarily unavailable' }
    }
    const before = held.get(e.key)
    held.set(e.key, JSON.parse(JSON.stringify(e.value)))
    if (size() > capBytes) {
      if (before === undefined) held.delete(e.key)
      else held.set(e.key, before)

      return { deny: 'the store would pass 4 MiB' }
    }
    if (e.key === faults.mismatchAfterSet) {
      mismatchedRead = e.key
      faults.mismatchAfterSet = ''
    }
    if (e.key === faults.alteredAfterSet) {
      held.set(e.key, { ...(held.get(e.key) as object), changedByStore: true })
      faults.alteredAfterSet = ''
    }

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    locks.timeline.push(`delete:${e.key}`)
    held.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...held.keys()] }))

  return { held, size, faults, locks }
}

// The debug lines and toasts the mod writes.
export const logs = (on: On) => {
  const lines: string[] = []
  on('ui.log', (_, e) => {
    lines.push(String(e.text))

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    lines.push(String(e.text))

    return { value: undefined }
  })

  return lines
}

// FIXTURE: opt-in blob storage and publication in memory, not host filesystem atomicity.
export const blobPool = (on: On, options: { configDir?: string; files?: Map<string, string>; readProviders?: 'pool' | 'external' } = {}) => {
  // 2026-10-23: caller fixtures can own a seeded Map and its read observers.
  const files = options.files ?? new Map<string, string>()
  const configDir = options.configDir ?? '/fixture/config'
  const dir = `${configDir}/state/track/blobs`
  const checksumPattern = /^[0-9a-f]{64}$/
  const helperPattern = /\/hooks\/blob-fs\.py$/
  const escapedDir = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const encoder = new TextEncoder()
  const digest = async (text: string) => {
    const bytes = encoder.encode(text)
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    return { checksum: Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join(''), bytes: bytes.length }
  }
  let publishCalls = 0
  const answer = (exitCode: number, stdout: string, stderr = '') => ({
    value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
  })
  if (options.readProviders !== 'external') {
    on('env.get', { name: /^CLAUDE_CONFIG_DIR$/ }, () => ({ value: configDir }))
    on('env.get', { name: /^HOME$/ }, () => ({ value: undefined }))
    on('fs.read', { path: new RegExp(`^${escapedDir}/[0-9a-f]{64}\\.json$`) }, (_, e) => {
      const text = files.get(e.path)
      if (text === undefined) throw new Error(`ENOENT: missing blob ${e.path}`)
      return { value: text }
    })
  }
  on('process.run', { argv: helperPattern }, async (_, e) => {
    publishCalls++
    const [interpreter, helper, operation, poolDir, checksum] = e.argv
    const text = e.init?.stdin
    if (e.argv.length !== 5 || interpreter !== 'python3' || helper === undefined || !helperPattern.test(helper)
      || operation !== 'publish' || poolDir !== dir || checksum === undefined || !checksumPattern.test(checksum) || typeof text !== 'string') {
      return answer(1, '', 'invalid blob publication request')
    }
    const ref = await digest(text)
    if (ref.checksum !== checksum) return answer(1, '', 'blob checksum differs from stdin')
    const path = `${dir}/${checksum}.json`
    const existing = files.get(path)
    if (existing !== undefined && existing !== text) return answer(1, '', 'existing blob differs; refused and kept')
    if (existing === undefined) files.set(path, text)
    return answer(0, `${JSON.stringify({ ok: true, ...ref })}\n`)
  })

  return {
    files,
    get publishes() { return publishCalls },
    async logical(store: { held: Map<string, unknown> }, key: string) {
      const raw = store.held.get(key)
      if (typeof raw !== 'object' || raw === null || !('v' in raw) || raw.v !== 2) return raw
      const body = raw as Record<string, unknown>
      const ref = body.ledger_blob as { checksum?: unknown; bytes?: unknown } | undefined
      if (typeof ref !== 'object' || ref === null || typeof ref.checksum !== 'string' || !checksumPattern.test(ref.checksum)
        || !Number.isSafeInteger(ref.bytes) || (ref.bytes as number) < 0) throw new Error('invalid blob checksum or bytes')
      const text = files.get(`${dir}/${ref.checksum}.json`)
      if (text === undefined) throw new Error('missing ledger blob')
      const actual = await digest(text)
      if (actual.bytes !== ref.bytes || actual.checksum !== ref.checksum) throw new Error('damaged ledger blob: checksum or bytes differ')
      const ledger: unknown = JSON.parse(text)
      return Object.fromEntries(Object.entries(body).map(([name, value]) =>
        name === 'v' ? [name, 1] : name === 'ledger_blob' ? ['ledger', ledger] : [name, value]))
    },
  }
}
