import { checksumOf } from './checkpoint'
import { checkSizes, ensureCapacity } from './retention-capacity'
import { finishExpiry } from './retention-expiry'
import { CLOSED_TTL, type CleanupRecovery, type ExpiryIntent, type Probe, type RetentionStore, SESSION_ID, type Value, ownedKeys, recoveryAfter, recoveryKey, sameRecord, writeVerified } from './retention-records'
import { entryBytes } from './size-index'

// Caller holds either its own lease or a retained CLOSED guard, plus the store
// lock. Resume uses this before its first body read, not on the next save.
export const recoverCleanup = async (store: RetentionStore, session: string, options: { owner?: boolean; canStart?: () => boolean; probe?: Probe } = {}): Promise<boolean> => {
  const key = recoveryKey(session)
  const recovery = await store.get(key) as CleanupRecovery | ExpiryIntent | undefined
  if (recovery === undefined) return false
  if (recovery.v === 2) {
    // TRACK-31: an eviction intent was published under a CLOSED lease before
    // the TTL; the recovering cleaner holds a CLOSED guard on it as well.
    if (!SESSION_ID.test(session) || recovery.session_id !== session || recovery.mode !== 'expiry' && recovery.mode !== 'eviction' ||
        !Number.isFinite(recovery.closedAt) || recovery.closedAt < 0 || !options.owner && recovery.mode === 'expiry' && Date.now() - recovery.closedAt < CLOSED_TTL ||
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
    if (values.some((current, index) => !sameRecord(current.value, recovery.entries[index]!.before) && !sameRecord(current.value, recoveryAfter(recovery.entries[index]!)))) {
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

export const changeRecord = async (store: RetentionStore, session: string, entries: Array<[string, unknown]>, changes: Array<[string, unknown]>, sizes: Map<string, number>, canStart: () => boolean): Promise<boolean> => {
  if (changes.every(([key, value], index) => key === entries[index]![0] && sameRecord(value, entries[index]![1]))) return false
  const journalKey = recoveryKey(session)
  const recovery: CleanupRecovery = { v: 1, session_id: session,
    entries: entries.map(([key, before], index) => {
      const after = changes[index]![1] as Value | undefined
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
        if (!sameRecord(current, changes[index]![1])) throw new Error(`could not verify ${key}; later value was kept`)
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
