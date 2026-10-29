import type { RetentionStore } from './retention-records'

// TRACK-21 Refuter-2 M4 (2026-10-11): full body scans under the store
// lock blocked other owners. A pending key repairs a crash-left size update.
export const SIZE_INDEX = 'capacitySizes'
type SizeIndex = { v: 1; sizes: Record<string, number>; pending?: string }
export const entryBytes = (key: string, value: unknown): number => new TextEncoder().encode(JSON.stringify({ [key]: value })).length - 2
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
const indexOf = (sizes: Map<string, number>, pending?: string): SizeIndex => ({
  v: 1, sizes: Object.fromEntries([...sizes].filter(([key]) => key !== SIZE_INDEX)),
  ...(pending !== undefined && { pending }),
})

// Account for the index itself and the largest single-key pending marker.
export const includeIndexSize = (sizes: Map<string, number>): void => {
  if (!sizes.has(SIZE_INDEX)) return
  const keys = [...sizes.keys()].filter(key => key !== SIZE_INDEX)
  const longest = keys.reduce((left, right) => JSON.stringify(left).length >= JSON.stringify(right).length ? left : right, '')
  sizes.set(SIZE_INDEX, Math.max(sizes.get(SIZE_INDEX)!, entryBytes(SIZE_INDEX, indexOf(sizes, longest))))
}

// Callers retain the store lock for the whole operation. Only legacy or new
// keys need their value read; ordinary capacity checks read index metadata.
export const indexedStore = (raw: RetentionStore): RetentionStore => {
  const publish = async (index: SizeIndex): Promise<void> => {
    await raw.set(SIZE_INDEX, index)
    if (!same(await raw.get(SIZE_INDEX), index)) throw new Error('capacity size index read-back mismatch')
  }
  const load = async (): Promise<Map<string, number>> => {
    const stored = await raw.get(SIZE_INDEX) as SizeIndex | undefined
    if (stored !== undefined && (stored.v !== 1 || stored.sizes === null || typeof stored.sizes !== 'object' ||
        Object.entries(stored.sizes).some(([key, bytes]) => key === SIZE_INDEX || !Number.isSafeInteger(bytes) || bytes < 0) ||
        stored.pending !== undefined && (typeof stored.pending !== 'string' || stored.pending === SIZE_INDEX))) throw new Error('capacity size index is incompatible; values were kept')
    const sizes = new Map(Object.entries(stored?.sizes ?? {}))
    const keys = (await raw.keys()).filter(key => key !== SIZE_INDEX)
    const present = new Set(keys)
    let changed = stored === undefined || stored.pending !== undefined
    for (const key of sizes.keys()) if (!present.has(key)) { sizes.delete(key); changed = true }
    for (const key of keys) if (!sizes.has(key) || key === stored?.pending || key === 'classifier') {
      const value = await raw.get(key)
      if (value === undefined) sizes.delete(key)
      else sizes.set(key, entryBytes(key, value))
      changed = true
    }
    const index = indexOf(sizes)
    if (changed) await publish(index)
    sizes.set(SIZE_INDEX, entryBytes(SIZE_INDEX, index))
    return sizes
  }
  const mutate = async (key: string, value: unknown): Promise<unknown> => {
    if (key === SIZE_INDEX) throw new Error('capacity size index is reserved')
    const sizes = await load()
    await publish(indexOf(sizes, key))
    const result = value === undefined ? await raw.delete(key) : await raw.set(key, value)
    // A refused or altered data write leaves a durable pending marker; the
    // next locked caller repairs this one size from the actual value.
    if (!same(await raw.get(key), value)) throw new Error(`indexed store read-back mismatch: ${key}`)
    if (value === undefined) sizes.delete(key)
    else sizes.set(key, entryBytes(key, value))
    await publish(indexOf(sizes))
    return result
  }
  return { ...raw, set: (key, value) => mutate(key, value), delete: key => mutate(key, undefined), sizes: load }
}
