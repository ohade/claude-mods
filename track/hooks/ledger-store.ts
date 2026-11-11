import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginState } from 'claude-code'
import type { FreshnessCandidate, FreshnessKind, Ledger, Pending, StepFreshness, Turn } from '../types'
import { checksumOf, describeCheckpoint, matchesCheckpoint } from './checkpoint'
import type { Checkpoint } from './checkpoint'
import { MAX_INPUTS } from './prompt-intake'
import { OPEN_LISTED } from './prompt-context'
import { needsQuestion, freshnessCandidates } from './turn-policy'
import { minimalInputReason, uncoveredBlock } from './stop-guidance'
import { truncate, utf8Bytes } from './ledger-text'
import { savedLedger } from './stored-codecs'
import { saveLegacy } from './legacy-save-flow'
import { readHistoryView } from './history-view'
import type { HistoryView } from './history-view'
import { readBundle, writeBundle } from './export-bundle'
import { cleanupRecords, clearOwnedClocks, isInlineV1Body, recoverCleanup, ensureCapacity as checkCapacity, writeVerified as writeRetentionValue } from './retention'
import type { Compaction, Guard, RetentionStore } from './retention'
import { indexedStore } from './size-index'
import { assertLedgerOwner, identifyLedger, reconcileLedger } from './reconcile'
import type { Baseline } from './reconcile'
import { sessionHead, bodyMatchesHead, sameRecord as sameValue } from './durable-record'
import type { SessionHead } from './durable-record'
import { readBlob } from './blob-store'
import type { BlobFs } from './blob-store'
import { SAVED_INDEX, commitSave, nextIndex, patchCompacted, rollbackSave, savedIndex } from './save-journal'
import type { SaveJournal, SavedIndex, SavedReads } from './save-journal'
import { classifyHistoryReceipt } from './history-receipts'
import type { HistoryRun, HistoryOp } from './history-receipts'
import { STORE_BUDGET, TRACK_QUESTION, SESSION_ID, ANSWER, CLASSIFIER_KEY, EMPTY_LEDGER, IDLE, reason, persistence, savedRevisions, saveRecoveries, writer, gateWrites, ringOwner, noteEvent, gateCache, configDir, sha256Hex, OwnerChanged, assertOwner, updateLedger } from './track-state'
import type { LockStream, OwnerToken } from './track-state'
import { closeLock, guardStates, acquireLock, writeContext, assertWriteOpen, transactionOperation, finishWrite, ensureWriter } from './writer-lock'
import type { WriteContext } from './writer-lock'

// Atom copies: identical to their register.tsx declarations (tests/helpers/architecture.ts).
const ledger = atom({ plugin: 'track', key: 'ledger' } as const, EMPTY_LEDGER)
const turn = atom({ plugin: 'track', key: 'turn' } as const, { currentId: null, gatedTurnId: null } as Turn)
const pending = atom({ plugin: 'track', key: 'pending' } as const, { inputs: [], nextId: 1 } as Pending)
const activity = atom({ plugin: 'track', key: 'activity' } as const, IDLE)
const durability = atom({ plugin: 'track', key: 'durability' } as const, { isUnsaved: false, reason: '' } as PluginState['track']['durability'])


// `attributed_task_ids`: tasks with a recorded owner step. A running task outside it may own
// any step, so the helper reports unknown ownership instead of a stale step.
export type GateSnapshot = { v: 2; session_id: string; turn_id: string | null; open: Array<{ id: number; head: string }>; open_count?: number; inputs: Array<{ id: number; reason: string; legacy?: true }>; inputs_complete: boolean; input_epoch?: string; candidates: FreshnessCandidate[]; attributed_task_ids: string[]; response?: StepFreshness['response']; held: FreshnessKind[]; launch_seq: number; truncated?: true }
export const GATE_SNAPSHOT_BYTES = 16 * 1024


export const fitInputReason = (snapshot: GateSnapshot, index: number, reason: string): boolean => {
  const row = snapshot.inputs[index]!
  const previous = row.reason
  row.reason = reason
  if (utf8Bytes(snapshot) <= GATE_SNAPSHOT_BYTES) return true
  row.reason = previous
  return false
}

export async function publishGate($: EngineInterface, token?: OwnerToken): Promise<GateSnapshot | undefined> {
  let turnId: string | null | undefined
  const run = gateWrites.queue.then(async () => {
    assertOwner(token)
    const t = await read($, turn)
    turnId = t.currentId
    const l = await read($, ledger)
    const open = l.questions.filter(q => q.cleared !== true && q.status === 'open' && q.turnId === t.currentId)
    const fresh = t.freshness?.turnId === t.currentId ? t.freshness : undefined
    const a = await read($, activity)
    const p = await read($, pending)
    const uncovered = p.inputs.filter(i => i.covered === undefined && needsQuestion(i)).sort((a, b) => a.id - b.id)
    const inputs = uncovered.slice(0, MAX_INPUTS)
    const snapshot: GateSnapshot = { v: 2, session_id: await $.session.id(), turn_id: t.currentId,
      open: t.gatedTurnId === t.currentId ? [] : open.slice(0, OPEN_LISTED).map(q => ({ id: q.id, head: q.head })),
      // The true total, only when the list above was cut: the command hook names the rest by count.
      ...(t.gatedTurnId !== t.currentId && open.length > OPEN_LISTED && { open_count: open.length }),
      // The helper's shared claim owns the hold; a module-only held mark must
      // not hide an input from the command hook when classic.Stop is skipped.
      // Reserve every id before budgeting freshness; longer repair wording is optional.
      // 50 minimal rows under 100 bytes each reserve about 5 KB of the 16 KB snapshot budget.
      inputs: inputs.map(i => ({ id: i.id, reason: minimalInputReason(i, TRACK_QUESTION), ...(i.legacy === true && { legacy: true as const }) })),
      inputs_complete: inputs.length === uncovered.length,
      ...(p.epoch !== undefined && { input_epoch: p.epoch }),
      candidates: freshnessCandidates(t, l, a), attributed_task_ids: [...new Set([...Object.keys(a.owners ?? {}), ...(a.launchOwners ?? []).map(row => row.task)])], response: fresh?.response, held: fresh?.held ?? [],
      // The command Stop hook copies this into its task inventory: a launch numbered above it is newer.
      launch_seq: a.launchSeq ?? 0 }
    // TRACK-44: step titles are optional repair text; drop them before losing any safety candidate.
    if (utf8Bytes(snapshot) > GATE_SNAPSHOT_BYTES) snapshot.candidates = freshnessCandidates(t, l, a, false)
    while (utf8Bytes(snapshot) > GATE_SNAPSHOT_BYTES && snapshot.candidates.length > 0) {
      snapshot.candidates.pop()
      snapshot.truncated = true
    }
    if (utf8Bytes(snapshot) > GATE_SNAPSHOT_BYTES) throw new Error('bounded Stop snapshot exceeded')
    // Newest inputs get full wording first, then compact wording for the rest.
    // Only candidate loss sets truncated; input completeness is a separate fact.
    const compact: number[] = []
    for (let index = inputs.length - 1; index >= 0; index--) {
      if (!fitInputReason(snapshot, index, uncoveredBlock([inputs[index]!], ANSWER))) compact.push(index)
    }
    for (const index of compact) fitInputReason(snapshot, index,
      `track: Register "${truncate(inputs[index]!.excerpt, 40)}" with ${TRACK_QUESTION}, source_text = its first line.`)
    assertOwner(token, l)
    if (token?.owner !== undefined && snapshot.session_id !== token.owner) throw new OwnerChanged()
    ringOwner.id = snapshot.session_id
    await $.env.set('TRACK_GATE_SNAPSHOT', JSON.stringify(snapshot))
    gateCache.last = { session_id: snapshot.session_id, gate: { open_count: snapshot.open.length, input_count: snapshot.inputs.length,
      inputs_complete: snapshot.inputs_complete, candidate_kinds: [...new Set(snapshot.candidates.map(row => row.kind))], held: [...snapshot.held], truncated: snapshot.truncated === true } }
    return snapshot
  })
  gateWrites.queue = run.then(() => undefined, error => {
    $.ui.log(`track: Stop snapshot unavailable: ${reason(error)}`, { to: 'debug' })
    noteEvent($, 'stop.snapshot_unavailable', {}, turnId)
  })
  try { return await run } catch { return undefined } // the queue reports the cause above
}

// TRACK-35: a v:2 body keeps its ledger in a content-addressed blob file. The
// raw stored body stays the value for rollback, read-back, hashing and
// compare-and-set; the logical view below is only for reading rows.
export const blobFailure = (detail: string, cause?: unknown): Error =>
  new Error(`saved history blob is missing or damaged (${detail}); pointer was kept`, cause === undefined ? undefined : { cause })

export const refuseBlobMutation = async (): Promise<never> => { throw new Error('track blob readers never write or delete blobs') }
export function blobFs($: EngineInterface): BlobFs {
  return ({
  read: async path => {
    // A missing file reads as absent, so readBlob refuses it; any other read
    // failure keeps its cause. Either way the caller fails closed with the pointer kept.
    try { return await $.fs.read(path) as string }
    catch (error) {
      if (reason(error).includes('ENOENT')) return undefined
      throw blobFailure('blob unreadable', error)
    }
  },
  write: refuseBlobMutation,
  list: refuseBlobMutation,
  remove: refuseBlobMutation,
})
}

// Refuses unsupported declared versions. Returns undefined for no body, a v:1
// or unversioned body unchanged, or a v:2 body as its v:1 inline equivalent
// (`v: 1`, `ledger` from the verified blob in place of
// `ledger_blob`). An invalid pointer or blob throws; it is never absent.
export async function logicalBody($: EngineInterface, raw: unknown, onBlobText?: (text: string) => void): Promise<unknown> {
  const version: unknown = (raw as { v?: unknown } | undefined)?.v
  if (version !== undefined && version !== 1 && version !== 2) throw new Error('saved history version is unsupported; history was kept')
  if (version !== 2) return raw
  const body = raw as Record<string, unknown>
  if (Object.hasOwn(body, 'ledger')) throw blobFailure('a v:2 body also holds an inline ledger')
  const config = await configDir($)
  if (!config?.startsWith('/')) throw blobFailure('blob directory unavailable')
  const text = await readBlob(blobFs($), `${config}/state/track/blobs`, body.ledger_blob as never)
  if (text === undefined) throw blobFailure('blob missing, changed or invalid')
  let ledger: unknown
  try { ledger = JSON.parse(text) }
  catch (error) { throw blobFailure('blob is not JSON', error) }
  if (typeof ledger !== 'object' || ledger === null || Array.isArray(ledger)) throw blobFailure('blob is not a ledger')
  onBlobText?.(text)
  return Object.fromEntries(Object.entries(body).map(([key, value]) =>
    key === 'v' ? [key, 1] : key === 'ledger_blob' ? ['ledger', ledger] : [key, value]))
}

export async function readBodySnapshot($: EngineInterface, key: string, initialRaw: unknown): Promise<unknown> {
  let raw = initialRaw
  for (let attempt = 0; ; attempt++) {
    try { return await logicalBody($, raw) }
    catch (error) {
      if (attempt === 2) throw error
      const nextRaw = await $.store.get(key)
      if (sameValue(nextRaw, raw)) throw error
      raw = nextRaw
    }
  }
}

// The save journal's store capabilities: reads stay raw, and each write takes a new guarded retention store.
export function storeReads($: EngineInterface): SavedReads {
  return ({ read: key => $.store.get(key), keys: () => $.store.keys() })
}
export function saveJournal($: EngineInterface, context: WriteContext): SaveJournal {
  return ({ ...storeReads($),
  set: (key, value) => retentionStore($, context).set(key, value), delete: key => retentionStore($, context).delete(key),
  writeVerified: (key, value) => writeVerified($, context, key, value), taint: () => { context.tainted = true },
  restoreBlob: (pointer, text) => restorePreviousBlob($, context, pointer, text) })
}

// A v:2 recovery first proves the prior blob its old pointer names, publishing it again if the file is gone.
export async function restorePreviousBlob($: EngineInterface, context: WriteContext, pointer: { checksum?: unknown; bytes?: unknown } | undefined, text: string | undefined): Promise<void> {
  if (text === undefined) throw blobFailure('previous blob text unavailable for recovery')
  const ref = { checksum: await sha256Hex(text), bytes: new TextEncoder().encode(text).length }
  if (ref.checksum !== pointer?.checksum || ref.bytes !== pointer?.bytes) {
    throw blobFailure('previous blob text does not match its pointer')
  }
  const config = await configDir($)
  if (!config?.startsWith('/')) throw blobFailure('blob directory unavailable')
  const dir = `${config}/state/track/blobs`
  const fs = blobFs($)
  if (await fs.read(`${dir}/${ref.checksum}.json`) !== undefined) {
    if (await readBlob(fs, dir, ref) !== text) throw blobFailure('previous blob changed or invalid; existing file was kept')
  } else {
    const publication = await publishLedgerBlob($, context, text, ref)
    if (publication !== undefined) throw new Error('unavailable' in publication ? publication.unavailable : publication.rejected)
  }
}

// A sealed writer refuses recovery before the recovery map is read; rollbackSave owns the undo order.
export async function recoverSave($: EngineInterface, context: WriteContext, id: string): Promise<void> {
  assertWriteOpen(context)
  await rollbackSave(saveJournal($, context), saveRecoveries, id)
}

// The hooks compiler requires engine calls to stay in this module. Imported
// retention logic receives ordinary callbacks, never the engine interface.
export function retentionStore($: EngineInterface, context: WriteContext): RetentionStore {
  const store = indexedStore({
    get: key => transactionOperation(context, () => $.store.get(key)),
    set: (key, value) => transactionOperation(context, () => $.store.set(key, value)),
    delete: key => transactionOperation(context, () => $.store.delete(key)),
    keys: () => transactionOperation(context, () => $.store.keys()),
    log: message => { $.ui.log(message, { to: 'debug' }) },
  })
  // The index can fail after a raw mutation succeeded, including inside sizes().
  // Protect the whole indexed operation as well as each raw mutation above.
  return { ...store,
    set: (key, value) => transactionOperation(context, () => store.set(key, value)),
    delete: key => transactionOperation(context, () => store.delete(key)),
    sizes: () => transactionOperation(context, () => store.sizes!()),
  }
}
export async function writeVerified($: EngineInterface, context: WriteContext, key: string, value: unknown): Promise<void> {
  await transactionOperation(context, () => writeRetentionValue(retentionStore($, context), key, value))
}
// A cleaner's or evictor's view of another session's writer lease: CLOSED
// only when the guard says so; the caller releases the guard.
export function probeGuard($: EngineInterface, context: WriteContext) {
  return async (target: string) => {
  const guard = await transactionOperation(context, () => acquireLock($, 'guard', target))
  return { state: guardStates.get(guard) ?? 'live', release: () => transactionOperation(context, () => closeLock(guard)) }
}
}

export type Publication = { unavailable: string } | { rejected: string } | undefined
// Publishes `text` through blob-fs.py and reads it back. `unavailable` means the
// helper or the blob directory is unavailable, so no later candidate can work;
// `rejected` keeps only this candidate.
export async function publishLedgerBlob($: EngineInterface, context: WriteContext, text: string, ref: { checksum: string; bytes: number }): Promise<Publication> {
  assertWriteOpen(context)
  let config: string | undefined
  try { config = await configDir($) }
  catch (error) { return { unavailable: `blob directory unavailable: ${reason(error)}` } }
  if (!config?.startsWith('/')) return { unavailable: 'blob directory unavailable' }
  const dir = `${config}/state/track/blobs`
  let result: Awaited<ReturnType<EngineInterface['process']['run']>>
  try {
    result = await $.process.run(['python3', `${$.plugin.root}/hooks/blob-fs.py`, 'publish', dir, ref.checksum],
      { stdin: text, timeoutMs: 10000, env: { CLAUDE_CONFIG_DIR: config } })
  } catch (error) { context.tainted = true; return { unavailable: `blob helper unavailable: ${reason(error)}` } }
  if (result.exitCode !== 0 || result.isStdoutTruncated === true || result.isStderrTruncated === true) {
    context.tainted = true
    return { rejected: `blob helper exit ${result.exitCode}${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim()}`}` }
  }
  let receipt: { ok?: unknown; checksum?: unknown; bytes?: unknown } | null
  try { receipt = JSON.parse(result.stdout) }
  catch { context.tainted = true; return { rejected: 'blob helper receipt is not JSON' } }
  if (receipt?.ok !== true || receipt.checksum !== ref.checksum || receipt.bytes !== ref.bytes) {
    context.tainted = true
    return { rejected: 'blob helper receipt does not match the ledger' }
  }
  try {
    if (await readBlob(blobFs($), dir, ref) !== text) {
      context.tainted = true
      return { rejected: 'published blob does not match the ledger' }
    }
  } catch (error) { context.tainted = true; return { rejected: `published blob unreadable: ${reason(error)}` } }
  return undefined
}

export const uncertainCompaction = (session: string, detail: string, cause: unknown): Error =>
  new Error(`compaction left ${session} in an uncertain state: ${detail}`, { cause })

// TRACK-35 U2b: converts another CLOSED session's v:1 inline body to a v:2
// pointer before any eviction. The blob is published (content-addressed,
// no-clobber) and verified before the CLOSED guard is taken; the pointer keeps
// every other key in place, so its logical view equals the v:1 body exactly.
// A failure before the pointer write keeps the v:1 body; an unprovable state
// after it throws, so the caller's write fails closed with the value kept.
export function compactBody($: EngineInterface, context: WriteContext, onCompacted?: (session: string, bytes: number) => void): Compaction {
  return async (session, confirm) => {
  assertWriteOpen(context)
  const key = `s:${session}`
  const note = (why: string): void => { $.ui.log(`track: compaction keeps ${session}: ${why}`, { to: 'debug' }) }
  const keep = (why: string): 'kept' => { note(why); return 'kept' }
  const stop = (why: string): 'stop' => { note(why); return 'stop' }
  let original: unknown
  try { original = await $.store.get(key) }
  catch (error) { return keep(`body unreadable: ${reason(error)}`) }
  const body = original as Record<string, unknown> | undefined
  const ledger = body?.ledger
  if (!isInlineV1Body(body)) return body?.v === 1 && Object.hasOwn(body, 'ledger_blob') ? keep('a v:1 body already names a blob') : 'kept'
  const text = JSON.stringify(ledger)
  const ref = { checksum: await sha256Hex(text), bytes: new TextEncoder().encode(text).length }
  const pointer = Object.fromEntries(Object.entries(body).map(([name, value]) =>
    name === 'v' ? [name, 2] : name === 'ledger' ? ['ledger_blob', ref] : [name, value]))
  if (utf8Bytes({ [key]: pointer }) >= utf8Bytes({ [key]: original })) return keep('the pointer does not shrink the full stored entry')
  const publication = await publishLedgerBlob($, context, text, ref)
  if (publication !== undefined) return 'unavailable' in publication ? stop(publication.unavailable) : keep(publication.rejected)
  if (!(await confirm())) return keep('session is not CLOSED or its records are ambiguous')
  try {
    if (!sameValue(await $.store.get(key), original)) return keep('body changed before compaction')
  } catch (error) { context.tainted = true; return keep(`body unreadable under its guard: ${reason(error)}`) }
  try { await writeVerified($, context, key, pointer) }
  catch (error) {
    // The size index's pending marker repairs this key's size for the next locked caller.
    let after: unknown
    try { after = await $.store.get(key) }
    catch (readError) { throw uncertainCompaction(session, `${reason(error)}; re-read failed: ${reason(readError)}`, readError) }
    if (sameValue(after, original)) return keep(`pointer write failed; the v:1 body was kept: ${reason(error)}`)
    if (!sameValue(after, pointer)) throw uncertainCompaction(session, reason(error), error)
  }
  const bytes = utf8Bytes({ [key]: pointer }) + 1
  onCompacted?.(session, bytes)
  const stored = await $.store.get(SAVED_INDEX) as SavedIndex | undefined
  if (stored !== undefined && Object.hasOwn(stored, session)) await writeVerified($, context, SAVED_INDEX, { ...stored, [session]: { ...stored[session], bytes } })
  return 'compacted'
}
}

// Over budget, first compacts other CLOSED sessions' bodies (see compactBody),
// then evicts the oldest CLOSED sessions other than `id`, any written session
// and `protect`, and returns their ids. Each eviction drops its session from
// the stored saved index and each compaction updates its bytes there; a caller
// that publishes its own planned index removes the returned ids from it and
// applies `onCompacted`.
export async function ensureCapacity($: EngineInterface, context: WriteContext, id: string, replacements: Record<string, unknown>, budget: number, protect: string[] = [], onEvicted?: (session: string) => void, heldGuards?: ReadonlyMap<string, Guard>, onCompacted?: (session: string, bytes: number) => void): Promise<string[]> {
  return transactionOperation(context, () => checkCapacity(retentionStore($, context), replacements, budget, { caller: id, protect, probe: probeGuard($, context), heldGuards, compact: compactBody($, context, onCompacted),
    afterEviction: async session => {
      // The history is already deleted; a later index or save failure must not hide it.
      onEvicted?.(session)
      $.ui.toast(`track: closed history for session ${session} was evicted to make room`)
      const stored = await $.store.get(SAVED_INDEX) as SavedIndex | undefined
      if (stored === undefined || !Object.hasOwn(stored, session)) return
      await writeVerified($, context, SAVED_INDEX, Object.fromEntries(Object.entries(stored).filter(([other]) => other !== session)))
    } }))
}


// Under the owner's lease and store lock, complete a torn next-revision write
// or accept a checksummed legacy successor after preserving the prior head.
export async function repairHead($: EngineInterface, context: WriteContext, id: string): Promise<void> {
  assertWriteOpen(context)
  const raw = await $.store.get(`s:${id}`)
  const head = sessionHead(await $.store.get(`h:${id}`), id)
  const body = await logicalBody($, raw) as { v?: number; session_id?: string; generation?: string; checkpoint?: Checkpoint; ledger?: Ledger } | undefined
  if (body === undefined) return
  if (body.session_id !== undefined && body.session_id !== id) throw new Error('saved record identity is ambiguous; history was kept')
  assertLedgerOwner(body.ledger, id)
  if (head === undefined || sameValue(body.checkpoint, head.checkpoint) && body.generation === head.generation) return
  if (body.v !== 1 || body.ledger === undefined || body.generation !== undefined && body.generation !== head.generation ||
      !matchesCheckpoint(await describeCheckpoint(body.ledger, id, body.checkpoint), body.checkpoint)) throw new Error('durable head/body checkpoint mismatch; both were kept')
  if (body.generation === undefined) {
    // An old writer can still publish during rollout. Validate its successor
    // checkpoint before accepting it under our locks. The old-head archive is
    // metadata only; preserve rows separately before reconciliation can drop them.
    if (sameValue(body.checkpoint, head.checkpoint)) return
    if (!Number.isSafeInteger(body.checkpoint?.revision) || (body.checkpoint?.revision ?? 0) <= head.checkpoint.revision) throw new Error('durable head/body checkpoint mismatch; both were kept')
    const memory = await read($, ledger)
    const pending = await read($, durability)
    const owner = memory.session_id ?? pending.memorySession
    const baseline = pending.baseline?.session_id === id ? pending.baseline : undefined
    // Foreign or unknown memory is preserved by the session-switch path.
    const local = owner === id || owner === undefined ? memory : baseline?.ledger
    if (local !== undefined) await preserveConflict($, context, id, local, baseline, { body: raw, head })
    await preserveVersion($, context, id, 'legacy-head', head)
  } else if (body.checkpoint?.revision !== head.checkpoint.revision + 1) throw new Error('durable head/body checkpoint mismatch; both were kept')
  await writeVerified($, context, `h:${id}`, { v: 1, session_id: id, generation: head.generation, checkpoint: body.checkpoint })
}

export async function preserveVersion($: EngineInterface, context: WriteContext, id: string, kind: string, value: unknown): Promise<void> {
  assertWriteOpen(context)
  const key = `r:${id}:${kind}-${await checksumOf(value)}`
  const snapshot = { v: 1, session_id: id, kind, value }
  await ensureCapacity($, context, id, { [key]: snapshot }, STORE_BUDGET)
  await writeVerified($, context, key, snapshot)
}

// TRACK-21 refuter 4: a refusal must not archive a fresh full ledger on every
// call. Deduplicate identical inputs, including memory: a concurrent new row
// needs its own archive before durable history can replace local memory.
export async function preserveConflict($: EngineInterface, context: WriteContext, id: string, memory: Ledger, baseline: Baseline | undefined, durable: unknown): Promise<string> {
  assertWriteOpen(context)
  const identified = identifyLedger(memory, id)
  const key = `r:${id}:conflict-${await checksumOf({ durable, baseline, memory: identified })}`
  const existing = await $.store.get(key) as { session_id?: string; kind?: string } | undefined
  if (existing !== undefined) {
    if (existing.session_id !== id || existing.kind !== 'conflict') throw new Error('conflict archive identity is ambiguous; all inputs were kept')
    return key
  }
  const snapshot = { v: 1, session_id: id, kind: 'conflict', value: { ledger: identified, baseline, durable } }
  await ensureCapacity($, context, id, { [key]: snapshot }, STORE_BUDGET)
  await writeVerified($, context, key, snapshot)
  return key
}

export async function adoptAfterConflict($: EngineInterface, context: WriteContext, id: string, memory: Ledger, baseline: Baseline | undefined, durable: Ledger, checkpoint: Checkpoint | undefined, generation: string | undefined): Promise<string> {
  const key = await preserveConflict($, context, id, memory, baseline, { checkpoint, generation })
  await updateLedger($, current => {
    if (!sameValue(current, memory)) throw new Error('ledger changed during conflict recovery; archive was kept')
    return durable
  })
  if (checkpoint !== undefined) savedRevisions.set(id, checkpoint.revision)
  await update($, durability, current => ({ ...current, memorySession: id, rewindBaseline: undefined,
    baseline: { session_id: id, ledger: durable, checkpoint, generation } }))
  $.ui.log(`track: local conflicting rows kept in ${key}; resumed verified durable history`, { to: 'debug' })
  $.ui.toast(`track: local conflicting rows kept in ${key}; resumed saved history`)
  return key
}

export async function cleanupOwned($: EngineInterface, context: WriteContext, id: string): Promise<void> {
  await transactionOperation(context, () => cleanupRecords(retentionStore($, context), id, probeGuard($, context), { compact: compactBody($, context) }))
}

// A save acknowledges body, durable head and index only after exact read-back.
export async function saveLedger($: EngineInterface, token?: OwnerToken): Promise<boolean> {
  let saved = false
  const run = persistence.queue.then(async () => {
  let id: string | undefined
  const saveFailure = async (error: unknown, context: WriteContext | undefined): Promise<void> => {
    // A stale caller did not attempt a save and cannot mark the new owner's ledger unsaved.
    if (error instanceof OwnerChanged) throw error
    if (context !== undefined) context.tainted = true
    persistence.failure = reason(error)
    if (context !== undefined && id !== undefined) {
      try { await recoverSave($, context, id) }
      catch (recoveryError) { persistence.failure += `; recovery pending: ${reason(recoveryError)}` }
    }
    await update($, durability, cur => ({ ...cur, isUnsaved: true, reason: persistence.failure }))
    $.ui.log(`track: unsaved; save failed: ${persistence.failure}`, { to: 'debug' })
    noteEvent($, 'save.failed', { phase: 'legacy' })
    $.ui.toast(`track: unsaved — ${persistence.failure}`)
  }
  let intent: PluginState['track']['durability']
  try {
    assertOwner(token)
    intent = await read($, durability)
    id = await $.session.id()
    assertOwner(token)
    if (token?.owner !== undefined && id !== token.owner) throw new OwnerChanged()
    const declaredOwner = (await read($, ledger)).session_id
    // Ownership survives even when the first lease or save is refused.
    await update($, durability, current => current.memorySession === undefined || declaredOwner === id ? { ...current, memorySession: id } : current)
    await ensureWriter($, id)
    if (await historyEnabled($)) {
      const routed = await saveRouted($, id, intent, token)
      if (routed !== 'legacy') { saved = routed; return }
    }
  } catch (error) {
    await saveFailure(error, undefined)
    return
  }
  const session = id
  await inOwnGrant($, session, async context => {
    const id = session
    await saveLegacy({
      id, emptyLedger: EMPTY_LEDGER,
      intent: () => ({ closedByPerson: intent.closedByPerson, rewindSession: intent.rewindSession }),
      recover: () => recoverSave($, context, id),
      recoverCleanup: () => recoverCleanup(retentionStore($, context), id, { owner: true }),
      resume: () => resumeLedger($, context, id),
      clearClocks: () => clearOwnedClocks(retentionStore($, context), id),
      repairHead: () => repairHead($, context, id),
      readLedger: () => read($, ledger), readState: () => read($, durability),
      readBody: () => $.store.get(`s:${id}`), readHead: () => $.store.get(`h:${id}`),
      logicalBody: (raw, capture) => logicalBody($, raw, capture),
      hasRevision: () => savedRevisions.has(id), readRevision: () => savedRevisions.get(id),
      writePreference: value => retentionStore($, context).set('closedByPerson', value),
      readPreference: () => $.store.get('closedByPerson'),
      preserveConflict: (memory, baseline, durable) => preserveConflict($, context, id, memory, baseline, durable),
      adoptConflict: (memory, baseline, durable, checkpoint, generation) => adoptAfterConflict($, context, id, memory, baseline, durable, checkpoint, generation),
      describe: (current, prior) => describeCheckpoint(current, id, prior),
      newGeneration: () => crypto.randomUUID(), now: () => Date.now(), hash: text => sha256Hex(text),
      publish: (text, ref) => publishLedgerBlob($, context, text, ref),
      cleanup: () => cleanupOwned($, context, id), taint: () => { context.tainted = true },
      deferredCleanup: error => { $.ui.log(`track: foreign cleanup deferred; caller save continues: ${reason(error)}`, { to: 'debug' }) },
      nextIndex: bucket => nextIndex(storeReads($), id, bucket),
      ensureCapacity: (replacements, index) => ensureCapacity($, context, id, replacements, STORE_BUDGET, [], undefined, undefined, patchCompacted(index)),
      checkCapacity: replacements => checkCapacity(retentionStore($, context), replacements, STORE_BUDGET),
      commit: write => commitSave(saveJournal($, context), saveRecoveries, id, write),
      updateLedger: change => updateLedger($, change),
      acknowledgeRevision: revision => { savedRevisions.set(id, revision) },
      clearRecovery: () => { saveRecoveries.delete(id) },
      acknowledgeSave: () => { persistence.failure = ''; saved = true },
      updateState: change => update($, durability, change),
      fallbackNotice: cause => { $.ui.toast(`track: saved inline because blob storage is unavailable: ${cause}`) },
    })
  }, 'writer', saveFailure)
  })
  persistence.queue = run.catch(() => undefined)
  await run
  return saved
}

export async function saveClassifierSetting($: EngineInterface, isOn: boolean): Promise<void> {
  const run = persistence.queue.then(async () => {
    const session = await $.session.id()
    await ensureWriter($, session)
    await inOwnGrant($, session, context => writeVerified($, context, CLASSIFIER_KEY, { isOn }), 'classifier')
  })
  persistence.queue = run.catch(() => undefined)
  await run
}

// Migration goes through the engine's store for each loading identity. It preserves
// raw buckets and refuses ambiguous same-session data before writing any record.
export async function savePanePreference($: EngineInterface, closedByPerson: boolean): Promise<void> {
  // The engine atom survives reload, so a refused preference is retried by the
  // next save. It uses the ledger's queue, ownership and verified store lock.
  await update($, durability, cur => ({ ...cur, isUnsaved: true, reason: 'pane preference save pending', closedByPerson }))
  await saveLedger($)
}

export async function resumeLedger($: EngineInterface, context: WriteContext, id: string): Promise<void> {
      assertWriteOpen(context)
      await recoverCleanup(retentionStore($, context), id, { owner: true })
      await clearOwnedClocks(retentionStore($, context), id)
      await repairHead($, context, id)
      const raw = await $.store.get(`s:${id}`) as { checkpoint?: Checkpoint; session_id?: string; generation?: string } | undefined
      const head = sessionHead(await $.store.get(`h:${id}`), id)
      if (raw?.session_id !== undefined && raw.session_id !== id) throw new Error('resume record identity is ambiguous')
      if (raw !== undefined && head !== undefined && !bodyMatchesHead(raw, head)) throw new Error('durable head/body checkpoint mismatch; both were kept')
      const restored = savedLedger(await logicalBody($, raw), id)
      if (raw !== undefined && restored === undefined) throw new Error('resume record is incompatible; current rows were kept')
      await applyRestored($, context, id, restored, raw?.checkpoint ?? head?.checkpoint, head?.generation, head?.checkpoint.revision)
}

// Shared by the legacy and v3 resumes: `missingRevision` is the remembered
// revision of a durable checkpoint whose body is missing.
export async function applyRestored($: EngineInterface, context: WriteContext, id: string, restored: Ledger | undefined, checkpoint: Checkpoint | undefined, generation: string | undefined, missingRevision: number | undefined): Promise<void> {
      let memory = await read($, ledger)
      const memoryOwner = memory.session_id ?? (await read($, durability)).memorySession
      if (memoryOwner !== undefined && memoryOwner !== id) {
        const pristine = sameValue(memory, EMPTY_LEDGER)
        if (!pristine) await preserveVersion($, context, id, 'session-switch', { source_session: memoryOwner, ledger: memory })
        const stale = memory
        await updateLedger($, current => {
          if (!sameValue(current, stale)) throw new Error('ledger changed during session switch; current ledger was kept')
          return pristine ? current : { ...EMPTY_LEDGER, session_id: id }
        })
        await update($, durability, () => ({ isUnsaved: false, reason: '', memorySession: id }))
        memory = await read($, ledger)
      }
      const pending = await read($, durability)
      const prior = pending.baseline?.session_id === id ? pending.baseline : undefined
      if (restored !== undefined) {
        const durable = identifyLedger(restored, id)
        const isEmpty = memory.questions.length === 0 && memory.steps.length === 0 && memory.prompts.length === 0
        // Rows minted after a failed initial resume have no durable identity
        // yet. Allocate them beyond the saved IDs before the three-way merge.
        let nextId = Math.max(memory.nextQuestionId, durable.nextQuestionId)
        const local = prior === undefined ? { ...memory,
          questions: memory.questions.map(row => {
            const saved = durable.questions.find(saved => saved.id === row.id)
            const fresh = pending.unverifiedQuestions?.some(minted => minted.id === row.id && minted.at === row.at && minted.head === row.head)
            return saved !== undefined && fresh && !sameValue(row, saved) ? { ...row, id: nextId++ } : row
          }) } : memory
        let reconciled = isEmpty ? durable : identifyLedger({ ...local, nextQuestionId: nextId }, id)
        if (!isEmpty && !sameValue(reconciled, durable)) {
          try { reconciled = reconcileLedger(prior?.ledger, durable, reconciled, id) }
          catch (error) {
            context.tainted = true
            await adoptAfterConflict($, context, id, memory, prior, durable, checkpoint, generation)
            $.ui.log(`track: resume conflict: ${reason(error)}`, { to: 'debug' })
            noteEvent($, 'resume.conflict', { local_questions: local.questions.length, local_steps: local.steps.length,
              durable_questions: durable.questions.length, durable_steps: durable.steps.length })
            await publishGate($)
            return
          }
        }
        await updateLedger($, current => {
          if (!sameValue(current, memory)) throw new Error('ledger changed during resume; both snapshots were kept')
          return reconciled
        })
        if (checkpoint !== undefined) savedRevisions.set(id, checkpoint.revision)
        await update($, durability, current => ({ ...current,
          memorySession: id,
          rewindBaseline: undefined,
          baseline: { session_id: id, ledger: durable, checkpoint, generation } }))
      } else if (missingRevision !== undefined) {
        // A missing body never resets the remembered expected revision to zero.
        if (!savedRevisions.has(id)) savedRevisions.set(id, missingRevision)
      }
      await publishGate($)
}

// TRACK-39 V3: opt-in history roots under TRACK_HISTORY_V3=1. history.py is the
// only writer under state/track/v3 and takes the store flock itself, so no
// history call runs while this module holds a write grant.
export type HistoryExpect = { absent: true } | { seq: number; root_sha256: string }
export const HISTORY_REQUEST_LIMIT = 3 * 1024 * 1024
export const historyPending = atom({ plugin: 'track', key: 'historyPending' } as const, null as PluginState['track']['historyPending'])
export const historyBinding = { store: undefined as string | undefined }
export const HISTORY_COLLECT_INTERVAL_MS = 60 * 60 * 1000
export const historyCollect = { lastAt: undefined as number | undefined }
// Only an explicit '1' runs a v3 path. An unreadable flag keeps a module that
// has already bound v3 on v3, so a v3 session never saves to the legacy store.
export async function historyEnabled($: EngineInterface): Promise<boolean> {
  try { return (await $.env.get('TRACK_HISTORY_V3')) === '1' }
  catch (error) {
    $.ui.log(`track: TRACK_HISTORY_V3 unreadable: ${reason(error)}`, { to: 'debug' })
    return historyBinding.store !== undefined
  }
}
export const SAVE_PENDING = 'save outcome pending: '
// The cause in a failure text whose save outcome is unknown, else undefined.
export const pendingCauseOf = (failure: string): string | undefined =>
  failure.startsWith(SAVE_PENDING) ? failure.slice(SAVE_PENDING.length) : undefined
// The cause of the last save failure when its outcome is unknown, else undefined.
export const savePendingCause = (): string | undefined => pendingCauseOf(persistence.failure)
// A pending outcome may have committed, so its public text never says "unsaved".
export const saveFailureText = (subject: string): string => {
  const cause = savePendingCause()
  return cause === undefined ? `${subject} is unsaved — ${persistence.failure}` : `${subject} save outcome pending — ${cause}`
}

// A pending outcome may have committed, so it never reads as "unsaved".
export class HistoryOutcomePending extends Error {}

// Only an exit-1 precommit refusal for this exact request is a known failure;
// any other incomplete or unparseable answer leaves the outcome pending.
export async function runHistory($: EngineInterface, op: HistoryOp, request: Record<string, unknown>): Promise<HistoryRun> {
  const config = await configDir($)
  if (!config?.startsWith('/')) return { kind: 'refused', reason: 'history configuration unavailable' }
  let result: Awaited<ReturnType<EngineInterface['process']['run']>>
  try {
    result = await $.process.run(['python3', `${$.plugin.root}/hooks/history.py`, op], { stdin: JSON.stringify(request), timeoutMs: 8000, env: { CLAUDE_CONFIG_DIR: config } })
  } catch (error) { return { kind: 'pending', cause: `history ${op} did not answer: ${reason(error)}` } }
  return classifyHistoryReceipt(op, request, result)
}

// The nonce is written under its own grant and is the only engine-store value
// v3 adds. history.py binds only after that grant's completion is confirmed.
export async function bindHistory($: EngineInterface, id: string): Promise<string> {
  if (historyBinding.store !== undefined) return historyBinding.store
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
  let lock: LockStream | undefined
  let context: WriteContext | undefined
  let confirmed = false
  try {
    lock = await acquireLock($, 'write', id)
    context = writeContext(lock)
    // Not through the size index: its rescan would read every legacy body,
    // and a v3 session must never read one as content.
    const binding = { v: 1, nonce }
    await transactionOperation(context, async () => {
      await $.store.set('v3:bind', binding)
      if (!sameValue(await $.store.get('v3:bind'), binding)) throw new Error('bind nonce read-back did not match')
    })
  } catch (error) {
    if (context !== undefined) context.tainted = true
    throw new Error(`v3 history bind abandoned: ${reason(error)}`, { cause: error })
  } finally {
    if (context !== undefined) confirmed = await finishWrite($, context)
    else if (lock !== undefined) await closeLock(lock).catch(error => $.ui.log(`track: writer lock cleanup failed: ${reason(error)}`, { to: 'debug' }))
  }
  if (!confirmed) throw new Error('v3 history bind abandoned: the nonce write was not acknowledged')
  const bound = await runHistory($, 'bind', { v: 3, op: 'bind', plugin: $.plugin.name, nonce })
  if (bound.kind !== 'ok') throw new Error(`v3 history bind refused: ${bound.kind === 'refused' ? bound.reason : bound.cause}`)
  if (typeof bound.response.store !== 'string') throw new Error('v3 history bind receipt is incompatible')
  historyBinding.store = bound.response.store
  return bound.response.store
}

// A valid or damaged root decides the route; only an absent root defers to an
// existing legacy record, so a v3 session never falls back to legacy content.
export function readHistory($: EngineInterface, store: string, id: string): Promise<HistoryView | 'legacy'> {
  return readHistoryView({ read: (store, id) => runHistory($, 'read', { v: 3, op: 'read', store, session_id: id }), legacy: key => $.store.get(key) }, store, id)
}

// Runs `work` under its own write grant and confirms the grant's completion.
export async function inOwnGrant($: EngineInterface, id: string, work: (context: WriteContext) => Promise<void>, cleanupLabel: 'writer' | 'classifier' = 'writer',
  onFailure?: (error: unknown, context: WriteContext | undefined) => Promise<void>, rawClose: 'log' | 'propagate' = 'log'): Promise<void> {
  let lock: LockStream | undefined
  let context: WriteContext | undefined
  try {
    lock = await acquireLock($, 'write', id)
    context = writeContext(lock)
    await work(context)
  } catch (error) {
    if (onFailure !== undefined) {
      await onFailure(error, context)
      return
    }
    if (context !== undefined) context.tainted = true
    throw error
  } finally {
    if (context !== undefined) await finishWrite($, context)
    else if (lock !== undefined) {
      if (rawClose === 'propagate') await closeLock(lock)
      else await closeLock(lock).catch(error => $.ui.log(`track: ${cleanupLabel} lock cleanup failed: ${reason(error)}`, { to: 'debug' }))
    }
  }
}

export async function resumeFromHistory($: EngineInterface, id: string, view: HistoryView): Promise<void> {
  await inOwnGrant($, id, context => applyRestored($, context, id, view.durable, view.root?.checkpoint ?? undefined, view.root?.generation ?? undefined, undefined))
}

// Every resolve outcome is terminal for the pending request; anything else
// keeps it, so no new save can race an earlier one that may have committed.
export async function resolveHistoryPending($: EngineInterface, store: string, id: string): Promise<'committed' | 'fenced' | 'superseded' | undefined> {
  const pending = await read($, historyPending)
  if (pending === null || pending.session_id !== id) return undefined
  const outcome = await runHistory($, 'resolve', { v: 3, op: 'resolve', store, session_id: id, module_token: writer.token,
    request_id: pending.request_id, expect: pending.expect, resolve_id: crypto.randomUUID() })
  const resolved = outcome.kind === 'ok' ? outcome.response.outcome : undefined
  if (resolved !== 'committed' && resolved !== 'fenced' && resolved !== 'superseded') {
    throw new HistoryOutcomePending(`${SAVE_PENDING}${outcome.kind === 'refused' ? outcome.reason : outcome.kind === 'pending' ? outcome.cause : 'resolve receipt is incompatible'}`)
  }
  await update($, historyPending, () => null)
  return resolved
}

// The root view for a save, after merging memory from another session or
// durable rows this module never resumed.
export async function saveView($: EngineInterface, store: string, id: string): Promise<HistoryView | 'legacy'> {
  const view = await readHistory($, store, id)
  if (view === 'legacy') return view
  const acknowledged = await read($, durability)
  const owned = await read($, ledger)
  if (acknowledged.memorySession === id && (owned.session_id === undefined || owned.session_id === id) &&
      (view.durable === undefined || acknowledged.baseline?.session_id === id || savedRevisions.has(id))) return view
  await resumeFromHistory($, id, view)
  const resumed = await readHistory($, store, id)
  if (resumed === 'legacy') throw new Error('v3 history disappeared during resume; current rows were kept')
  return resumed
}

// Rows to save over `view`: memory itself, or its three-way merge when the root
// moved past this module's baseline. A merge conflict archives memory and adopts the root.
export async function mergeWithRoot($: EngineInterface, id: string, view: HistoryView, memory: Ledger, baseline: Baseline | undefined): Promise<Ledger> {
  const current = identifyLedger(memory, id)
  const { root, durable } = view
  if (root === undefined || durable === undefined) return current
  const expected = savedRevisions.get(id) ?? baseline?.checkpoint?.revision
  if (expected === undefined) throw new Error('stale writer revision; no verified baseline; resume before saving; v3 history was kept')
  if (expected === root.checkpoint!.revision && (baseline?.generation === undefined || baseline.generation === root.generation)) return current
  try { return reconcileLedger(baseline?.ledger, durable, current, id) }
  catch (error) {
    let archive = ''
    await inOwnGrant($, id, async context => { archive = await adoptAfterConflict($, context, id, memory, baseline, durable, root.checkpoint!, root.generation!) })
    throw new Error(`stale writer revision; newer v3 history was kept; local rows archived in ${archive}; ${reason(error)}`)
  }
}

// Records the request as pending before history.py runs, so an unknown outcome
// is resolved before any later save; clears it only on a known outcome.
export async function commitHistorySave($: EngineInterface, store: string, id: string, view: HistoryView, current: Ledger): Promise<{ checkpoint: Checkpoint; generation: string }> {
  const { root } = view
  const checkpoint = await describeCheckpoint(current, id, root?.checkpoint ?? undefined)
  const generation = root?.generation ?? crypto.randomUUID()
  const expect: HistoryExpect = root === undefined ? { absent: true } : { seq: root.seq, root_sha256: view.rootHash! }
  const request = { v: 3, op: 'save', store, session_id: id, module_token: writer.token, request_id: crypto.randomUUID(), expect,
    generation, checkpoint, savedAt: Date.now(), ledger_text: JSON.stringify(current) }
  if (new TextEncoder().encode(JSON.stringify(request)).length > HISTORY_REQUEST_LIMIT) throw new Error('history save request too large; rows were kept')
  await update($, historyPending, () => ({ session_id: id, request_id: request.request_id, expect }))
  const saved = await runHistory($, 'save', request)
  if (saved.kind === 'pending') throw new HistoryOutcomePending(`${SAVE_PENDING}${saved.cause}`)
  await update($, historyPending, () => null)
  if (saved.kind === 'refused') throw new Error(saved.reason)
  return { checkpoint, generation }
}

// The rows are committed; a pane preference refused afterwards stays pending on
// its own and never makes the committed rows read as unsaved.
export async function acknowledgeHistorySave($: EngineInterface, id: string, memory: Ledger, current: Ledger, saved: { checkpoint: Checkpoint; generation: string }, intended: PluginState['track']['durability']): Promise<void> {
  const { checkpoint, generation } = saved
  let memoryChanged = false
  await updateLedger($, cur => {
    memoryChanged = !sameValue(cur, memory)
    return memoryChanged ? reconcileLedger(memory, current, cur, id) : current
  })
  savedRevisions.set(id, checkpoint.revision)
  persistence.failure = ''
  const preference = intended.closedByPerson
  let preferenceFailure: string | undefined
  if (preference !== undefined) {
    try {
      await inOwnGrant($, id, async context => {
        await retentionStore($, context).set('closedByPerson', preference)
        if (await $.store.get('closedByPerson') !== preference) throw new Error('pane preference read-back did not match')
      })
    } catch (error) {
      preferenceFailure = reason(error)
      $.ui.log(`track: pane preference not saved; rows were saved: ${preferenceFailure}`, { to: 'debug' })
      $.ui.toast(`track: pane preference not saved — ${preferenceFailure}`)
    }
  }
  const baseline = { session_id: id, ledger: current, checkpoint, generation }
  await update($, durability, cur => preferenceFailure !== undefined
    ? { ...cur, baseline, memorySession: id, isUnsaved: true, reason: `pane preference save pending: ${preferenceFailure}` }
    : memoryChanged || cur.closedByPerson !== preference || cur.rewindSession !== intended.rewindSession
      ? { ...cur, baseline, isUnsaved: true, reason: memoryChanged ? 'ledger save pending' : cur.closedByPerson !== preference ? 'pane preference save pending' : 'rewind save pending' }
      : { isUnsaved: false, reason: '', memorySession: id, baseline })
}

// TRACK-39 A2: after a successful save, at most once an hour per module and
// with no write grant open, history.py moves roots idle for seven days to its
// trash. The own session and the session whose save was pending before this one
// stay protected (this save replaces that record); a failure is only logged.
export async function collectHistory($: EngineInterface, store: string, id: string, pendingSession: string | undefined): Promise<void> {
  const now = await $.clock.now()
  if (historyCollect.lastAt !== undefined && now - historyCollect.lastAt < HISTORY_COLLECT_INTERVAL_MS) return
  historyCollect.lastAt = now
  const protectedSessions = pendingSession === undefined || pendingSession === id ? [id] : [id, pendingSession]
  const collected = await runHistory($, 'collect', { v: 3, op: 'collect', store, protected: protectedSessions, dry_run: false, limit: 50 })
  if (collected.kind !== 'ok') {
    $.ui.log(`track: history collect skipped: ${collected.kind === 'refused' ? collected.reason : collected.cause}`, { to: 'debug' })
    noteEvent($, 'history.collect_skipped', { reason: collected.kind })
  }
}

// Returns 'legacy' for a session that still lives in the engine store. It never
// throws: like the legacy save it records the failure and returns false.
export async function saveRouted($: EngineInterface, id: string, intent: PluginState['track']['durability'], token?: OwnerToken): Promise<'legacy' | boolean> {
  try {
    const pendingSession = (await read($, historyPending))?.session_id
    const store = await bindHistory($, id)
    const resolved = await resolveHistoryPending($, store, id)
    const view = await saveView($, store, id)
    if (view === 'legacy') return 'legacy'
    assertOwner(token)
    const intended = { ...await read($, durability), closedByPerson: intent.closedByPerson, rewindSession: intent.rewindSession }
    const memory = await read($, ledger)
    const { root, durable } = view
    if (resolved === 'committed' && root !== undefined && durable !== undefined && sameValue(durable, identifyLedger(memory, id))) {
      // The lost receipt's save already holds these rows. Acknowledge it like a
      // fresh commit, pane preference included, without saving the root again.
      await acknowledgeHistorySave($, id, memory, durable, { checkpoint: root.checkpoint!, generation: root.generation! }, intended)
    } else {
      const current = await mergeWithRoot($, id, view, memory, intended.baseline?.session_id === id ? intended.baseline : undefined)
      const saved = await commitHistorySave($, store, id, view, current)
      await acknowledgeHistorySave($, id, memory, current, saved, intended)
    }
    // At most once an hour this reply waits for the collect, bounded by its 8000 ms timeout.
    await collectHistory($, store, id, pendingSession).catch(error => $.ui.log(`track: history collect skipped: ${reason(error)}`, { to: 'debug' }))
    return true
  } catch (error) {
    if (error instanceof OwnerChanged) throw error
    persistence.failure = reason(error)
    await update($, durability, cur => ({ ...cur, isUnsaved: true, reason: persistence.failure }))
    if (error instanceof HistoryOutcomePending) {
      $.ui.log(`track: ${persistence.failure}`, { to: 'debug' })
      $.ui.toast(`track: save outcome pending — ${savePendingCause()}`)
    } else {
      $.ui.log(`track: unsaved; save failed: ${persistence.failure}`, { to: 'debug' })
      noteEvent($, 'save.failed', { phase: 'history' })
      $.ui.toast(`track: unsaved — ${persistence.failure}`)
    }
    return false
  }
}

export async function resumeRouted($: EngineInterface, id: string): Promise<'legacy' | 'v3'> {
  await ensureWriter($, id)
  const store = await bindHistory($, id)
  await resolveHistoryPending($, store, id)
  const view = await readHistory($, store, id)
  if (view === 'legacy') return 'legacy'
  await resumeFromHistory($, id, view)
  return 'v3'
}

// The acknowledged checkpoint and rows of `id`, or 'legacy' when it has no root.
export async function historySnapshot($: EngineInterface, id: string): Promise<{ checkpoint?: Checkpoint; ledger?: Ledger } | undefined | 'legacy'> {
  const run = persistence.queue.then(async () => {
    const owner = await $.session.id()
    await ensureWriter($, owner)
    const store = await bindHistory($, owner)
    await resolveHistoryPending($, store, id)
    const view = await readHistory($, store, id)
    if (view === 'legacy') return 'legacy' as const
    return view.root === undefined || view.durable === undefined ? undefined : { checkpoint: view.root.checkpoint ?? undefined, ledger: view.durable }
  })
  persistence.queue = run.then(() => undefined, () => undefined)
  return run
}

export async function resumeOwned($: EngineInterface, id: string): Promise<void> {
  const run = persistence.queue.then(async () => {
    const resumeFailure = async (error: unknown, context: WriteContext | undefined): Promise<void> => {
      if (context !== undefined) context.tainted = true
      // A pending outcome keeps its leading marker, so no surface calls a possibly committed save unsaved.
      const text = error instanceof HistoryOutcomePending ? reason(error) : `resume: ${reason(error)}`
      await update($, durability, current => ({ ...current, isUnsaved: true, reason: text }))
      throw error
    }
    try {
      if (await historyEnabled($) && await resumeRouted($, id) === 'v3') return
      await ensureWriter($, id)
    } catch (error) {
      await resumeFailure(error, undefined)
      return
    }
    await inOwnGrant($, id, async context => {
      await recoverSave($, context, id)
      await resumeLedger($, context, id)
    }, 'writer', resumeFailure, 'propagate')
  })
  persistence.queue = run.catch(() => undefined)
  await run
}

// TRACK-54: an imported body whose ledger is over IMPORT_INLINE_MAX is stored as a v:2 pointer to a
// published ledger blob, the form compactBody gives a CLOSED body, so a large bundle fits the store
// budget. A smaller body is stored inline, as before. A failed publication fails the import closed.
export const IMPORT_INLINE_MAX = 4 * 1024
export async function importStored($: EngineInterface, context: WriteContext, key: string, value: unknown): Promise<unknown> {
  if (!isInlineV1Body(value)) return value
  const text = JSON.stringify(value.ledger)
  const bytes = new TextEncoder().encode(text).length
  if (bytes <= IMPORT_INLINE_MAX) return value
  const ref = { checksum: await sha256Hex(text), bytes }
  const pointer = Object.fromEntries(Object.entries(value).map(([name, field]) =>
    name === 'v' ? [name, 2] : name === 'ledger' ? ['ledger_blob', ref] : [name, field]))
  if (utf8Bytes({ [key]: pointer }) >= utf8Bytes({ [key]: value })) return value
  const publication = await publishLedgerBlob($, context, text, ref)
  if (publication !== undefined) throw new Error(`migration could not store session ${key.slice(2)} as a blob: ${'unavailable' in publication ? publication.unavailable : publication.rejected}`)
  return pointer
}

// The engine's file calls for a migration bundle (export-bundle.ts); $.fs itself cannot be passed.
export function bundleFs($: EngineInterface) {
  return ({ read: (path: string) => $.fs.read(path), write: (path: string, text: string) => $.fs.write(path, text) })
}

export async function migrateStore($: EngineInterface, mode: 'export' | 'import', path: string): Promise<string> {
  if (await historyEnabled($)) return JSON.stringify({ v: 1, ok: false, reason: 'export/import is unavailable while TRACK_HISTORY_V3 is on' })
  const run = persistence.queue.then(async () => {
  let lock: LockStream | undefined
  let context: WriteContext | undefined
  const guards: LockStream[] = []
  const heldGuards = new Map<string, Guard>()
  const evicted: string[] = []
  try {
    if (!path.startsWith('/') || path.includes('\0')) throw new Error('an absolute bundle path is required')
    const session = await $.session.id()
    await ensureWriter($, session)
    lock = await acquireLock($, 'write', session)
    context = writeContext(lock)
    await recoverSave($, context, session)
    if (mode === 'export') {
      const records = [] as Array<{ key: string; value: unknown }>
      for (const key of (await $.store.keys()).filter(key => key.startsWith('s:')).sort()) records.push({ key, value: await logicalBody($, await $.store.get(key)) })
      const checksum = await checksumOf(records)
      // TRACK-54: one v1 file when it fits under the engine's 4 MiB limit, else a manifest and parts.
      await transactionOperation(context, () => writeBundle(bundleFs($), path, { v: 1, source_identity: $.plugin.root, checksum, records }))
      return JSON.stringify({ v: 1, ok: true, checksum, records: records.length })
    }
    const bundle = await readBundle(bundleFs($), path)
    if (bundle.v !== 1 || !Array.isArray(bundle.records) || bundle.checksum !== await checksumOf(bundle.records)) throw new Error('migration bundle is corrupt or incompatible')
    const records = bundle.records
    if (new Set(records.map(r => r.key)).size !== records.length || records.some(r => !r.key.startsWith('s:') || !SESSION_ID.test(r.key.slice(2)) || savedLedger(r.value) === undefined)) throw new Error('migration contains invalid or duplicate session records')
    const imported: string[] = []
    const replacements: Record<string, unknown> = {}
    const normalized: Array<{ key: string; value: unknown; head: SessionHead; stored: unknown; isKept: boolean }> = []
    for (const record of records) {
      const target = record.key.slice(2)
      if (await $.store.get(`cleanup:${target}`) !== undefined) throw new Error(`migration keeps session ${target}: pending cleanup must be resolved by its owner`)
      const owner = (record.value as { session_id?: unknown }).session_id
      if (owner !== undefined && owner !== target) throw new Error('migration record identity is ambiguous')
      const current = await $.store.get(record.key)
      // A v:2 destination is compared by its logical view and, when equal, kept raw.
      const currentView = await logicalBody($, current)
      const isPointer = (current as { v?: unknown } | undefined)?.v === 2
      const source = record.value as { ledger: Ledger; generation?: string; checkpoint?: Checkpoint }
      const provenance = { source_identity: bundle.source_identity ?? null, bundle_checksum: bundle.checksum, source_session: target }
      const destination = current as { generation?: string; import_provenance?: unknown } | undefined
      const generation = source.generation ?? (sameValue(destination?.import_provenance, provenance) ? destination?.generation : undefined) ?? crypto.randomUUID()
      if (!SESSION_ID.test(generation) || (source.checkpoint !== undefined &&
          (source.checkpoint.source_session !== target || !Number.isSafeInteger(source.checkpoint.revision) || source.checkpoint.revision < 1))) throw new Error('migration checkpoint identity is ambiguous')
      const identified = identifyLedger(source.ledger, target)
      const checkpoint = await describeCheckpoint(identified, target, source.checkpoint)
      if (source.checkpoint !== undefined && checkpoint.checksum !== source.checkpoint.checksum) throw new Error('migration checkpoint checksum does not match its rows')
      const value = { ...source, session_id: target, ledger: identified, generation, checkpoint, import_provenance: provenance }
      const head: SessionHead = { v: 1, session_id: target, generation, checkpoint }
      const currentHead = sessionHead(await $.store.get(`h:${target}`), target)
      if (current !== undefined && !sameValue(currentView, value) && !sameValue(currentView, record.value)) throw new Error(`migration conflict for session ${target}; both records were kept`)
      if (currentHead !== undefined && !sameValue(currentHead, head)) throw new Error(`migration conflict: session ${target} has a durable head; source was kept`)
      const isKept = isPointer && currentHead !== undefined
      let stored: unknown = value
      if (!isKept && (!sameValue(current, value) || currentHead === undefined)) {
        if (target !== session) {
          const guard = await acquireLock($, 'guard', target)
          guards.push(guard)
          if (guardStates.get(guard) !== 'closed') throw new Error(`migration keeps live or unknown session ${target}`)
          const guardedContext = context
          heldGuards.set(target, { state: 'closed', release: () => transactionOperation(guardedContext, () => closeLock(guard)) })
        }
        stored = await importStored($, context!, record.key, value)
        replacements[record.key] = stored
        replacements[`h:${target}`] = head
        if (current === undefined) imported.push(target)
      }
      normalized.push(isKept ? { key: record.key, value: currentView, head, stored: current, isKept } : { key: record.key, value, head, stored, isKept })
    }
    const index = await savedIndex(storeReads($))
    for (const record of normalized) {
      const bucket = record.value as { savedAt: number; ledger: Ledger }
      const unfinished = bucket.ledger.questions.some(q => q.cleared !== true && q.status !== 'answered') || bucket.ledger.steps.some(s => s.cleared !== true && s.status !== 'completed')
      index[record.key.slice(2)] = { at: bucket.savedAt, bytes: utf8Bytes({ [record.key]: record.stored }) + 1, unfinished }
    }
    replacements[SAVED_INDEX] = index
    // Unchanged records are verified below, so every bundle session is kept.
    const completedEvictions = await ensureCapacity($, context, session, replacements, STORE_BUDGET, normalized.map(record => record.key.slice(2)), other => { evicted.push(other) }, heldGuards,
      patchCompacted(index))
    for (const other of completedEvictions) delete index[other]
    const verified: string[] = []
    for (const record of normalized) {
      if (Object.hasOwn(replacements, record.key)) {
        await writeVerified($, context, record.key, record.stored)
        await writeVerified($, context, `h:${record.key.slice(2)}`, record.head)
      }
      const reread = await $.store.get(record.key)
      if (!sameValue(record.isKept || record.stored !== record.value ? await logicalBody($, reread) : reread, record.value) || !sameValue(await $.store.get(`h:${record.key.slice(2)}`), record.head)) throw new Error(`migration verification failed for session ${record.key.slice(2)}; source was kept`)
      verified.push(record.key.slice(2))
    }
    await writeVerified($, context, SAVED_INDEX, index)
    return JSON.stringify({ v: 1, ok: true, checksum: bundle.checksum, imported, verified, evicted })
  } catch (error) {
    if (context !== undefined) context.tainted = true
    return JSON.stringify({ v: 1, ok: false, reason: reason(error), ...(mode === 'import' && { evicted }) })
  } finally {
    for (const guard of guards) await closeLock(guard).catch(error => {
      if (context !== undefined) context.tainted = true
      $.ui.log(`track: import lease cleanup failed: ${reason(error)}`, { to: 'debug' })
    })
    if (context !== undefined) await finishWrite($, context)
    else if (lock !== undefined) await closeLock(lock).catch(error => $.ui.log(`track: migration lock cleanup failed: ${reason(error)}`, { to: 'debug' }))
  }
  })
  persistence.queue = run.then(() => undefined, () => undefined)
  return run
}
