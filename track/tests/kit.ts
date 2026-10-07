import type { TestBody } from 'claude-code/testing'

// Stand-ins the track tests share: a state atom and the plugin's store, each held in the test.

export type Engine = Parameters<TestBody>[0]
export type On = Parameters<TestBody>[1]

export const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

export const EMPTY = { v: 1, nextQuestionId: 1, prompts: [], questions: [], steps: [] }

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
export const pluginStore = (on: On, initial: Record<string, unknown> = {}, capBytes = 4 * 1024 * 1024) => {
  const held = new Map<string, unknown>(Object.entries(initial))
  const size = () => [...held.values()].reduce<number>((sum, v) => sum + JSON.stringify(v).length, 0)
  on('store.get', (_, e) => ({ value: held.get(e.key) as never }))
  on('store.set', (_, e) => {
    const before = held.get(e.key)
    held.set(e.key, JSON.parse(JSON.stringify(e.value)))
    if (size() > capBytes) {
      if (before === undefined) held.delete(e.key)
      else held.set(e.key, before)

      return { deny: 'the store would pass 4 MiB' }
    }

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    held.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...held.keys()] }))

  return { held, size }
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
