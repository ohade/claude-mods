import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginState } from 'claude-code'
import type { Pending, Turn } from '../types'
import { checkpointFailure } from './checkpoint'
import type { Checkpoint } from './checkpoint'
import { LOADED_IDENTITY, EMPTY_LEDGER, IDLE, reason, ringOwner, noteEvent, ownership, OwnerChanged, updateLedger, eventRing, gateCache, configDir } from './track-state'
import type { OwnerToken, Owned } from './track-state'
import { saveLedger, resumeOwned } from './ledger-store'
import { MAX_INPUTS } from './prompt-intake'
import type { DiagnosePorts } from './diagnose-flow'
import { FRESHNESS_KINDS, INPUT_CLAIM_KIND, claimName, inputClaimTurn } from './turn-guidance'

// Atom copies: identical to their register.tsx declarations (tests/helpers/architecture.ts).
const ledger = atom({ plugin: 'track', key: 'ledger' } as const, EMPTY_LEDGER)
const turn = atom({ plugin: 'track', key: 'turn' } as const, { currentId: null, gatedTurnId: null } as Turn)
const pending = atom({ plugin: 'track', key: 'pending' } as const, { inputs: [], nextId: 1 } as Pending)
const renders = atom({ plugin: 'track', key: 'renders' } as const, { session: null, rows: [] } as { session: string | null; rows: [string, string][] })
const activity = atom({ plugin: 'track', key: 'activity' } as const, IDLE)
const durability = atom({ plugin: 'track', key: 'durability' } as const, { isUnsaved: false, reason: '' } as PluginState['track']['durability'])

// Exact render-instance IDs observed in this session, never guessed from transcript UUIDs.
// This presentation cache is bounded and does not write the ledger or store during rendering.
// A reload restarts it but does not redraw rows already on screen (TRACK-48), so a timer copies
// it to $.state under its session, and session.start takes back only this session's copy.
export const renderInstances = new Map<string, string>()
export const renderSaved = { session: undefined as string | undefined, isQueued: false }
export function rememberRender($: EngineInterface, key: string, id: string): void {
  if (renderInstances.get(key) === id) return
  renderInstances.set(key, id)
  if (renderInstances.size > MESSAGES_CAP) renderInstances.delete(renderInstances.keys().next().value!)
  if (renderSaved.isQueued) return
  renderSaved.isQueued = true
  afterDrawing($, 'render instances not saved', async () => {
    renderSaved.isQueued = false
    const session = renderSaved.session
    if (session === undefined) return
    await update($, renders, () => ({ session, rows: [...renderInstances] }))
  })
}

// A save queued by a drawing runs through that drawing's `$`, and the engine refuses its writes
// while that ui.render dispatch is still in flight (an outer mod such as Prismantis keeps drawing
// after Track returns, and the host sets no limit on how long: a hook's budget leaves out its
// next(e) and $ calls). A save refused for that reason waits on a growing delay, capped at the last
// step, until the drawing has ended and the same call is allowed. Any other failure ends it with
// the log line it always had.
export const DRAWING_RETRY_MS = [0, 50, 100, 200, 400, 800, 1600, 3200] as const
export const DRAWING_IN_FLIGHT = 'while ui.render is being dispatched'
export function afterDrawing($: EngineInterface, failure: string, save: () => Promise<void>, attempt = 0): void {
  $.clock.after(DRAWING_RETRY_MS[Math.min(attempt, DRAWING_RETRY_MS.length - 1)]!, () => {
    save().catch(error => {
      const text = reason(error)
      if (!text.includes(DRAWING_IN_FLIGHT)) {
        $.ui.log(`track: ${failure}: ${text}`, { to: 'debug' })
        return
      }
      if (attempt === 0) $.ui.log(`track: save deferred until the drawing ends: ${text}`, { to: 'debug' })
      afterDrawing($, failure, save, attempt + 1)
    })
  })
}

// $.session.messages() answers at most this many entries; past it, older tool calls look
// absent though they are not, so the rewind check does nothing.
export const MESSAGES_CAP = 4096

// An identity failure must not discard a tracking event. Null records explicitly
// unknown ownership: a later save archives these rows instead of relabelling them.
export async function captureMintOwner($: EngineInterface): Promise<string | undefined> {
  try {
    const session = await $.session.id()
    return (await read($, durability)).memorySession === null ? undefined : session
  } catch (error) {
    await update($, durability, current => current.memorySession === undefined ? { ...current, memorySession: null } : current)
    $.ui.log(`track: mint identity unavailable; rows kept for owner recovery: ${reason(error)}`, { to: 'debug' })
    noteEvent($, 'identity.mint_unavailable')
    return undefined
  }
}

// The owner Track's memory holds now, fenced to an ownership epoch read before the caller's
// first await: a later session switch makes every write checked against it refuse.
export async function memoryToken($: EngineInterface, epoch: number): Promise<OwnerToken> {
  return ({ owner: (await read($, ledger)).session_id ?? (await read($, durability)).memorySession ?? undefined, epoch })
}

export async function pressOwned($: EngineInterface, press: (token: OwnerToken) => Promise<void>): Promise<void> {
  const epoch = ownership.epoch
  const owned = await ensureOwner($)
  if (!owned.ok && !owned.isIdentity) {
    $.ui.toast(`track: ${owned.reason}`)
    return
  }
  const token = owned.ok ? owned.token : await memoryToken($, epoch)
  try { await press(token) }
  catch (error) {
    if (!(error instanceof OwnerChanged)) throw error
    $.ui.toast(`track: ${error.message}`)
  }
}

// Native hooks must return a refusal themselves: a thrown error is skipped by the host.
// Keep the completed tool's outcome visible even when Track cannot acknowledge it.
export const ownerChangedResult = (tool: string, ran?: { result?: unknown; context?: readonly string[] }) => {
  const message = ran === undefined
    ? `track: ${tool} was not recorded: session owner changed during the call.`
    : `${tool} returned, but Track could not finish recording it: session owner changed during the call. Any native action already completed was not undone.`
  return { ...ran, isError: true as const,
    result: ran === undefined ? message : `${message}\nReturned result: ${typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result)}`,
    context: [...(ran?.context ?? []), message] }
}

export const isFailedCheckpointResult = (result: unknown): boolean => {
  if (typeof result !== 'string') return false
  try {
    const receipt = JSON.parse(result) as Partial<Checkpoint> | null
    return receipt?.v === 1 && receipt.ok === false
  } catch {
    // A non-JSON result is not a checkpoint refusal to preserve.
    return false
  }
}

export const restoreOwnerChangedResult = (from: string, destination: string | undefined, ran?: { result?: unknown; context?: readonly string[] }) => {
  const message = ran === undefined
    ? 'track: session owner changed during the restore call. If changes were already applied to the original session, they were not undone. Check that session before retrying.'
    : 'track: restore returned, but Track could not finish recording it: session owner changed during the call. Any native action already completed was not undone.'
  return { ...ran, isError: true as const,
    result: JSON.stringify(checkpointFailure(from, message, destination)),
    context: [...(ran?.context ?? []), message,
      ...(ran === undefined ? [] : [`Returned result: ${typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result)}`])] }
}

// A marker answer's drawn instance, kept in its session's ledger and saved at once, so a cold
// resume of the session can still jump to the reply ($.state, which holds renderInstances' copy,
// lasts one process). Written after the drawing (afterDrawing): a write during a render is refused.
// The write is rechecked at the time it runs: a changed or cleared answer, or another session's
// ledger, gets none.
export function keepAnswerInstance($: EngineInterface, key: string, instance: string): void {
  afterDrawing($, 'answer instance not kept', async () => {
    const session = await $.session.id()
    let changed = false
    await updateLedger($, cur => {
      changed = false
      if (cur.session_id !== undefined && cur.session_id !== session) return cur
      const questions = cur.questions.map(q => {
        if (q.answerKey !== key || q.cleared === true || (q.answerInstance === instance && q.answerInstanceSession === session) || (q.session_id !== undefined && q.session_id !== session)) return q
        changed = true
        return { ...q, answerInstance: instance, answerInstanceSession: session }
      })
      return changed ? { ...cur, questions } : cur
    })
    if (changed) await saveLedger($)
  })
}

export function switchOwner($: EngineInterface, id: string): Promise<void> {
  if (ownership.running?.id === id) return ownership.running.run
  // A transition for another session finishes first, so A->B->C runs in order and never interleaves.
  const prior = ownership.running?.run.catch(() => undefined) ?? Promise.resolve()
  const run = prior.then(async () => {
    ownership.epoch++
    ringOwner.id = id
    // Decide after queued transitions finish: A->B->A must clear B's atoms.
    // A same-target direct resume fences old tokens while keeping its own atoms.
    // An unowned ledger with no known memorySession (undefined or null) is a
    // different target: clear the atoms to fail toward the safe side.
    const owner = (await read($, ledger)).session_id ?? (await read($, durability)).memorySession
    if (owner !== id) {
      await update($, turn, () => ({ currentId: null, gatedTurnId: null }))
      await update($, activity, () => IDLE)
      await update($, pending, p => ({ ...p, inputs: [] }))
      // TRACK-46 A4: a classic resume runs no session.start, so the drawn-row cache would still
      // name the old session; its rows are never this session's jump targets.
      if (renderSaved.session !== id) {
        renderInstances.clear()
        renderSaved.session = id
      }
    }
    await resumeOwned($, id)
  })
  const flight = { id, run }
  ownership.running = flight
  void run.catch(() => undefined).finally(() => { if (ownership.running === flight) ownership.running = undefined })
  return run
}

export async function ensureOwner($: EngineInterface): Promise<Owned> {
  const identity = (error: unknown): Owned => ({ ok: false, isIdentity: true, reason: `session identity unavailable: ${reason(error)}; this request did not run` })
  let id: string
  try { id = await $.session.id() } catch (error) { return identity(error) }
  const owner = (await read($, ledger)).session_id ?? (await read($, durability)).memorySession
  if (ownership.running === undefined && (owner === undefined || owner === id)) {
    ringOwner.id = id
    return { ok: true, token: { owner: id, epoch: ownership.epoch } }
  }
  try { await switchOwner($, id) }
  catch (error) { return { ok: false, isIdentity: false, destination: id, reason: `session switch to ${id} failed: ${reason(error)}; this request did not run` } }
  let now: string
  try { now = await $.session.id() } catch (error) { return identity(error) }
  if (now !== id) return { ok: false, isIdentity: false, destination: now, reason: `session changed from ${id} to ${now} during the ownership transition; this request did not run. Track holds ${id}'s saved rows, and the next event loads ${now}'s` }
  return { ok: true, token: { owner: id, epoch: ownership.epoch } }
}

// Failure-intake D3: `observed_disk` is the checkout's HEAD now: evidence of drift, never of the loaded code.
// (LOADED_IDENTITY, the D2 static identity, is declared with the module constants at the top of this file.)
export async function observedDisk($: EngineInterface): Promise<string | undefined> {
  const root = $.plugin.root
  if (!root?.startsWith('/')) return undefined
  try {
    const result = await $.process.run(['git', '-C', root, 'rev-parse', 'HEAD'], { timeoutMs: 2000 })
    const head = result.stdout.trim()
    return result.exitCode === 0 && /^[0-9a-f]{40}$/.test(head) ? head : undefined
  } catch {
    return undefined
  }
}
export async function identityLine($: EngineInterface): Promise<string> {
  return `track: loaded ${LOADED_IDENTITY.loaded === 'unknown' ? 'unknown' : LOADED_IDENTITY.loaded.slice(0, 8)} (disk ${(await observedDisk($))?.slice(0, 8) ?? 'unknown'})`
}

// D9: stat only the claim names this session and turn can own; contents are never read and the
// directory is never listed, so no other session is enumerated.
export async function claimStats($: EngineInterface, session: string, turnId: string | null, heldInputs: number[], epoch?: string, legacy: readonly number[] = []): Promise<Array<{ name: string; kind: string; present: boolean }>> {
  // CLAUDE_CONFIG_DIR wins, as in configDir; HOME is asked only when it is unset.
  let config: string | undefined
  try { config = (await $.env.get('CLAUDE_CONFIG_DIR')) || await configDir($) } catch { config = undefined }
  if (!config?.startsWith('/')) return []
  const wanted: Array<[string, string]> = [
    ...(typeof turnId === 'string' && turnId !== '' ? FRESHNESS_KINDS.map(kind => [turnId, kind] as [string, string]) : []),
    ...heldInputs.slice(0, MAX_INPUTS).map(id => [inputClaimTurn(id, legacy.includes(id) ? undefined : epoch), INPUT_CLAIM_KIND] as [string, string]),
  ]
  const stats: Array<{ name: string; kind: string; present: boolean }> = []
  for (const [claimTurn, kind] of wanted) {
    const name = await claimName(session, claimTurn, kind)
    let present = false
    // D9 lstat: a symbolic link never counts as a present claim, whatever it leads to.
    try {
      const stat = await $.fs.stat(`${config}/state/track/stop-holds/${kind === INPUT_CLAIM_KIND ? 'inputs/' : ''}${name}`)
      present = stat.kind === 'file' && stat.isLink !== true
    }
    catch { present = false }
    stats.push({ name, kind, present })
  }
  return stats
}

// D7-D11: diagnose-flow's native reads, built per call. isAdmitted reads `ownership` on each of its
// two calls; the durability read happens only when the ledger names no owner.
export function diagnosePorts($: EngineInterface): DiagnosePorts {
  return ({
  epoch: () => ownership.epoch,
  sessionId: () => $.session.id(),
  isAdmitted: async (epoch, id) => {
    if (ownership.running !== undefined || ownership.epoch !== epoch) return false
    return ((await read($, ledger)).session_id ?? (await read($, durability)).memorySession) === id
  },
  readLedger: () => read($, ledger),
  readTurn: () => read($, turn),
  readActivity: () => read($, activity),
  readPending: () => read($, pending),
  observedDisk: () => observedDisk($),
  claimStats: (session, turnId, heldInputs, epoch, legacy) => claimStats($, session, turnId, heldInputs, epoch, legacy),
  cachedGate: () => gateCache.last,
  events: () => eventRing,
  identity: LOADED_IDENTITY,
})
}
