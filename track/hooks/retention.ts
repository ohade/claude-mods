import { entryBytes, includeIndexSize } from './size-index'
import { checksumOf } from './checkpoint'

export type RetentionStore = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<unknown>
  delete: (key: string) => Promise<unknown>
  keys: () => Promise<string[]>
  log: (message: string) => void
  sizes?: () => Promise<Map<string, number>>
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
type Probe = (session: string) => Promise<Guard>
type Value = Record<string, unknown>
type RecoveryEntry = { key: string; before: unknown; missing?: true; after?: unknown; stamp?: { session_id: string; closedAt: number } }
type CleanupRecovery = { v: 1; session_id: string; entries: RecoveryEntry[] }
type ExpiryIntent = { v: 2; mode: 'expiry'; session_id: string; closedAt: number; entries: Array<{ key: string; checksum: string; bytes: number }> }
const recoveryAfter = (entry: RecoveryEntry): unknown => entry.stamp === undefined ? entry.after : { ...entry.before as Value, ...entry.stamp }
const recoveryKey = (session: string): string => `cleanup:${session}`
export const sameRecord = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

export const writeVerified = async (store: RetentionStore, key: string, value: unknown): Promise<void> => {
  if (value === undefined) await store.delete(key)
  else await store.set(key, value)
  if (!sameRecord(await store.get(key), value)) throw new Error(`retention read-back mismatch: ${key}`)
}

const ownedKeys = (keys: string[], session: string): string[] => keys.filter(key =>
  key === `s:${session}` || key === `h:${session}` || key.startsWith(`r:${session}:`))

// TRACK-21 refuter 6: a switch archive in B's namespace can contain A's
// unsaved rows. B's CLOSED lease gives no authority to delete a live A's rows.
const holdArchiveSources = async (store: RetentionStore, intent: ExpiryIntent, guards: Map<string, Guard>, probe: Probe | undefined, canStart: () => boolean): Promise<boolean> => {
  for (const entry of intent.entries.filter(entry => entry.key.startsWith('r:'))) {
    if (!canStart()) throw new Error('expiry elapsed budget reached; committed deletion remains pending')
    const archive = await store.get(entry.key) as { kind?: string; value?: { source_session?: unknown; ledger?: { session_id?: unknown } } } | undefined
    if (archive?.kind !== 'session-switch') continue
    const source = archive.value?.source_session
    if (typeof source !== 'string' || !SESSION_ID.test(source) ||
        archive.value?.ledger?.session_id !== undefined && archive.value.ledger.session_id !== source) {
      store.log(`track: expiry keeps ${intent.session_id}: session-switch source is unknown or ambiguous`)
      return false
    }
    if (source === intent.session_id || guards.has(source)) continue
    if (probe === undefined) {
      store.log(`track: expiry keeps ${intent.session_id}: source ${source} has no lease probe`)
      return false
    }
    if (!canStart()) throw new Error('expiry elapsed budget reached; committed deletion remains pending')
    const guard = await probe(source)
    guards.set(source, guard)
    if (guard.state !== 'closed') {
      store.log(`track: expiry keeps ${intent.session_id}: source ${source} is live or unknown`)
      return false
    }
  }
  return true
}

// Expired data is already committed for deletion. A small intent finishes
// after a crash, without duplicating the body into the rollback reserve.
const finishExpiry = async (store: RetentionStore, intent: ExpiryIntent, canStart: () => boolean = () => true, probe?: Probe): Promise<boolean> => {
  const key = recoveryKey(intent.session_id)
  const matches = async (entry: ExpiryIntent['entries'][number]): Promise<boolean> => {
    const value = await store.get(entry.key)
    return value === undefined || entryBytes(entry.key, value) === entry.bytes && await checksumOf(value) === entry.checksum
  }
  const cancel = async (): Promise<boolean> => {
    store.log(`track: expiry cancelled for ${intent.session_id}; changed history was kept`)
    await writeVerified(store, key, undefined)
    return true
  }
  // Preflight all remaining keys before the first deletion. New owned keys
  // or a changed body mean a returning owner; keep all remaining history.
  const listed = new Set(intent.entries.map(entry => entry.key))
  if (ownedKeys(await store.keys(), intent.session_id).some(key => !listed.has(key))) return cancel()
  for (const entry of intent.entries) if (!(await matches(entry))) return cancel()
  const guards = new Map<string, Guard>()
  try {
    if (!(await holdArchiveSources(store, intent, guards, probe, canStart))) return false
    for (const entry of intent.entries) {
      if (!canStart()) throw new Error('expiry elapsed budget reached; committed deletion remains pending')
      if (!(await matches(entry))) return await cancel()
      await writeVerified(store, entry.key, undefined)
    }
    await writeVerified(store, key, undefined)
    return true
  } finally {
    const failures: string[] = []
    for (const guard of guards.values()) {
      try { await guard.release() }
      catch (error) { failures.push(String(error)); store.log(`track: archive source guard release failed: ${String(error)}`) }
    }
    if (failures.length) throw new Error(failures.join('; '))
  }
}

// Caller holds either its own lease or a retained CLOSED guard, plus the store
// lock. Resume uses this before its first body read, not on the next save.
export const recoverCleanup = async (store: RetentionStore, session: string, options: { owner?: boolean; canStart?: () => boolean; probe?: Probe } = {}): Promise<boolean> => {
  const key = recoveryKey(session)
  const recovery = await store.get(key) as CleanupRecovery | ExpiryIntent | undefined
  if (recovery === undefined) return false
  if (recovery.v === 2) {
    if (!SESSION_ID.test(session) || recovery.session_id !== session || recovery.mode !== 'expiry' ||
        !Number.isFinite(recovery.closedAt) || recovery.closedAt < 0 || Date.now() - recovery.closedAt < CLOSED_TTL ||
        !Array.isArray(recovery.entries) || recovery.entries.length === 0 ||
        new Set(recovery.entries.map(entry => entry.key)).size !== recovery.entries.length || recovery.entries.some(entry =>
          !ownedKeys([entry.key], session).length || !/^[a-f0-9]{64}$/.test(entry.checksum) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)) throw new Error('cleanup expiry pending: ambiguous durable intent')
    // A returning owner holds its live lease. Preserve everything left by
    // the interrupted cleaner before the owner reads its body.
    if (options.owner) {
      await writeVerified(store, key, undefined)
      return true
    }
    return finishExpiry(store, recovery, options.canStart, options.probe)
  }
  if (!SESSION_ID.test(session) || recovery?.v !== 1 || recovery.session_id !== session ||
      !Array.isArray(recovery.entries) || recovery.entries.some(entry =>
        !ownedKeys([entry.key], session).length || entry.before === undefined && (entry.missing !== true || entry.key !== `h:${session}`) ||
        entry.stamp !== undefined && (entry.stamp.session_id !== session || !Number.isFinite(entry.stamp.closedAt) || entry.stamp.closedAt < 0 || entry.after !== undefined))) throw new Error('cleanup rollback pending: ambiguous durable recovery record')
  if (options.owner) {
    const values = await Promise.all(recovery.entries.map(async entry => ({ key: entry.key, value: await store.get(entry.key) })))
    if (values.some((current, index) => !sameRecord(current.value, recovery.entries[index].before) && !sameRecord(current.value, recoveryAfter(recovery.entries[index])))) {
      // Only the owner may resolve an unexpected value. Archive the journal
      // and current values before clearing it; never replay over them.
      const value = { recovery, values }
      const archiveKey = `r:${session}:cleanup-conflict-${await checksumOf(value)}`
      const snapshot = { v: 1, session_id: session, kind: 'cleanup-conflict', value }
      await ensureCapacity(store, { [archiveKey]: snapshot }, 4 * 1024 * 1024)
      await writeVerified(store, archiveKey, snapshot)
      await writeVerified(store, key, undefined)
      return true
    }
  }
  for (const entry of recovery.entries) {
    const current = await store.get(entry.key)
    if (sameRecord(current, entry.before)) continue
    if (!sameRecord(current, recoveryAfter(entry))) throw new Error(`cleanup rollback pending: could not verify ${entry.key}; later value was kept`)
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

const readSizes = async (store: RetentionStore): Promise<Map<string, number>> => {
  if (store.sizes !== undefined) return store.sizes()
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
  includeIndexSize(planned)
  const bytes = 2 + [...planned.values()].reduce((total, size) => total + size, 0) + Math.max(0, planned.size - 1)
  if (bytes >= budget) throw new Error('capacity: protected or unexpired history fills the UTF-8 store budget; nothing was pruned')
}

const changeRecord = async (store: RetentionStore, session: string, entries: Array<[string, unknown]>, changes: Array<[string, unknown]>, sizes: Map<string, number>, canStart: () => boolean): Promise<boolean> => {
  if (changes.every(([key, value], index) => key === entries[index][0] && sameRecord(value, entries[index][1]))) return false
  const journalKey = recoveryKey(session)
  const recovery: CleanupRecovery = { v: 1, session_id: session,
    entries: entries.map(([key, before], index) => {
      const after = changes[index][1] as Value | undefined
      const stamp = after === undefined ? undefined : { session_id: session, closedAt: after.closedAt as number }
      return stamp !== undefined && sameRecord({ ...before as Value, ...stamp }, after)
        ? { key, before, stamp } : { key, before, ...(before === undefined && { missing: true as const }), after }
    }) }
  // Reserve durable rollback space before the first mutation. A full store
  // refuses cleanup rather than discarding the only remaining copy of a row.
  // Ordinary saves stop at 3 MiB. The store's remaining 1 MiB is reserved
  // for rollback, so expiry can reclaim space after that save limit is hit.
  checkSizes(sizes, { [journalKey]: recovery }, 4 * 1024 * 1024)
  checkSizes(sizes, { ...Object.fromEntries(changes), [journalKey]: recovery }, 4 * 1024 * 1024)
  const write = async (key: string, value: unknown) => {
    await writeVerified(store, key, value)
    if (value === undefined) sizes.delete(key)
    else sizes.set(key, entryBytes(key, value))
  }
  if (!canStart()) return false
  await write(journalKey, recovery)
  try {
    for (const [key, value] of changes) {
      if (!canStart()) throw new Error('cleanup elapsed budget reached; rollback required')
      await write(key, value)
    }
    await write(journalKey, undefined)
    return true
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
      try { await write(journalKey, undefined) }
      catch (rollback) { failures.push(String(rollback)) }
    }
    throw new Error(`${String(error)}${failures.length ? `; cleanup rollback pending (recovery pending): ${failures.join('; ')}` : ''}`)
  }
}

export const cleanupRecords = async (store: RetentionStore, caller: string, probe: Probe): Promise<void> => {
  const now = Date.now()
  const canStart = () => Date.now() - now < WORK_MS
  let visited = 0
  let verified = 0
  let sizes: Map<string, number> | undefined
  const failures: string[] = []
  const previous = await store.get(CLEANUP) as { lastCleanup?: number; lastAttempt?: number; cursor?: string; recoveryCursor?: string } | undefined
  let cursor = previous?.cursor ?? ''
  let recoveryCursor = previous?.recoveryCursor ?? ''
  const recovered = new Set<string>()
  const pending = (await store.keys()).filter(key => key.startsWith('cleanup:')).sort()
  const pendingAfter = pending.filter(key => key > recoveryCursor)
  const orderedPending = [...pendingAfter, ...pending.filter(key => key <= recoveryCursor)]
  for (const key of orderedPending.slice(0, BATCH)) {
    if (!canStart()) break
    recoveryCursor = key
    const session = key.slice('cleanup:'.length)
    if (!SESSION_ID.test(session)) { store.log(`track: cleanup keeps invalid pending identity ${session}`); continue }
    let guard: Guard | undefined
    try {
      // Production resolves caller recovery before reading its body. This path
      // also supports a caller holding its own lease when used independently.
      guard = session === caller ? { state: 'closed', release: async () => {} } : await probe(session)
      if (guard.state !== 'closed') continue
      // Rollback may finish past the budget; expiry must check before each
      // new delete. The returning caller cancels its own expiry instead.
      if (await recoverCleanup(store, session, { owner: session === caller, canStart, probe })) {
        visited++
        recovered.add(session)
      }
    } catch (error) {
      failures.push(String(error))
      store.log(`track: cleanup keeps pending recovery ${session}: ${String(error)}`)
    } finally {
      try { await guard?.release() }
      catch (error) { failures.push(String(error)); store.log(`track: cleanup guard release failed: ${String(error)}`) }
    }
  }
  // A backwards wall clock cannot accelerate expiry or repeatedly run cleanup.
  const lastAttempt = previous?.lastAttempt ?? previous?.lastCleanup
  const isDue = typeof lastAttempt !== 'number' || now - lastAttempt >= HOUR
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
      if (guard.state !== 'closed') { cursor = session; continue }
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
      const headKey = `h:${session}`
      const head = entries.find(([key]) => key === headKey)?.[1] as Value | undefined
      const validClock = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= now
      const closures = entries.map(([, value]) => (value as Value).closedAt)
      const closedAt = validClock(head?.closedAt) ? head.closedAt : closures.length > 0 && closures.every(validClock) ? Math.max(...closures as number[]) : undefined
      const expired = closedAt !== undefined && now - closedAt >= CLOSED_TTL
      if (sizes === undefined) sizes = await readSizes(store)
      if (!canStart()) break
      if (expired) {
        // Recovery snapshots first; the ledger body is the last deletion.
        const deletionOrder = [...entries].sort(([left], [right]) => (left.startsWith('r:') ? 0 : left.startsWith('h:') ? 1 : 2) - (right.startsWith('r:') ? 0 : right.startsWith('h:') ? 1 : 2))
        const intent: ExpiryIntent = { v: 2, mode: 'expiry', session_id: session, closedAt,
          entries: await Promise.all(deletionOrder.map(async ([key, value]) => ({ key, checksum: await checksumOf(value), bytes: entryBytes(key, value) }))) }
        checkSizes(sizes, { [recoveryKey(session)]: intent }, 4 * 1024 * 1024)
        if (!canStart()) break
        await writeVerified(store, recoveryKey(session), intent)
        if (await finishExpiry(store, intent, canStart, probe)) verified++
        sizes = undefined // Finished expiry changed several indexed keys.
      } else if (closedAt === undefined) {
        const stamped = { ...(head ?? { v: 1, retentionOnly: true }), session_id: session, closedAt: closedAt ?? now }
        if (await changeRecord(store, session, [[headKey, head]], [[headKey, stamped]], sizes, canStart)) verified++
      }
      cursor = session
    } catch (error) {
      failures.push(String(error))
      sizes = undefined // A failed store operation may have changed its value.
      cursor = session
      store.log(`track: cleanup keeps ${session}; deferred: ${String(error)}`)
    } finally {
      try { await guard?.release() }
      catch (error) { failures.push(String(error)); store.log(`track: cleanup guard release failed: ${String(error)}`) }
    }
  }
  if (isDue || verified > 0 || cursor !== (previous?.cursor ?? '') || recoveryCursor !== (previous?.recoveryCursor ?? '')) {
    await writeVerified(store, CLEANUP, { v: 1, ...previous, cursor, recoveryCursor,
      ...(isDue && { lastAttempt: now }),
      ...(verified > 0 && failures.length === 0 && { lastCleanup: now }) })
  }
  if (failures.length) throw new Error(failures.join('; '))
}

export const ensureCapacity = async (store: RetentionStore, replacements: Record<string, unknown>, budget: number): Promise<void> => {
  checkSizes(await readSizes(store), replacements, budget)
}
