import { type SwitchArchive, deletionIntent, switchSource } from './retention-expiry'
import { type ExpiryIntent, type Guard, type Probe, type RetentionStore, SESSION_ID, type Value, hasAmbiguousIdentity, ownedKeys, recoveryKey, sessionOf, validClock } from './retention-records'

// TRACK-35 U2b: converts one candidate's body losslessly. `confirm` holds the
// candidate's CLOSED guard (and its switch sources') exactly as eviction does.
// 'stop' ends compaction; a throw means an uncertain state and fails the write.
export type Compaction = (session: string, confirm: () => Promise<boolean>) => Promise<'compacted' | 'kept' | 'stop'>
export type Eviction = { caller: string; probe: Probe; protect?: string[]; afterEviction?: (session: string) => Promise<void>; heldGuards?: ReadonlyMap<string, Guard>; compact?: Compaction }
const CONFLICT_RECORD = /^r:[^:]+:(cleanup-)?conflict-/

// Oldest first by the later valid save or closing clock; no clock sorts last.
// Imports without a valid closing clock also sort last: their fresh retention
// clock has not been observed. Caller, written or protected sessions, pending
// cleanups and conflict-recovery records are never candidates.
export const evictionOrder = async (store: RetentionStore, keys: string[], replacements: Record<string, unknown>, eviction: Eviction): Promise<Array<[string, number]>> => {
  const kept = new Set([eviction.caller, ...eviction.protect ?? [], ...Object.keys(replacements).flatMap(key => sessionOf(key) ?? [])])
  const present = new Set(keys)
  const sessions = [...new Set(keys.flatMap(key => sessionOf(key) ?? []))].filter(session => SESSION_ID.test(session) && !kept.has(session) &&
    !present.has(recoveryKey(session)) && !ownedKeys(keys, session).some(key => CONFLICT_RECORD.test(key)))
  const clocks = await Promise.all(sessions.map(async (session): Promise<[string, number]> => {
    const body = await store.get(`s:${session}`) as Value | undefined
    const head = await store.get(`h:${session}`) as Value | undefined
    if (body?.import_provenance !== undefined && !validClock(head?.closedAt)) return [session, Number.POSITIVE_INFINITY]
    const timestamps = [body?.savedAt, head?.closedAt].filter((value): value is number => validClock(value))
    return [session, timestamps.length ? Math.max(...timestamps) : Number.POSITIVE_INFINITY]
  }))
  return clocks.sort(([left, leftAt], [right, rightAt]) => leftAt < rightAt ? -1 : leftAt > rightAt ? 1 : left < right ? -1 : left > right ? 1 : 0)
}

// Holds a CLOSED guard in `guards` until the caller releases it, reusing one
// already held: a second writer-lock guard on a held session reports live.
const holdClosed = async (session: string, guards: Map<string, Guard>, probe: Probe): Promise<boolean> => {
  const held = guards.get(session)
  if (held !== undefined) return held.state === 'closed'
  const guard = await probe(session)
  if (guard.state === 'closed') {
    guards.set(session, guard)
    return true
  }
  await guard.release()
  return false
}

// A release can unlock before throwing. Remove its CLOSED authority first;
// retain a failed release only for cleanup, never for a later candidate.
const releaseRejectedGuards = async (store: RetentionStore, guards: Map<string, Guard>, priorGuards: Set<Guard>, releaseRetries: Map<Guard, string>): Promise<void> => {
  for (const [session, guard] of guards) {
    if (guard.state !== 'closed' || priorGuards.has(guard)) continue
    guards.delete(session)
    try { await guard.release() }
    catch (error) {
      releaseRetries.set(guard, session)
      store.log(`track: eviction guard release failed for ${session}: ${String(error)}`)
    }
  }
}

// Returns the eviction intent only when the candidate and every switch-archive
// source are CLOSED under guards held in `guards`, so the planned space is real.
export const confirmEviction = async (store: RetentionStore, session: string, clock: number, eviction: Eviction, guards: Map<string, Guard>, releaseRetries: Map<Guard, string>): Promise<ExpiryIntent | undefined> => {
  const priorGuards = new Set(guards.values())
  let confirmed = false
  try {
    if (!(await holdClosed(session, guards, eviction.probe))) return undefined
    const entries: Array<[string, unknown]> = []
    for (const key of ownedKeys(await store.keys(), session)) entries.push([key, await store.get(key)])
    if (entries.length === 0) return undefined
    if (hasAmbiguousIdentity(entries, session)) {
      store.log(`track: eviction keeps ${session}: ambiguous record identity`)
      return undefined
    }
    for (const [, value] of entries) {
      const source = switchSource(value as SwitchArchive)
      if (source === undefined || source === session) continue
      // The saving session's own lease is live by definition.
      if (source === false || source === eviction.caller || !(await holdClosed(source, guards, eviction.probe))) {
        store.log(`track: eviction keeps ${session}: session-switch source is unknown, ambiguous or live`)
        return undefined
      }
    }
    const intent = await deletionIntent(session, Number.isFinite(clock) ? clock : Date.now(), entries, 'eviction')
    confirmed = true
    return intent
  } catch (error) {
    store.log(`track: eviction keeps ${session}: ${String(error)}`)
    return undefined
  } finally {
    // A rejected candidate must not block a returning owner while later
    // candidates are probed. Earlier accepted candidates still need their guards.
    if (!confirmed) await releaseRejectedGuards(store, guards, priorGuards, releaseRetries)
  }
}
