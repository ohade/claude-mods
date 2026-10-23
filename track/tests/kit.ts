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

// The plugin's $.store, in a Map. A set that would take the JSON text of the whole store past
// `capBytes` rejects, as the engine's store does past 4 MiB.
export const pluginStore = (on: On, initial: Record<string, unknown> = {}, capBytes = 4 * 1024 * 1024, options: { leaseFailure?: string; guardStates?: Record<string, 'live' | 'closed'>; guardWait?: Promise<void>; splitLockReceipt?: true; leaseEnding?: { count: number; wait: Promise<void> }; beforeGet?: (key: string) => void; beforeLockSpawn?: (request: { argv: readonly string[]; cwd?: string }) => void; refuseSet?: (key: string, value: unknown) => string | undefined } = {}) => {
  // FIXTURE: helper lock receipt. The real flock/exclusion is exercised by helper tests.
  on('process.spawn', { argv: /writer-lock\.py$/ }, async function* (_, e) {
    options.beforeLockSpawn?.(e)
    if (e.argv[2] === 'guard' && options.guardWait !== undefined) await options.guardWait
    const text = JSON.stringify(e.argv[2] === 'lease' && options.leaseFailure !== undefined ? { ok: false, reason: options.leaseFailure } : { ok: true, mode: e.argv[2], token: e.argv[4], ...(e.argv[2] === 'guard' && { state: options.guardStates?.[e.argv[3]!] ?? 'live' }) })
    if (e.argv[2] === 'lease' && options.leaseEnding !== undefined) options.leaseEnding.count++
    if (options.splitLockReceipt) {
      yield { stream: 'stderr' as const, text: 'A harmless diagnostic\n' }
      yield { stream: 'stdout' as const, text: text.slice(0, 5) }
      yield { stream: 'stdout' as const, text: text.slice(5) + '\n' }
    } else {
      yield { stream: 'stdout' as const, text }
    }
    if (e.argv[2] === 'lease' && options.leaseEnding !== undefined) await options.leaseEnding.wait
    // Testing hooks wrap their final noun result in { value }; production
    // process.spawn hooks return the result directly. The consumer must be
    // able to reach a real, valid end-of-stream result.
    return { value: { code: options.leaseEnding !== undefined && e.argv[2] === 'lease' ? 1 : 0, signal: null } }
  })
  const held = new Map<string, unknown>(Object.entries(initial))
  const faults = { write: '', mismatchAfterSet: '', alteredAfterSet: '', failRollback: false }
  let mismatchedRead = ''
  let refusesRollback = false
  const size = () => [...held.values()].reduce<number>((sum, v) => sum + JSON.stringify(v).length, 0)
  on('store.get', (_, e) => {
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
    held.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...held.keys()] }))

  return { held, size, faults }
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
