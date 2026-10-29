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
export const HOUR = 60 * 60 * 1000
export const CLOSED_TTL = 7 * 24 * HOUR
export const BATCH = 8
export const WORK_MS = 250
export const CLEANUP = 'cleanup'
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export type Guard = { state: 'closed' | 'live'; release: () => Promise<void> }
export type Probe = (session: string) => Promise<Guard>
export type Value = Record<string, unknown>
type RecoveryEntry = { key: string; before: unknown; missing?: true; after?: unknown; stamp?: { session_id: string; closedAt: number } }
export type CleanupRecovery = { v: 1; session_id: string; entries: RecoveryEntry[] }
export type ExpiryIntent = { v: 2; mode: 'expiry' | 'eviction'; session_id: string; closedAt: number; entries: Array<{ key: string; checksum: string; bytes: number }> }
export const recoveryAfter = (entry: RecoveryEntry): unknown => entry.stamp === undefined ? entry.after : { ...entry.before as Value, ...entry.stamp }
export const recoveryKey = (session: string): string => `cleanup:${session}`
export const sameRecord = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

export const writeVerified = async (store: RetentionStore, key: string, value: unknown): Promise<void> => {
  if (value === undefined) await store.delete(key)
  else await store.set(key, value)
  if (!sameRecord(await store.get(key), value)) throw new Error(`retention read-back mismatch: ${key}`)
}

export const ownedKeys = (keys: string[], session: string): string[] => keys.filter(key =>
  key === `s:${session}` || key === `h:${session}` || key.startsWith(`r:${session}:`))

// A usable clock is a finite, non-negative time no later than `now`.
export const validClock = (value: unknown, now = Number.POSITIVE_INFINITY): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= now

const RECORD_KEY = /^[shr]:/
export const sessionOf = (key: string): string | undefined => RECORD_KEY.test(key) ? key.split(':')[1] : undefined

export const hasAmbiguousIdentity = (entries: Array<[string, unknown]>, session: string): boolean => entries.some(([, value]) => value === null || typeof value !== 'object' ||
  ((value as Value).session_id !== undefined && (value as Value).session_id !== session))

// TRACK-43: a CLOSED v1 body keeps its history inline; the injected compaction
// moves it to a blob pointer. This is the one shape both the hourly cleanup and
// compaction require: v:1, an inline ledger object, no blob pointer.
export const isInlineV1Body = (body: unknown): body is Value & { v: 1; ledger: Value } => typeof body === 'object' && body !== null &&
  (body as Value).v === 1 && typeof (body as Value).ledger === 'object' && (body as Value).ledger !== null && !Array.isArray((body as Value).ledger) &&
  !Object.hasOwn(body, 'ledger_blob')

// An imported savedAt comes from the source store, so only closedAt can expire or compact an import.
export const isImported = (body: Value | undefined): boolean => body !== undefined && Object.hasOwn(body, 'import_provenance')

// The clock that expires a session: an expired valid closedAt first; else an expired
// valid savedAt, never an import's; otherwise none. Zero is a valid clock.
export const expiryClockOf = (closedAt: number | undefined, body: Value | undefined, now: number): number | undefined => {
  if (closedAt !== undefined && now - closedAt >= CLOSED_TTL) return closedAt
  return !isImported(body) && validClock(body?.savedAt, now) && now - body.savedAt >= CLOSED_TTL ? body.savedAt : undefined
}
