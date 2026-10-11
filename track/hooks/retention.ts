export type RetentionStore = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<unknown>
  delete: (key: string) => Promise<unknown>
  keys: () => Promise<string[]>
  log: (message: string) => void
}

// TRACK-21 (2026-10-11): save-time count eviction removed live session data.
// All calls run under the existing store write lock. Target guards remain held
// through changes and rollback; errors conservatively count as live.
const HOUR = 60 * 60 * 1000
export const CLOSED_TTL = 7 * 24 * HOUR
const BATCH = 8
const WORK_MS = 250
const CLEANUP = 'cleanup'
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type Guard = { state: 'closed' | 'live'; release: () => Promise<void> }
type Value = Record<string, unknown>
type CleanupRecovery = { v: 1; session_id: string; entries: Array<{ key: string; before: unknown; after?: unknown }> }
const recoveryKey = (session: string): string => `cleanup:${session}`
export const sameRecord = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

export const writeVerified = async (store: RetentionStore, key: string, value: unknown): Promise<void> => {
  if (value === undefined) await store.delete(key)
  else await store.set(key, value)
  if (!sameRecord(await store.get(key), value)) throw new Error(`retention read-back mismatch: ${key}`)
}

const ownedKeys = (keys: string[], session: string): string[] => keys.filter(key =>
  key === `s:${session}` || key === `h:${session}` || key.startsWith(`r:${session}:`))

// Caller holds either its own lease or a retained CLOSED guard, plus the store
// lock. Resume uses this before its first body read, not on the next save.
export const recoverCleanup = async (store: RetentionStore, session: string): Promise<boolean> => {
  const key = recoveryKey(session)
  const recovery = await store.get(key) as CleanupRecovery | undefined
  if (recovery === undefined) return false
  if (!SESSION_ID.test(session) || recovery?.v !== 1 || recovery.session_id !== session ||
      !Array.isArray(recovery.entries) || recovery.entries.some(entry =>
        !ownedKeys([entry.key], session).length || entry.before === undefined)) throw new Error('cleanup rollback pending: ambiguous durable recovery record')
  for (const entry of recovery.entries) {
    const current = await store.get(entry.key)
    if (sameRecord(current, entry.before)) continue
    if (!sameRecord(current, entry.after)) throw new Error(`cleanup rollback pending: could not verify ${entry.key}; later value was kept`)
    await writeVerified(store, entry.key, entry.before)
  }
  await writeVerified(store, key, undefined)
  return true
}

// Only the owner changes clocks on live records. Clearing one can only delay
// expiry, so an interrupted clear never discards ledger rows or ages them.
export const clearOwnedClocks = async (store: RetentionStore, session: string): Promise<void> => {
  for (const key of ownedKeys(await store.keys(), session)) {
    const value = await store.get(key) as Value
    if (value === null || typeof value !== 'object' || (value.session_id !== undefined && value.session_id !== session)) throw new Error('owned record identity is ambiguous')
    if (!Object.hasOwn(value, 'closedAt')) continue
    const { closedAt, ...withoutClock } = value
    await writeVerified(store, key, withoutClock)
  }
}

const entryBytes = (key: string, value: unknown): number => new TextEncoder().encode(JSON.stringify({ [key]: value })).length - 2
const readSizes = async (store: RetentionStore): Promise<Map<string, number>> => {
  const sizes = new Map<string, number>()
  for (const key of await store.keys()) {
    const value = await store.get(key)
    if (value !== undefined) sizes.set(key, entryBytes(key, value))
  }
  return sizes
}
const checkSizes = (sizes: Map<string, number>, replacements: Record<string, unknown>, budget: number): void => {
  const planned = new Map(sizes)
  for (const [key, value] of Object.entries(replacements)) {
    if (value === undefined) planned.delete(key)
    else planned.set(key, entryBytes(key, value))
  }
  const bytes = 2 + [...planned.values()].reduce((total, size) => total + size, 0) + Math.max(0, planned.size - 1)
  if (bytes >= budget) throw new Error('capacity: protected or unexpired history fills the UTF-8 store budget; nothing was pruned')
}

const changeRecord = async (store: RetentionStore, session: string, entries: Array<[string, unknown]>, changes: Array<[string, unknown]>, sizes: Map<string, number>, canStart: () => boolean): Promise<void> => {
  if (changes.every(([key, value], index) => key === entries[index][0] && sameRecord(value, entries[index][1]))) return
  const key = recoveryKey(session)
  const recovery: CleanupRecovery = { v: 1, session_id: session,
    entries: entries.map(([key, before], index) => ({ key, before, after: changes[index][1] })) }
  // Reserve durable rollback space before the first mutation. A full store
  // refuses cleanup rather than discarding the only remaining copy of a row.
  // Ordinary saves stop at 3 MiB. The store's remaining 1 MiB is reserved
  // for rollback, so expiry can reclaim space after that save limit is hit.
  checkSizes(sizes, { [key]: recovery }, 4 * 1024 * 1024)
  const write = async (key: string, value: unknown) => {
    await writeVerified(store, key, value)
    if (value === undefined) sizes.delete(key)
    else sizes.set(key, entryBytes(key, value))
  }
  if (!canStart()) return
  await write(key, recovery)
  try {
    for (const [key, value] of changes) {
      if (!canStart()) throw new Error('cleanup elapsed budget reached; rollback required')
      await write(key, value)
    }
    await write(key, undefined)
  } catch (error) {
    const failures: string[] = []
    for (const [index, [key, value]] of entries.entries()) {
      try {
        const current = await store.get(key)
        if (sameRecord(current, value)) continue
        if (!sameRecord(current, changes[index][1])) throw new Error(`could not verify ${key}; later value was kept`)
        await write(key, value)
      }
      catch (rollback) { failures.push(String(rollback)) }
    }
    if (failures.length === 0) {
      try { await write(key, undefined) }
      catch (rollback) { failures.push(String(rollback)) }
    }
    throw new Error(`${String(error)}${failures.length ? `; cleanup rollback pending (recovery pending): ${failures.join('; ')}` : ''}`)
  }
}

export const cleanupRecords = async (store: RetentionStore, caller: string, probe: (session: string) => Promise<Guard>): Promise<void> => {
  const now = Date.now()
  const canStart = () => Date.now() - now < WORK_MS
  let visited = 0
  let verified = 0
  let sizes: Map<string, number> | undefined
  const failures: string[] = []
  const previous = await store.get(CLEANUP) as { lastCleanup?: number; cursor?: string; recoveryCursor?: string } | undefined
  let cursor = previous?.cursor ?? ''
  let recoveryCursor = previous?.recoveryCursor ?? ''
  const recovered = new Set<string>()
  const pending = (await store.keys()).filter(key => key.startsWith('cleanup:')).sort()
  const pendingAfter = pending.filter(key => key > recoveryCursor)
  const orderedPending = [...pendingAfter, ...pending.filter(key => key <= recoveryCursor)]
  for (const key of orderedPending.slice(0, BATCH)) {
    if (!canStart()) break
    visited++
    recoveryCursor = key
    const session = key.slice('cleanup:'.length)
    let guard: Guard | undefined
    try {
      // Production resolves caller recovery before reading its body. This path
      // also supports a caller holding its own lease when used independently.
      guard = session === caller ? { state: 'closed', release: async () => {} } : await probe(session)
      if (guard.state !== 'closed') continue
      // An already-started integrity step finishes before releasing its guard,
      // just like rollback. The budget prevents starting the next target.
      await recoverCleanup(store, session)
      recovered.add(session)
    } catch (error) {
      failures.push(String(error))
      store.log(`track: cleanup keeps pending recovery ${session}: ${String(error)}`)
    } finally { await guard?.release() }
  }
  // A backwards wall clock cannot accelerate expiry or repeatedly run cleanup.
  const isDue = typeof previous?.lastCleanup !== 'number' || now - previous.lastCleanup >= HOUR
  const keys = await store.keys()
  const sessions = [...new Set(keys.flatMap(key => key.startsWith('s:') || key.startsWith('h:') || key.startsWith('r:') ? [key.split(':')[1]] : []))]
    .filter(session => session !== caller && !recovered.has(session) && !pending.includes(recoveryKey(session)) && SESSION_ID.test(session)).sort()
  const after = sessions.filter(session => session > (previous?.cursor ?? ''))
  const ordered = [...after, ...sessions.filter(session => session <= (previous?.cursor ?? ''))]
  for (const session of isDue ? ordered.slice(0, BATCH - visited) : []) {
    if (!canStart()) break
    let guard: Guard | undefined
    try {
      try { guard = await probe(session) }
      catch (error) { store.log(`track: cleanup keeps ${session}: lease ambiguous: ${String(error)}`); cursor = session; continue }
      // Cleaners never rewrite LIVE or unknown records. Only an owner clears
      // its own clocks, under its retained lease, including on resume.
      if (guard.state !== 'closed') { verified++; cursor = session; continue }
      if (!canStart()) break
      const entries: Array<[string, unknown]> = []
      for (const key of ownedKeys(keys, session)) entries.push([key, await store.get(key)])
      // A mismatching embedded owner is not safe to migrate or expire.
      if (entries.some(([, value]) => value === null || typeof value !== 'object' ||
        ((value as Value).session_id !== undefined && (value as Value).session_id !== session))) {
        store.log(`track: cleanup keeps ${session}: ambiguous record identity`)
        cursor = session
        continue
      }
      const closures = entries.map(([, value]) => (value as Value).closedAt)
      const closedAt = closures.length > 0 && closures.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= now)
        ? Math.max(...closures as number[]) : undefined
      const expired = closedAt !== undefined && now - closedAt >= CLOSED_TTL
      const changes: Array<[string, unknown]> = entries.map(([key, value]) => {
        if (expired) return [key, undefined]
        const { closedAt: _old, ...record } = value as Value
        return [key, { ...record, session_id: session, closedAt: closedAt ?? now }]
      })
      if (sizes === undefined) sizes = await readSizes(store)
      if (!canStart()) break
      await changeRecord(store, session, entries, changes, sizes, canStart)
      verified++
      cursor = session
    } catch (error) {
      failures.push(String(error))
      sizes = undefined // A failed store operation may have changed its value.
      cursor = session
      store.log(`track: cleanup keeps ${session}; deferred: ${String(error)}`)
    } finally {
      await guard?.release()
    }
  }
  if (verified > 0 || cursor !== (previous?.cursor ?? '') || recoveryCursor !== (previous?.recoveryCursor ?? '')) {
    await writeVerified(store, CLEANUP, { v: 1, ...previous, cursor, recoveryCursor,
      ...(verified > 0 && failures.length === 0 && { lastCleanup: now }) })
  }
  if (failures.length) throw new Error(failures.join('; '))
}

export const ensureCapacity = async (store: RetentionStore, replacements: Record<string, unknown>, budget: number): Promise<void> => {
  checkSizes(await readSizes(store), replacements, budget)
}
