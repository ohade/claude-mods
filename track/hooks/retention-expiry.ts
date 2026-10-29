import { checksumOf } from './checkpoint'
import { type ExpiryIntent, type Guard, type Probe, type RetentionStore, SESSION_ID, ownedKeys, recoveryKey, writeVerified } from './retention-records'
import { entryBytes } from './size-index'

// Recovery snapshots first; the ledger body is the last deletion.
export const deletionIntent = async (session: string, closedAt: number, entries: Array<[string, unknown]>, mode: ExpiryIntent['mode']): Promise<ExpiryIntent> => {
  const rank = (key: string): number => key.startsWith('r:') ? 0 : key.startsWith('h:') ? 1 : 2
  const deletionOrder = [...entries].sort(([left], [right]) => rank(left) - rank(right))
  return { v: 2, mode, session_id: session, closedAt,
    entries: await Promise.all(deletionOrder.map(async ([key, value]) => ({ key, checksum: await checksumOf(value), bytes: entryBytes(key, value) }))) }
}

export type SwitchArchive = { kind?: string; value?: { source_session?: unknown; ledger?: { session_id?: unknown } } }
// The session whose rows a switch archive holds; false when unknown or ambiguous.
export const switchSource = (archive: SwitchArchive | undefined): string | false | undefined => {
  if (archive?.kind !== 'session-switch') return undefined
  const source = archive.value?.source_session
  return typeof source === 'string' && SESSION_ID.test(source) &&
    (archive.value?.ledger?.session_id === undefined || archive.value.ledger.session_id === source) ? source : false
}

// TRACK-21 refuter 6: a switch archive in B's namespace can contain A's
// unsaved rows. B's CLOSED lease gives no authority to delete a live A's rows.
// `held` names sessions whose CLOSED guard the caller already holds.
const holdArchiveSources = async (store: RetentionStore, intent: ExpiryIntent, guards: Map<string, Guard>, probe: Probe | undefined, canStart: () => boolean, held: ReadonlySet<string>): Promise<boolean> => {
  for (const entry of intent.entries.filter(entry => entry.key.startsWith('r:'))) {
    if (!canStart()) throw new Error('expiry elapsed budget reached; committed deletion remains pending')
    const source = switchSource(await store.get(entry.key) as SwitchArchive | undefined)
    if (source === undefined) continue
    if (source === false) {
      store.log(`track: expiry keeps ${intent.session_id}: session-switch source is unknown or ambiguous`)
      return false
    }
    if (source === intent.session_id || guards.has(source) || held.has(source)) continue
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
export const finishExpiry = async (store: RetentionStore, intent: ExpiryIntent, canStart: () => boolean = () => true, probe?: Probe, publishIntent = false, held: ReadonlySet<string> = new Set()): Promise<boolean> => {
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
    if (!(await holdArchiveSources(store, intent, guards, probe, canStart, held))) return false
    // Publish only after every source is CLOSED; a blocked fresh expiry must
    // not leave a journal that prevents imports or retries on every save.
    if (publishIntent) {
      if (!canStart()) throw new Error('expiry elapsed budget reached before intent publication')
      await writeVerified(store, key, intent)
    }
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
