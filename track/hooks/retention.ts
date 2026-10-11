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

const changeRecord = async (store: RetentionStore, session: string, entries: Array<[string, unknown]>, changes: Array<[string, unknown]>): Promise<void> => {
  if (changes.every(([key, value], index) => key === entries[index][0] && sameRecord(value, entries[index][1]))) return
  const key = recoveryKey(session)
  const recovery: CleanupRecovery = { v: 1, session_id: session,
    entries: entries.map(([key, before], index) => ({ key, before, after: changes[index][1] })) }
  // Reserve durable rollback space before the first mutation. A full store
  // refuses cleanup rather than discarding the only remaining copy of a row.
  // Ordinary saves stop at 3 MiB. The store's remaining 1 MiB is reserved
  // for rollback, so expiry can reclaim space after that save limit is hit.
  await ensureCapacity(store, { [key]: recovery }, 4 * 1024 * 1024)
  await writeVerified(store, key, recovery)
  try {
    for (const [key, value] of changes) await writeVerified(store, key, value)
    await writeVerified(store, key, undefined)
  } catch (error) {
    const failures: string[] = []
    for (const [index, [key, value]] of entries.entries()) {
      try {
        const current = await store.get(key)
        if (sameRecord(current, value)) continue
        if (!sameRecord(current, changes[index][1])) throw new Error(`could not verify ${key}; later value was kept`)
        await writeVerified(store, key, value)
      }
      catch (rollback) { failures.push(String(rollback)) }
    }
    if (failures.length === 0) {
      try { await writeVerified(store, key, undefined) }
      catch (rollback) { failures.push(String(rollback)) }
    }
    throw new Error(`${String(error)}${failures.length ? `; cleanup rollback pending (recovery pending): ${failures.join('; ')}` : ''}`)
  }
}

export const cleanupRecords = async (store: RetentionStore, caller: string, probe: (session: string) => Promise<Guard>): Promise<void> => {
  const now = Date.now()
  const started = now
  let visited = 0
  const recovered = new Set<string>()
  const pending = (await store.keys()).filter(key => key.startsWith('cleanup:')).sort()
  for (const key of pending.slice(0, BATCH)) {
    if (Date.now() - started >= WORK_MS) break
    visited++
    const session = key.slice('cleanup:'.length)
    const recovery = await store.get(key) as CleanupRecovery
    if (!SESSION_ID.test(session) || recovery?.v !== 1 || recovery.session_id !== session ||
        !Array.isArray(recovery.entries) || recovery.entries.some(entry =>
          !ownedKeys([entry.key], session).length || entry.before === undefined)) {
      throw new Error('cleanup rollback pending: ambiguous durable recovery record')
    }
    // The caller already owns its retained writer lease. Other targets require
    // CLOSED under a retained guard; a newly live owner keeps its journal.
    const guard = session === caller ? { state: 'closed' as const, release: async () => {} } : await probe(session)
    try {
      if (guard.state !== 'closed') continue
      for (const entry of recovery.entries) {
        const current = await store.get(entry.key)
        if (sameRecord(current, entry.before)) continue
        if (!sameRecord(current, entry.after)) throw new Error(`cleanup rollback pending: could not verify ${entry.key}; later value was kept`)
        await writeVerified(store, entry.key, entry.before)
      }
      await writeVerified(store, key, undefined)
      recovered.add(session)
    } finally { await guard.release() }
  }
  const previous = await store.get(CLEANUP) as { lastCleanup?: number; cursor?: string } | undefined
  // A backwards wall clock cannot accelerate expiry or repeatedly run cleanup.
  if (typeof previous?.lastCleanup === 'number' && now - previous.lastCleanup < HOUR) return
  const keys = await store.keys()
  const sessions = [...new Set(keys.flatMap(key => key.startsWith('s:') || key.startsWith('h:') || key.startsWith('r:') ? [key.split(':')[1]] : []))]
    .filter(session => session !== caller && !recovered.has(session) && !pending.includes(recoveryKey(session)) && SESSION_ID.test(session)).sort()
  const after = sessions.filter(session => session > (previous?.cursor ?? ''))
  const ordered = [...after, ...sessions.filter(session => session <= (previous?.cursor ?? ''))]
  let cursor = previous?.cursor ?? ''
  for (const session of ordered.slice(0, BATCH - visited)) {
    if (Date.now() - started >= WORK_MS) break
    let guard: Guard | undefined
    try {
      try { guard = await probe(session) }
      catch (error) { store.log(`track: cleanup keeps ${session}: lease ambiguous: ${String(error)}`) }
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
      const expired = guard?.state === 'closed' && closedAt !== undefined && now - closedAt >= CLOSED_TTL
      const changes: Array<[string, unknown]> = entries.map(([key, value]) => {
        if (expired) return [key, undefined]
        const { closedAt: _old, ...record } = value as Value
        return [key, { ...record, session_id: session, ...(guard?.state === 'closed' && { closedAt: closedAt ?? now }) }]
      })
      await changeRecord(store, session, entries, changes)
      cursor = session
    } finally {
      await guard?.release()
    }
  }
  await writeVerified(store, CLEANUP, { v: 1, lastCleanup: now, cursor })
}

export const ensureCapacity = async (store: RetentionStore, replacements: Record<string, unknown>, budget: number): Promise<void> => {
  const current: Record<string, unknown> = {}
  for (const key of await store.keys()) current[key] = await store.get(key)
  const bytes = new TextEncoder().encode(JSON.stringify({ ...current, ...replacements })).length
  if (bytes >= budget) throw new Error('capacity: protected or unexpired history fills the UTF-8 store budget; nothing was pruned')
}
