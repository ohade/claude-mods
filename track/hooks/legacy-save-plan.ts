// Legacy save decisions over already-read values. Sampling and conflict effects stay in the flow.
import type { Baseline, Checkpoint, Ledger } from '../types'
import { bodyMatchesHead, sameRecord, sessionHead } from './durable-record'
import type { SessionHead } from './durable-record'
import { identifyLedger, reconcileLedger } from './reconcile'
import { savedLedger } from './stored-codecs'

export type LegacyPrevious = { checkpoint?: Checkpoint; session_id?: string; generation?: string } | undefined
export type LegacySaveState = { isUnsaved: boolean; reason: string; memorySession?: string | null; rewindSession?: string; closedByPerson?: boolean; baseline?: Baseline; rewindBaseline?: Pick<Baseline, 'session_id' | 'ledger'> }
type Rejected = { kind: 'reject'; reason: string }
type Resolved = { kind: 'resolved'; head: SessionHead | undefined; revision: number; baseline: Baseline | undefined }
type Write = { kind: 'write'; current: Ledger; expected: number | undefined; missing: boolean; priorCheckpoint: Checkpoint | undefined; describePrior: boolean; generation: string | undefined }
type Decision = Rejected | Write | { kind: 'preserve-then-reject'; reason: string } |
  { kind: 'adopt-then-reject'; durable: Ledger; checkpoint: Checkpoint | undefined; generation: string | undefined; cause: unknown }

// This stage precedes savedRevisions.get: a bad rewind baseline must not sample that map.
export const resolveLegacyBaseline = (id: string, previous: LegacyPrevious, previousView: unknown, previousHead: unknown, pending: LegacySaveState): Resolved | Rejected => {
  const head = sessionHead(previousHead, id)
  if (previous?.session_id !== undefined && previous.session_id !== id) return { kind: 'reject', reason: 'saved record identity is ambiguous; history was kept' }
  const revision = previous?.checkpoint?.revision ?? head?.checkpoint.revision ?? 0
  let baseline = pending.baseline?.session_id === id ? pending.baseline : undefined
  if (baseline === undefined && pending.rewindBaseline?.session_id === id && previous !== undefined) {
    const restored = savedLedger(previousView, id)
    if (restored === undefined || !sameRecord(identifyLedger(pending.rewindBaseline.ledger, id), identifyLedger(restored, id))) return { kind: 'reject', reason: 'rewind baseline differs; resume before saving; durable ledger was kept' }
    baseline = { session_id: id, ledger: identifyLedger(restored, id), checkpoint: previous.checkpoint, generation: head?.generation }
  }
  return { kind: 'resolved', head, revision, baseline }
}

export const planLegacyWrite = (id: string, previous: LegacyPrevious, previousView: unknown, pending: LegacySaveState, current: Ledger, knownRevision: number | undefined, resolved: Resolved): Decision => {
  const { head, revision, baseline } = resolved
  const expected = knownRevision ?? baseline?.checkpoint?.revision
  if (previous !== undefined && expected === undefined && baseline === undefined) return { kind: 'reject', reason: 'stale writer revision; no verified baseline; resume before saving; durable ledger was kept' }
  if (!Number.isSafeInteger(revision) || revision < 0) return { kind: 'reject', reason: 'stale writer revision; newer durable ledger was kept' }
  if (previous === undefined && head !== undefined && (expected === undefined || expected !== head.checkpoint.revision || (baseline?.generation !== undefined && baseline.generation !== head.generation))) {
    return { kind: 'preserve-then-reject', reason: 'stale writer revision; newer durable head was kept; its missing body needs recovery' }
  }
  if (previous !== undefined && head !== undefined && !bodyMatchesHead(previous, head)) return { kind: 'reject', reason: 'durable head/body checkpoint mismatch; both were kept' }
  if (previous !== undefined && ((expected !== undefined && expected !== revision) || (baseline?.generation !== undefined && head !== undefined && baseline.generation !== head.generation))) {
    const durable = savedLedger(previousView, id)
    if (durable === undefined) return { kind: 'reject', reason: 'stale writer revision; newer durable ledger was kept' }
    try { current = reconcileLedger(baseline?.ledger, durable, current, id) }
    catch (cause) { return { kind: 'adopt-then-reject', durable, checkpoint: previous.checkpoint, generation: head?.generation, cause } }
  }
  const missing = previous === undefined && (head !== undefined || (expected ?? 0) > 0 || pending.isUnsaved)
  const priorCheckpoint = previous?.checkpoint ?? head?.checkpoint ?? baseline?.checkpoint
  return { kind: 'write', current, expected, missing, priorCheckpoint,
    describePrior: missing && priorCheckpoint === undefined && expected !== undefined,
    generation: missing ? undefined : head?.generation ?? baseline?.generation }
}
