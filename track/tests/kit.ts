import type { TestBody } from 'claude-code/testing'

// Stand-ins the track tests share: a state atom and the plugin's store, each held in the test.

export type Engine = Parameters<TestBody>[0]
export type On = Parameters<TestBody>[1]

export const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

export const EMPTY = { v: 1, nextQuestionId: 1, prompts: [], questions: [], steps: [] }

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
export const atomStore = <T>(on: On, key: string, initial: T, options: { holdReads?: number } = {}) => {
  const held = { value: initial, version: 1, writes: [] as T[] }
  let waiting = options.holdReads ?? 0
  const arrived: Array<() => void> = []
  on('state.get', { plugin: 'track', key }, async () => {
    if (waiting > 0) {
      waiting--
      await new Promise<void>(resolve => {
        arrived.push(resolve)
        if (waiting === 0) for (const go of arrived) go()
      })
    }

    return { value: { value: held.value, version: held.version } }
  })
  on('state.set', { plugin: 'track', key }, (_, e) => {
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
export const pluginStore = (on: On, initial: Record<string, unknown> = {}, capBytes = 4 * 1024 * 1024, options: { leaseFailure?: string; splitLockReceipt?: true; leaseEnding?: { count: number; wait: Promise<void> }; beforeGet?: (key: string) => void; beforeLockSpawn?: (request: { argv: readonly string[]; cwd?: string }) => void } = {}) => {
  // FIXTURE: helper lock receipt. The real flock/exclusion is exercised by helper tests.
  on('process.spawn', { argv: /writer-lock\.py$/ }, async function* (_, e) {
    options.beforeLockSpawn?.(e)
    const text = JSON.stringify(e.argv[2] === 'lease' && options.leaseFailure !== undefined ? { ok: false, reason: options.leaseFailure } : { ok: true, mode: e.argv[2], token: e.argv[4] })
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
