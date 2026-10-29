import { type Eviction, confirmEviction, evictionOrder } from './retention-eviction'
import { finishExpiry } from './retention-expiry'
import { type ExpiryIntent, type Guard, type RetentionStore, ownedKeys, recoveryKey } from './retention-records'
import { entryBytes, includeIndexSize } from './size-index'

export const readSizes = async (store: RetentionStore): Promise<Map<string, number>> => {
  if (store.sizes !== undefined) return store.sizes()
  const sizes = new Map<string, number>()
  for (const key of await store.keys()) {
    const value = await store.get(key)
    if (value !== undefined) sizes.set(key, entryBytes(key, value))
  }
  return sizes
}
const fitsSizes = (sizes: Map<string, number>, replacements: Record<string, unknown>, budget: number): boolean => {
  const planned = new Map(sizes)
  for (const [key, value] of Object.entries(replacements)) {
    if (value === undefined) planned.delete(key)
    else planned.set(key, entryBytes(key, value))
  }
  includeIndexSize(planned)
  const bytes = 2 + [...planned.values()].reduce((total, size) => total + size, 0) + Math.max(0, planned.size - 1)
  return bytes < budget
}
export const checkSizes = (sizes: Map<string, number>, replacements: Record<string, unknown>, budget: number): void => {
  if (!fitsSizes(sizes, replacements, budget)) throw new Error('capacity: protected or unexpired history fills the UTF-8 store budget; nothing was pruned')
}

// Deletes through the expiry intent, so an interrupted eviction is finished
// or cancelled by recoverCleanup exactly like an interrupted expiry. Any
// failure keeps this candidate (a published intent stays for recovery) and
// lets the caller try the next one.
const evictSession = async (store: RetentionStore, intent: ExpiryIntent, eviction: Eviction, guards: Map<string, Guard>): Promise<boolean> => {
  try {
    checkSizes(await readSizes(store), { [recoveryKey(intent.session_id)]: intent }, 4 * 1024 * 1024)
    await finishExpiry(store, intent, () => true, eviction.probe, true, new Set(guards.keys()))
  } catch (error) {
    store.log(`track: eviction keeps ${intent.session_id}: ${String(error)}`)
  }
  return ownedKeys(await store.keys(), intent.session_id).length === 0
}

// TRACK-31 (2026-10-20): a write past the budget evicts the oldest CLOSED
// sessions until it fits. Under budget nothing else is read or written.
// Nothing is deleted until confirmed candidates alone could make room: each
// candidate and its switch-archive sources hold CLOSED guards until return,
// so a live or ambiguous session never lets a write delete history and fail.
export const ensureCapacity = async (store: RetentionStore, replacements: Record<string, unknown>, budget: number, eviction?: Eviction): Promise<string[]> => {
  const sizes = await readSizes(store)
  if (eviction === undefined) {
    checkSizes(sizes, replacements, budget)
    return []
  }
  if (fitsSizes(sizes, replacements, budget)) return []
  const keys = await store.keys()
  const candidates = await evictionOrder(store, keys, replacements, eviction)
  // Skip probing when even evicting every candidate could not make room.
  const floor = new Map(sizes)
  for (const [session] of candidates) for (const key of ownedKeys(keys, session)) floor.delete(key)
  checkSizes(floor, replacements, budget)
  const guards = new Map<string, Guard>()
  const releaseRetries = new Map<Guard, string>()
  const borrowed = new Set<Guard>()
  for (const [session, guard] of eviction.heldGuards ?? []) {
    if (guard.state !== 'closed') continue
    guards.set(session, guard)
    borrowed.add(guard)
  }
  const evicted: string[] = []
  let ready: ExpiryIntent[] = []
  try {
    // TRACK-35 U2b: compaction frees bytes without deleting anything, largest
    // raw body first; eviction below keeps its oldest-first order and guards.
    if (eviction.compact !== undefined) {
      const largestFirst = [...candidates].sort(([left], [right]) => (sizes.get(`s:${right}`) ?? 0) - (sizes.get(`s:${left}`) ?? 0))
      for (const [session, clock] of largestFirst) {
        const outcome = await eviction.compact(session, async () => await confirmEviction(store, session, clock, eviction, guards, releaseRetries) !== undefined)
        if (outcome === 'stop') break
        if (outcome === 'compacted' && fitsSizes(await readSizes(store), replacements, budget)) return []
      }
    }
    for (const [session, clock] of candidates) {
      const intent = await confirmEviction(store, session, clock, eviction, guards, releaseRetries)
      if (intent === undefined) continue
      ready.push(intent)
      const freed = new Map(await readSizes(store))
      for (const pending of ready) for (const entry of pending.entries) freed.delete(entry.key)
      if (!fitsSizes(freed, replacements, budget)) continue
      for (const pending of ready) {
        if (!(await evictSession(store, pending, eviction, guards))) continue
        evicted.push(pending.session_id)
        await eviction.afterEviction?.(pending.session_id)
        if (fitsSizes(await readSizes(store), replacements, budget)) return evicted
      }
      ready = []
    }
    checkSizes(await readSizes(store), replacements, budget)
    return evicted
  } finally {
    const cleanup = new Map(releaseRetries)
    for (const [session, guard] of guards) cleanup.set(guard, session)
    for (const [guard, session] of cleanup) {
      if (borrowed.has(guard)) continue
      try { await guard.release() }
      catch (error) { store.log(`track: eviction guard release failed for ${session}: ${String(error)}`) }
    }
  }
}
