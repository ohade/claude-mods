import { checkSizes, readSizes } from './retention-capacity'
import type { Compaction } from './retention-eviction'
import { deletionIntent, finishExpiry } from './retention-expiry'
import { changeRecord, recoverCleanup } from './retention-journal'
import { BATCH, CLEANUP, type Guard, HOUR, type Probe, type RetentionStore, SESSION_ID, type Value, WORK_MS, expiryClockOf, hasAmbiguousIdentity, isImported, isInlineV1Body, ownedKeys, recoveryKey, sameRecord, sessionOf, validClock, writeVerified } from './retention-records'

// Gives a session without a usable closing clock the clock of this sighting, through the verified journal.
const stampMissingClock = (store: RetentionStore, session: string, head: Value | undefined, now: number, sizes: Map<string, number>, canStart: () => boolean): Promise<boolean> => {
  const headKey = `h:${session}`
  const stamped = { ...(head ?? { v: 1, retentionOnly: true }), session_id: session, closedAt: now }
  return changeRecord(store, session, [[headKey, head]], [[headKey, stamped]], sizes, canStart)
}

// Runs the injected compaction for one visit. `confirm` is valid only while the
// visit's guard is held, the budget remains and the s: value is the one read.
const migrateInline = (store: RetentionStore, compact: Compaction, session: string, body: Value, isGuardHeld: () => boolean, canStart: () => boolean) => {
  const confirm = async (): Promise<boolean> => isGuardHeld() && canStart() && sameRecord(await store.get(`s:${session}`), body)
  return compact(session, confirm)
}

export const cleanupRecords = async (store: RetentionStore, caller: string, probe: Probe, options: { compact?: Compaction } = {}): Promise<void> => {
  const now = Date.now()
  const canStart = () => Date.now() - now < WORK_MS
  let visited = 0
  let verified = 0
  let compacting = options.compact !== undefined
  let sizes: Map<string, number> | undefined
  const failures: string[] = []
  const previous = await store.get(CLEANUP) as { lastCleanup?: number; lastAttempt?: number; cursor?: string; recoveryCursor?: string; blocked?: string[] } | undefined
  // A backwards wall clock cannot accelerate expiry or repeatedly run cleanup.
  const lastAttempt = previous?.lastAttempt ?? previous?.lastCleanup
  const isDue = typeof lastAttempt !== 'number' || now - lastAttempt >= HOUR
  let cursor = previous?.cursor ?? ''
  let recoveryCursor = previous?.recoveryCursor ?? ''
  const recovered = new Set<string>()
  const pending = (await store.keys()).filter(key => key.startsWith('cleanup:')).sort()
  const blocked = new Set((Array.isArray(previous?.blocked) ? previous.blocked : []).filter(session => pending.includes(recoveryKey(session))))
  const pendingAfter = pending.filter(key => key > recoveryCursor)
  const orderedPending = [...pendingAfter, ...pending.filter(key => key <= recoveryCursor)]
  for (const key of orderedPending.slice(0, BATCH)) {
    if (!canStart()) break
    recoveryCursor = key
    const session = key.slice('cleanup:'.length)
    if (!SESSION_ID.test(session)) { store.log(`track: cleanup keeps invalid pending identity ${session}`); continue }
    if (session !== caller && blocked.has(session) && !isDue) continue
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
        blocked.delete(session)
      } else blocked.add(session)
    } catch (error) {
      failures.push(String(error))
      store.log(`track: cleanup keeps pending recovery ${session}: ${String(error)}`)
    } finally {
      try { await guard?.release() }
      catch (error) { failures.push(String(error)); store.log(`track: cleanup guard release failed: ${String(error)}`) }
    }
  }
  const keys = await store.keys()
  const sessions = [...new Set(keys.flatMap(key => sessionOf(key) ?? []))]
    .filter(session => session !== caller && !recovered.has(session) && !pending.includes(recoveryKey(session)) && SESSION_ID.test(session)).sort()
  const after = sessions.filter(session => session > (previous?.cursor ?? ''))
  const ordered = [...after, ...sessions.filter(session => session <= (previous?.cursor ?? ''))]
  for (const session of isDue ? ordered.slice(0, BATCH - visited) : []) {
    if (!canStart()) break
    let guard: Guard | undefined
    let guardHeld = false
    try {
      try { guard = await probe(session); guardHeld = true }
      catch (error) { store.log(`track: cleanup keeps ${session}: lease ambiguous: ${String(error)}`); cursor = session; continue }
      // Cleaners never rewrite LIVE or unknown records. Only an owner clears
      // its own clocks, under its retained lease, including on resume.
      if (guard.state !== 'closed') { cursor = session; continue }
      if (!canStart()) break
      const entries: Array<[string, unknown]> = []
      for (const key of ownedKeys(keys, session)) entries.push([key, await store.get(key)])
      // A mismatching embedded owner is not safe to migrate or expire.
      if (hasAmbiguousIdentity(entries, session)) {
        store.log(`track: cleanup keeps ${session}: ambiguous record identity`)
        cursor = session
        continue
      }
      const headKey = `h:${session}`
      const head = entries.find(([key]) => key === headKey)?.[1] as Value | undefined
      const closures = entries.map(([, value]) => (value as Value).closedAt)
      const closedAt = validClock(head?.closedAt, now) ? head.closedAt : closures.length > 0 && closures.every(value => validClock(value, now)) ? Math.max(...closures as number[]) : undefined
      const bodyKey = `s:${session}`
      const body = entries.find(([key]) => key === bodyKey)?.[1] as Value | undefined
      // The last save is a second, independent expiry clock; an unusable one is ignored.
      const expiryClock = expiryClockOf(closedAt, body, now)
      if (sizes === undefined) sizes = await readSizes(store)
      if (!canStart()) break
      if (expiryClock !== undefined) {
        const intent = await deletionIntent(session, expiryClock, entries, 'expiry')
        checkSizes(sizes, { [recoveryKey(session)]: intent }, 4 * 1024 * 1024)
        if (!canStart()) break
        if (await finishExpiry(store, intent, canStart, probe, true)) verified++
        // A refused expiry changed nothing; without a closing clock it still needs one, or it is refused again on every pass.
        else if (closedAt === undefined && await stampMissingClock(store, session, head, now, sizes, canStart)) verified++
        sizes = undefined // Finished expiry changed several indexed keys.
      } else if (closedAt === undefined) {
        if (await stampMissingClock(store, session, head, now, sizes, canStart)) verified++
      }
      // An import is never compacted by the hourly path.
      if (expiryClock === undefined && compacting && options.compact !== undefined && !isImported(body) && isInlineV1Body(body)) {
        if (!canStart()) break
        const outcome = await migrateInline(store, options.compact, session, body as Value, () => guardHeld && guard?.state === 'closed', canStart)
        sizes = undefined // Compaction rewrote an indexed key.
        if (outcome === 'compacted') verified++
        else if (outcome === 'stop') compacting = false
      }
      cursor = session
    } catch (error) {
      failures.push(String(error))
      sizes = undefined // A failed store operation may have changed its value.
      cursor = session
      store.log(`track: cleanup keeps ${session}; deferred: ${String(error)}`)
    } finally {
      guardHeld = false
      try { await guard?.release() }
      catch (error) { failures.push(String(error)); store.log(`track: cleanup guard release failed: ${String(error)}`) }
    }
  }
  if (isDue || verified > 0 || cursor !== (previous?.cursor ?? '') || recoveryCursor !== (previous?.recoveryCursor ?? '') || !sameRecord([...blocked], previous?.blocked ?? [])) {
    await writeVerified(store, CLEANUP, { v: 1, ...previous, cursor, recoveryCursor, blocked: [...blocked],
      ...(isDue && { lastAttempt: now }),
      ...(verified > 0 && failures.length === 0 && { lastCleanup: now }) })
  }
  if (failures.length) throw new Error(failures.join('; '))
}
