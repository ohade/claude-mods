// Save journal: owns the legacy save's s:/h:/'saved' acknowledgement and its exact undo.
// Every store capability arrives as an ordinary callback from the native adapter.
import type { Ledger } from '../types'
import type { SessionHead } from './reconcile'
import { utf8Bytes } from './ledger-text'
import { sameRecord } from './retention-records'

export const SAVED_INDEX = 'saved'
export type SavedIndex = Record<string, { at: number; bytes: number; unfinished?: boolean }>
export type SaveRecovery = { previous: unknown; previousBlobText?: string; bucket: unknown; previousHead: unknown; head: SessionHead; previousIndex: unknown; index: unknown }
export type SavedReads = { read: (key: string) => Promise<unknown>; keys: () => Promise<string[]> }
export type SaveJournal = SavedReads & { set: (key: string, value: unknown) => Promise<unknown>; delete: (key: string) => Promise<unknown>;
  writeVerified: (key: string, value: unknown) => Promise<void>; taint: () => void;
  restoreBlob: (pointer: { checksum?: unknown; bytes?: unknown } | undefined, text: string | undefined) => Promise<void> }
export type SaveWrite = { previous: unknown; previousBlobText: string | undefined; bucket: { savedAt: number }; previousHead: unknown; head: SessionHead; index: SavedIndex }

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// Existing entries are verified save metadata. Read only newly discovered
// bodies; capacity uses the separate byte-size index for all stored keys.
// A v:2 body is metadata here: its blob is not read, it counts as unfinished,
// and it is sized by its raw stored value.
export const savedIndex = async (reads: SavedReads): Promise<SavedIndex> => {
  const keys = await reads.keys()
  const cached = await reads.read(SAVED_INDEX) as SavedIndex | undefined
  const index: SavedIndex = {}
  for (const key of keys.filter(k => k.startsWith('s:'))) {
    const id = key.slice(2)
    if (cached?.[id] !== undefined && Number.isFinite(cached[id].at) && Number.isSafeInteger(cached[id].bytes) && cached[id].bytes >= 0) {
      index[id] = cached[id]
      continue
    }
    const bucket = (await reads.read(key)) as { savedAt?: unknown; ledger?: Ledger } | undefined
    const l = bucket?.ledger
    const unfinished = !Array.isArray(l?.questions) || !Array.isArray(l?.steps) || l.questions.some(q => q.cleared !== true && q.status !== 'answered') || l.steps.some(s => s.cleared !== true && s.status !== 'completed')
    index[id] = { at: typeof bucket?.savedAt === 'number' ? bucket.savedAt : 0, bytes: utf8Bytes({ [key]: bucket ?? null }) + 1, unfinished }
  }
  return index
}

// A caller's planned index takes a compacted session's new raw size in place.
export const patchCompacted = (index: SavedIndex) => (session: string, bytes: number): void => {
  if (Object.hasOwn(index, session)) index[session] = { ...index[session]!, bytes }
}

export const nextIndex = async (reads: SavedReads, id: string, bucket: { savedAt: number }): Promise<SavedIndex> => {
  const bytes = utf8Bytes({ [`s:${id}`]: bucket }) + 1
  const others = Object.entries(await savedIndex(reads))
    .filter(([other]) => other !== id)
    .sort(([, a], [, b]) => a.at - b.at)
  return { ...Object.fromEntries(others), [id]: { at: bucket.savedAt, bytes } }
}

export const commitSave = async (journal: SaveJournal, recoveries: Map<string, SaveRecovery>, id: string, w: SaveWrite): Promise<void> => {
  recoveries.set(id, { previous: w.previous, previousBlobText: w.previousBlobText, bucket: w.bucket, previousHead: w.previousHead, head: w.head, previousIndex: await journal.read(SAVED_INDEX), index: w.index })
  await journal.set(`s:${id}`, w.bucket)
  const verified = await journal.read(`s:${id}`)
  if (!sameRecord(verified, w.bucket)) throw new Error('save read-back did not match the acknowledged ledger')
  await journal.writeVerified(`h:${id}`, w.head)
  await journal.set(SAVED_INDEX, w.index)
  if (!sameRecord(await journal.read(SAVED_INDEX), w.index)) throw new Error('save index read-back did not match')
}

// A failed acknowledgement restores only this writer's attempted values, under the
// same store lock. Keep the recovery in memory if the store also refuses rollback.
export const rollbackSave = async (journal: SaveJournal, recoveries: Map<string, SaveRecovery>, id: string): Promise<void> => {
  const recovery = recoveries.get(id)
  if (recovery === undefined) return
  const previous = recovery.previous as { v?: unknown; ledger_blob?: { checksum?: unknown; bytes?: unknown } } | undefined
  if (previous?.v === 2) await journal.restoreBlob(previous.ledger_blob, recovery.previousBlobText)
  const failures: string[] = []
  const key = `s:${id}`
  try {
    const current = await journal.read(key)
    if (!sameRecord(current, recovery.previous)) {
      if (!sameRecord(current, recovery.bucket)) throw new Error('save recovery kept a changed durable ledger; reload this session before writing')
      if (recovery.previous === undefined) await journal.delete(key)
      else await journal.set(key, recovery.previous)
      if (!sameRecord(await journal.read(key), recovery.previous)) throw new Error('save recovery read-back did not match the prior ledger')
    }
  } catch (error) { journal.taint(); failures.push(reason(error)) }
  try {
    const headKey = `h:${id}`
    const currentHead = await journal.read(headKey)
    if (!sameRecord(currentHead, recovery.previousHead)) {
      if (!sameRecord(currentHead, recovery.head)) throw new Error('save recovery kept a changed durable head')
      await journal.writeVerified(headKey, recovery.previousHead)
    }
  } catch (error) { journal.taint(); failures.push(reason(error)) }
  try {
    const index = await journal.read(SAVED_INDEX)
    if (!sameRecord(index, recovery.previousIndex)) {
      // The index is a cache. Rebuild a changed one from actual buckets, keeping
      // another session's entries instead of treating metadata as ownership.
      const restoredIndex = sameRecord(index, recovery.index) ? recovery.previousIndex : await savedIndex(journal)
      if (restoredIndex === undefined) await journal.delete(SAVED_INDEX)
      else await journal.set(SAVED_INDEX, restoredIndex)
      if (!sameRecord(await journal.read(SAVED_INDEX), restoredIndex)) throw new Error('save recovery could not verify the rebuilt index')
    }
  } catch (error) { journal.taint(); failures.push(reason(error)) }
  if (failures.length > 0) throw new Error(failures.join('; '))
  recoveries.delete(id)
}
