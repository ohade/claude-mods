// Complete default-save operation. The caller owns grants, SDK capabilities and per-load state.
import type { Baseline, Checkpoint, Ledger } from '../types'
import { identifyLedger, reconcileLedger, sameLedgerContent } from './reconcile'
import { sameRecord } from './durable-record'
import type { SessionHead } from './durable-record'
import { savedLedger } from './stored-codecs'
import { SAVED_INDEX } from './save-journal'
import type { SavedIndex, SaveWrite } from './save-journal'
import { planLegacyWrite, resolveLegacyBaseline } from './legacy-save-plan'
import type { LegacyPrevious, LegacySaveState } from './legacy-save-plan'

export type LegacySavePorts = {
  id: string; intent: () => Pick<LegacySaveState, 'closedByPerson' | 'rewindSession'>; emptyLedger: Ledger
  recover: () => Promise<void>; recoverCleanup: () => Promise<boolean>; resume: () => Promise<void>
  clearClocks: () => Promise<void>; repairHead: () => Promise<void>
  readLedger: () => Promise<Ledger>; readState: () => Promise<LegacySaveState>
  readBody: () => Promise<unknown>; readHead: () => Promise<unknown>
  logicalBody: (raw: unknown, capture?: (text: string) => void) => Promise<unknown>
  hasRevision: () => boolean; readRevision: () => number | undefined
  writePreference: (value: boolean) => Promise<unknown>; readPreference: () => Promise<unknown>
  preserveConflict: (memory: Ledger, baseline: Baseline | undefined, durable: unknown) => Promise<string>
  adoptConflict: (memory: Ledger, baseline: Baseline | undefined, durable: Ledger, checkpoint: Checkpoint | undefined, generation: string | undefined) => Promise<string>
  describe: (ledger: Ledger, prior?: Checkpoint) => Promise<Checkpoint>
  newGeneration: () => string; now: () => number; hash: (text: string) => Promise<string>
  publish: (text: string, ref: { checksum: string; bytes: number }) => Promise<{ unavailable: string } | { rejected: string } | undefined>
  cleanup: () => Promise<void>; taint: () => void; deferredCleanup: (error: unknown) => void
  nextIndex: (bucket: { savedAt: number }) => Promise<SavedIndex>
  ensureCapacity: (replacements: Record<string, unknown>, index: SavedIndex) => Promise<string[]>
  checkCapacity: (replacements: Record<string, unknown>) => Promise<string[]>
  commit: (write: SaveWrite) => Promise<void>
  updateLedger: (change: (current: Ledger) => Ledger) => Promise<unknown>
  acknowledgeRevision: (revision: number) => void; clearRecovery: () => void; acknowledgeSave: () => void
  updateState: (change: (current: LegacySaveState) => LegacySaveState) => Promise<unknown>
  fallbackNotice: (cause: string) => void
}
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)

export const saveLegacy = async (ports: LegacySavePorts): Promise<void> => {
  const { id } = ports
  await ports.recover()
  if (await ports.recoverCleanup()) await ports.resume()
  else await ports.clearClocks()
  await ports.repairHead()
  const owned = await ports.readLedger()
  const acknowledged = await ports.readState()
  // These reads intentionally short-circuit and repeat. Do not prefetch/cache the body/head.
  if (acknowledged.memorySession !== id || owned.session_id !== undefined && owned.session_id !== id ||
      acknowledged.baseline?.session_id !== id && !ports.hasRevision() &&
      (await ports.readBody() !== undefined || await ports.readHead() !== undefined) &&
      (acknowledged.rewindBaseline?.session_id !== id || await ports.readBody() === undefined ||
       !sameRecord(identifyLedger(acknowledged.rewindBaseline.ledger, id), identifyLedger(savedLedger(await ports.logicalBody(await ports.readBody()), id) ?? ports.emptyLedger, id)))) {
    await ports.resume()
  }
  const pending = { ...await ports.readState(), ...ports.intent() }
  const preference = pending.closedByPerson
  if (preference !== undefined) {
    await ports.writePreference(preference)
    if (await ports.readPreference() !== preference) throw new Error('pane preference read-back did not match')
  }
  const memory = await ports.readLedger()
  const initial = identifyLedger(memory, id)
  const previous = await ports.readBody() as LegacyPrevious
  let previousBlobText: string | undefined
  const previousView = await ports.logicalBody(previous, text => { previousBlobText = text })
  const previousHead = await ports.readHead()
  const resolved = resolveLegacyBaseline(id, previous, previousView, previousHead, pending)
  if (resolved.kind === 'reject') throw new Error(resolved.reason)
  const plan = planLegacyWrite(id, previous, previousView, pending, initial, ports.readRevision(), resolved)
  if (plan.kind === 'reject') throw new Error(plan.reason)
  if (plan.kind === 'preserve-then-reject') {
    await ports.preserveConflict(memory, resolved.baseline, previousHead)
    throw new Error(plan.reason)
  }
  if (plan.kind === 'adopt-then-reject') {
    ports.taint()
    const archive = await ports.adoptConflict(memory, resolved.baseline, identifyLedger(plan.durable, id), plan.checkpoint, plan.generation)
    throw new Error(`stale writer revision; newer durable ledger was kept; local rows archived in ${archive}; ${reason(plan.cause)}`)
  }
  const { current, missing, expected } = plan
  let priorCheckpoint = plan.priorCheckpoint
  if (plan.describePrior) priorCheckpoint = { ...await ports.describe(current), revision: expected!, checksum: '' }
  if (missing && priorCheckpoint !== undefined) priorCheckpoint = { ...priorCheckpoint, checksum: '' }
  const generation = plan.generation ?? ports.newGeneration()
  const checkpoint = await ports.describe(current, priorCheckpoint)
  const inlineBucket = { v: 1, session_id: id, generation, savedAt: ports.now(), ledger: current, checkpoint,
    ...(missing && { recovered: true, expected_revision: expected ?? resolved.head?.checkpoint.revision ?? null }) }
  const text = previousBlobText !== undefined && sameLedgerContent((previousView as { ledger?: unknown } | undefined)?.ledger, current)
    ? previousBlobText : JSON.stringify(current)
  const ref = { checksum: await ports.hash(text), bytes: new TextEncoder().encode(text).length }
  const pointer = Object.fromEntries(Object.entries(inlineBucket).map(([name, value]) =>
    name === 'v' ? [name, 2] : name === 'ledger' ? ['ledger_blob', ref] : [name, value])) as Omit<typeof inlineBucket, 'ledger'> & { ledger_blob: typeof ref }
  const publication = await ports.publish(text, ref)
  if (publication !== undefined && 'rejected' in publication) throw new Error(publication.rejected)
  const fallbackCause = publication?.unavailable
  const bucket = publication === undefined ? pointer : inlineBucket
  if (publication === undefined) {
    try { await ports.cleanup() }
    catch (error) { ports.taint(); ports.deferredCleanup(error) }
  }
  const nextHead: SessionHead = { v: 1, session_id: id, generation, checkpoint }
  const index = await ports.nextIndex(bucket)
  const replacements = { [`s:${id}`]: bucket, [`h:${id}`]: nextHead, [SAVED_INDEX]: index }
  if (fallbackCause === undefined) {
    for (const session of await ports.ensureCapacity(replacements, index)) delete index[session]
  } else {
    try { await ports.checkCapacity(replacements) }
    catch (error) { throw new Error(`blob storage is unavailable: ${fallbackCause}; inline fallback does not fit: ${reason(error)}`, { cause: error }) }
  }
  await ports.commit({ previous, previousBlobText, bucket, previousHead, head: nextHead, index })
  let memoryChanged = false
  await ports.updateLedger(cur => {
    memoryChanged = !sameRecord(cur, memory)
    return memoryChanged ? reconcileLedger(memory, current, cur, id) : current
  })
  ports.acknowledgeRevision(bucket.checkpoint.revision)
  ports.clearRecovery()
  ports.acknowledgeSave()
  await ports.updateState(cur => memoryChanged || cur.closedByPerson !== preference || cur.rewindSession !== pending.rewindSession
    ? { ...cur, baseline: { session_id: id, ledger: current, checkpoint, generation }, isUnsaved: true, reason: memoryChanged ? 'ledger save pending' : cur.closedByPerson !== preference ? 'pane preference save pending' : 'rewind save pending' }
    : { isUnsaved: false, reason: '', memorySession: id, baseline: { session_id: id, ledger: current, checkpoint, generation } })
  if (fallbackCause !== undefined) ports.fallbackNotice(fallbackCause)
}
