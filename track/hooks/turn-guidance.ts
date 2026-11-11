import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Activity, FreshnessKind, Ledger, PendingInput, Step, Turn } from '../types'
import { visibleSteps } from './steps'
import { OPEN_STEPS_LISTED } from './prompt-context'
import { ownerTasksForStep } from './turn-policy'
import { uncoveredBlock } from './stop-guidance'
import { canFollowUp } from './task-ownership'
import { MAX_STEPS, STEP_STATUSES, distinctIds } from './ledger-policy'
import { MARK_STEP, TRACK_STEPS, STEP_RESULT, ANSWER, EMPTY_LEDGER, IDLE, reason, noteEvent, freshTurn, configDir, sha256Hex, assertOwner, updateLedger } from './track-state'
import type { OwnerToken } from './track-state'
import { publishGate, saveLedger } from './ledger-store'
import type { StopClaimSnapshot } from './ledger-store'

// Atom copies: identical to their register.tsx declarations (tests/helpers/architecture.ts).
const ledger = atom({ plugin: 'track', key: 'ledger' } as const, EMPTY_LEDGER)
const turn = atom({ plugin: 'track', key: 'turn' } as const, { currentId: null, gatedTurnId: null } as Turn)
const activity = atom({ plugin: 'track', key: 'activity' } as const, IDLE)

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// TRACK-27: a successful native call must actually address a tracked row.
export const stepReceiptIds = (tool: string, input: Record<string, unknown>, result: unknown, before: Ledger, after: Ledger): string[] => {
  const output = result as { task?: { id?: unknown }; success?: unknown; newTodos?: unknown } | undefined
  if (tool === MARK_STEP) {
    const row = after.steps.find(step => step.id === String(input.id))
    return row !== undefined && row.status === input.status && STEP_STATUSES.includes(input.status as Step['status']) ? [row.id] : []
  }
  if (tool === TRACK_STEPS) {
    if (typeof result !== 'string') return []
    if (/^Tracking \d+ steps:/.test(result)) return after.steps.filter(step => step.source === 'plan').map(step => step.id)
    // Only the inserted rows: a row the insert merely sits beside keeps its own turn's state.
    return result.startsWith('Inserted after ') ? after.steps.filter(step => step.source === 'plan' && !before.steps.some(old => old.id === step.id)).map(step => step.id) : []
  }
  if (tool === 'TaskCreate') return output?.task?.id !== undefined ? after.steps.filter(step => step.taskId === String(output.task!.id)).map(step => step.id) : []
  if (tool === 'TaskUpdate') return output?.success !== false && (input.status === 'deleted' || STEP_STATUSES.includes(input.status as Step['status'])) ? before.steps.filter(step => step.taskId === String(input.taskId)).map(step => step.id) : []
  if (tool === 'TodoWrite') return Array.isArray(output?.newTodos) ? distinctIds([...before.steps, ...after.steps].filter(step => step.source === 'todo').map(step => step.id)) : []
  return []
}

export async function recordWork($: EngineInterface, start: Turn, tool: string, callId: unknown, touched: string[], before: Ledger, after: Ledger, beforeActivity: Activity, token?: OwnerToken): Promise<boolean> {
  if (typeof start.currentId !== 'string' || start.currentId === '') return false
  const edit = EDIT_TOOLS.has(tool) && typeof callId === 'string' && callId !== ''
  const bash = tool === 'Bash' && typeof callId === 'string' && callId !== ''
  if (!edit && !bash && touched.length === 0) return false
  const completed = after.steps.filter(step => touched.includes(step.id) && step.status === 'completed' && before.steps.find(old => old.id === step.id)?.status !== 'completed')
    .map(step => {
      const previous = before.steps.find(old => old.id === step.id)
      return { id: step.id, owner_task_ids: ownerTasksForStep(beforeActivity, previous ?? step) }
    })
  await update($, turn, current => {
    assertOwner(token)
    if (current.currentId !== start.currentId) return current
    const fresh = current.freshness?.turnId === current.currentId ? current.freshness : freshTurn(start.currentId!)
    return { ...current, freshness: { ...fresh,
      edits: edit ? distinctIds([...fresh.edits, callId as string]) : fresh.edits,
      bash: bash ? distinctIds([...fresh.bash, callId as string]) : fresh.bash,
      steps: distinctIds([...fresh.steps, ...touched]),
      waiting: distinctIds([...fresh.waiting.filter(id => !touched.includes(id)), ...after.steps.filter(step => touched.includes(step.id) && step.status === 'waiting').map(step => step.id)]),
      completed: [...fresh.completed.filter(row => !touched.includes(row.id) || after.steps.find(step => step.id === row.id)?.status === 'completed' && !completed.some(next => next.id === row.id)), ...completed].slice(-MAX_STEPS),
    } }
  })
  return true
}

// TRACK-53: the pane moves a row only when the model calls mark_step, so work can run for minutes
// beside rows that all read pending. Once per turn, when this turn already updated a step and none
// is in_progress, the next main-agent tool result carries one reminder. The Stop and next-prompt
// nudges arrive too late for this. It never picks a step: tool activity does not say which one owns it.
export const ACTIVE_STEP_NUDGE = 'track: steps are pending and none is in_progress. Mark the step this work belongs to with mark_step.'
export async function dueActiveStepNudge($: EngineInterface, start: Turn, token: OwnerToken): Promise<boolean> {
  const steps = (await read($, ledger)).steps
  if (!steps.some(step => step.status === 'pending') || steps.some(step => step.status === 'in_progress')) return false
  let due = false
  await update($, turn, row => {
    assertOwner(token)
    due = false
    const fresh = row.freshness
    if (row.currentId !== start.currentId || fresh?.turnId !== row.currentId || fresh.steps.length === 0 || fresh.nudged.includes('active_step')) return row
    due = true
    return { ...row, freshness: { ...fresh, nudged: [...fresh.nudged, 'active_step'] } }
  })
  return due
}
export const FRESHNESS_KINDS: FreshnessKind[] = ['premature_completion', 'stale_in_progress', 'finished_delegation', 'missing_waiting_request', 'untracked_edit']
export const BASH_NUDGE = 'track: this turn ran Bash without a step update; reconcile a step when the command was work.'

// Shows a nudge once per turn and code; answers the turn it was shown for, or undefined when not shown.
export async function freshnessNudge($: EngineInterface, code: string, text: string, remind = false): Promise<{ turn: string | null } | undefined> {
  let show = false
  let nudgedTurn: string | null = null
  await update($, turn, current => {
    show = false // a compare-and-set retry decides again from the newer turn
    nudgedTurn = current.currentId
    if (typeof current.currentId !== 'string') {
      // No turn record to hold it: show each turnless nudge once per session.
      if (current.turnlessNudged?.includes(code)) return current
      show = true
      return { ...current, turnlessNudged: [...(current.turnlessNudged ?? []), code] }
    }
    const fresh = current.freshness?.turnId === current.currentId ? current.freshness : freshTurn(current.currentId)
    if (fresh.nudged.includes(code)) return current
    show = true
    return { ...current, ...(remind && { stepReminder: text }), freshness: { ...fresh, nudged: [...fresh.nudged, code] } }
  })
  if (!show) return undefined
  $.ui.toast(text)
  return { turn: nudgedTurn }
}
// Failure-intake D6: stop.nudge is fed at the six listed freshnessNudge callers only (identity, bash, claim),
// never inside freshnessNudge, so the facts:<kind> caller and any later caller feed nothing.
export function nudgeFed($: EngineInterface, code: string, shown: { turn: string | null } | undefined): void {
  if (shown !== undefined) noteEvent($, 'stop.nudge', { code }, shown.turn)
}

export const missingResultText = (steps: Step[], ids: string[]): string | undefined => {
  const missing = visibleSteps(steps).filter(step => ids.includes(step.id) && step.status === 'completed' && step.resultText === undefined)
  if (missing.length === 0) return undefined
  const named = missing.slice(0, OPEN_STEPS_LISTED).map(step => step.id).join(', ')
  return `track: missing completion result for ${named}${missing.length > OPEN_STEPS_LISTED ? ` (+${missing.length - OPEN_STEPS_LISTED} more)` : ''}. ${STEP_RESULT} This reminder does not block Stop.`
}

export async function nudgeMissingResults($: EngineInterface, observed: Turn): Promise<void> {
  if (observed.currentId === null || observed.freshness?.turnId !== observed.currentId) return
  const ids = observed.freshness.completed.map(row => row.id)
  const text = missingResultText((await read($, ledger)).steps, ids)
  if (text === undefined) return
  let show = false
  await update($, turn, current => {
    show = false
    if (current.currentId !== observed.currentId || current.resultNudgedTurnId === observed.currentId) return current
    show = true
    return { ...current, resultNudgedTurnId: observed.currentId!, resultReminder: { turnId: observed.currentId!, ids } }
  })
  if (show) $.ui.toast(text)
}

// The main turn that has finished and that no later turn.start has replaced yet.
export const finishedTurnId = (t: Turn, a: Activity): string | undefined =>
  typeof t.currentId === 'string' && !a.isWorking && a.mainTurnId === t.currentId ? t.currentId : undefined

// Phase 2 D1-D3 (R-S1, R-S5, 2026-10-26): classic.Stop may not run on this host. Each main typed,
// plugin or task-notification prompt between turn.complete and the next turn.start stores the
// finished turn's reminders as a Stop would, without the toast. Only a typed or plugin prompt
// shows the stored lines, once; a notification turn keeps them for the next one. A Stop that did
// run has already marked both, so nothing doubles.
export async function remindFinishedTurn($: EngineInterface, assertAdmitted: () => void): Promise<void> {
  const a = await read($, activity)
  const steps = (await read($, ledger)).steps
  await update($, turn, current => {
    assertAdmitted()
    const id = finishedTurnId(current, a)
    const fresh = current.freshness
    // A new turn.start replaces the turn first, so a stale activity read cannot match it.
    if (id === undefined || fresh?.turnId !== id) return current
    let next = current
    const ids = fresh.completed.map(row => row.id)
    if (current.resultNudgedTurnId !== id && missingResultText(steps, ids) !== undefined) {
      next = { ...next, resultNudgedTurnId: id, resultReminder: { turnId: id, ids } }
    }
    if (fresh.bash.length > 0 && fresh.edits.length === 0 && fresh.steps.length === 0 && !fresh.nudged.includes('bash')) {
      next = { ...next, stepReminder: BASH_NUDGE, freshness: { ...fresh, nudged: [...fresh.nudged, 'bash'] } }
    }
    return next
  })
}

export const INPUT_CLAIM_KIND = 'uncovered_input'
// stop-gate.py claim_name: sha256 of the compact JSON [session, turn, kind].
export const claimName = (session: string, turnId: string, kind: string): Promise<string> => sha256Hex(JSON.stringify([session, turnId, kind]))

// The helper's claim turn for a pending input; stop-gate.py builds the same string.
export const inputClaimTurn = (id: number, epoch: string | undefined): string => epoch === undefined ? `input:${id}` : `input:${epoch}:${id}`

// TRACK-46 unit 3: stop-gate.py's permanent input claim records a hold that classic.Stop may not have
// seen. Only this session's claim names are stat'ed; the directory is never listed and no contents are
// read. A link, a directory or any failure means "not held".
export async function claimedInputIds($: EngineInterface, session: string, inputs: readonly PendingInput[], epoch: string | undefined): Promise<Set<number>> {
  const claimed = new Set<number>()
  if (inputs.length === 0) return claimed
  let config: string | undefined
  try { config = await configDir($) } catch { return claimed }
  if (!config?.startsWith('/')) return claimed
  for (const input of inputs) {
    try {
      const name = await claimName(session, inputClaimTurn(input.id, input.legacy === true ? undefined : epoch), INPUT_CLAIM_KIND)
      const stat = await $.fs.stat(`${config}/state/track/stop-holds/inputs/${name}`)
      if (stat.kind === 'file' && stat.isLink !== true) claimed.add(input.id)
    } catch {
      // Missing or unreadable: not held here; the claim stays the command hook's to spend.
    }
  }
  return claimed
}

export const STOP_INVENTORY_OWNER = 'track-stop-inventory-v1'
export type StopInventory = { turnId: string; launchSeq: number; taskIds: Set<string> }

// The inventory counts only for the turn that just finished, in this session, written whole.
export async function readStopInventory($: EngineInterface, session: string): Promise<StopInventory | undefined> {
  const turnId = finishedTurnId(await read($, turn), await read($, activity))
  if (turnId === undefined) return undefined
  const config = await configDir($)
  if (!config?.startsWith('/')) return undefined
  let row: { owner?: unknown; session_id?: unknown; turn_id?: unknown; launch_seq?: unknown; task_ids?: unknown; complete?: unknown }
  try {
    row = JSON.parse(await $.fs.read(`${config}/state/track/stop-inventory/${await sha256Hex(session)}.json`) as string)
  } catch {
    return undefined // missing or unreadable: nothing is known, so nothing leaves the banner
  }
  if (row === null || typeof row !== 'object' || row.owner !== STOP_INVENTORY_OWNER || row.complete !== true) return undefined
  if (row.session_id !== session || row.turn_id !== turnId) return undefined
  const seq = row.launch_seq
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return undefined
  if (!Array.isArray(row.task_ids) || !row.task_ids.every(id => typeof id === 'string')) return undefined
  return { turnId, launchSeq: seq, taskIds: new Set(row.task_ids as string[]) }
}

// Ids absent from the inventory that were launched at or before its snapshot. A later launch,
// or an id with no launch number, may still run, so it stays.
export const inventoryDrops = (a: Activity, live: StopInventory): string[] => {
  const numbers = new Map((a.launchNumbers ?? []).map(row => [row.task, row.seq] as const))
  return [...a.background, ...(a.tasks ?? [])].filter(id => {
    const seq = numbers.get(id)
    return !live.taskIds.has(id) && seq !== undefined && seq <= live.launchSeq
  })
}

// Finished tasks leave the banner. Each step they owned keeps its status and gains a visible
// flag, plus one line for the model. `pick` reads the ids from the current activity.
export async function finishTasks($: EngineInterface, pick: (a: Activity) => string[], assertAdmitted: () => void, token?: OwnerToken): Promise<string | undefined> {
  let done: string[] = []
  let ownerIds: string[] = []
  await update($, activity, a => {
    assertAdmitted()
    done = pick(a)
    if (done.length === 0) return a
    const owners = a.owners ?? {}
    ownerIds = [...new Set(done.flatMap(id => owners[id] ?? []))]
    const nextOwners = { ...owners }
    for (const id of done) delete nextOwners[id]
    return { ...a, background: a.background.filter(id => !done.includes(id)), tasks: (a.tasks ?? []).filter(id => !done.includes(id)), ...(a.owners !== undefined && { owners: nextOwners }) }
  })
  if (done.length === 0) return undefined
  const targets = (await read($, ledger)).steps.filter(s => ownerIds.includes(s.id) && s.followUp !== true && canFollowUp(s))
  if (targets.length === 0) return undefined
  const wanted = new Set(targets.map(s => s.id))
  await updateLedger($, cur => {
    assertAdmitted()
    return { ...cur, steps: cur.steps.map(s => wanted.has(s.id) ? { ...s, followUp: true as const } : s) }
  })
  assertAdmitted()
  await saveLedger($, token)
  return `track: background work finished while ${targets.map(s => `${s.id} is still ${s.delegated === true ? 'delegated ' : ''}${s.status}`).join(', ')}; update it with mcp__track__mark_step.`
}

export async function prepareStopClaim($: EngineInterface) {
  const root = $.plugin.root
  const config = await configDir($)
  if (!root?.startsWith('/') || !config?.startsWith('/')) return undefined
  return async (payload: { session_id?: string }, snapshot: StopClaimSnapshot) => {
    const result = await $.process.run(['python3', `${root}/hooks/stop-gate.py`, '--claim'], {
      stdin: JSON.stringify({ ...payload, session_id: snapshot.session_id }), timeoutMs: 2000,
      env: { CLAUDE_CONFIG_DIR: config, TRACK_GATE_SNAPSHOT: JSON.stringify(snapshot) },
    })
    if (result.exitCode !== 0 || result.isStdoutTruncated === true || result.isStderrTruncated === true) throw new Error(`helper exit ${result.exitCode}`)
    return result
  }
}

export async function stepStop($: EngineInterface, payload: { session_id?: string; background_tasks?: readonly { id: string; type: string }[] }): Promise<string | undefined> {
  const snapshot = await publishGate($)
  if (snapshot === undefined || !snapshot.session_id || !snapshot.turn_id || (payload.session_id !== undefined && payload.session_id !== snapshot.session_id)) {
    nudgeFed($, 'identity', await freshnessNudge($, 'identity', 'track: Stop snapshot identity unavailable; reconcile steps before finishing.'))
    return undefined
  }
  const t = await read($, turn)
  const fresh = t.freshness?.turnId === snapshot.turn_id ? t.freshness : undefined
  if (fresh !== undefined && fresh.bash.length > 0 && fresh.edits.length === 0 && fresh.steps.length === 0) nudgeFed($, 'bash', await freshnessNudge($, 'bash', BASH_NUDGE, true))
  if (snapshot.candidates.length === 0) return undefined
  const claim = await prepareStopClaim($)
  if (claim === undefined) {
    nudgeFed($, 'claim', await freshnessNudge($, 'claim', 'track: shared hold claim configuration unavailable; reconcile steps before finishing.'))
    return undefined
  }
  for (const kind of FRESHNESS_KINDS) {
    const candidates = snapshot.candidates.filter(row => row.kind === kind)
    if (candidates.length === 0 || snapshot.held.includes(kind)) continue
    try {
      // An input hold belongs to the uncovered gate, never a freshness run.
      const { inputs: _inputs, inputs_complete: _complete, ...freshnessSnapshot } = snapshot
      const result = await claim(payload, { ...freshnessSnapshot, candidates })
      if (result.stderr.trim() !== '') {
        $.ui.log(result.stderr.trim(), { to: 'debug' })
        noteEvent($, 'stop.claim_stderr', { kind, bytes: new TextEncoder().encode(result.stderr.trim()).length }, snapshot.turn_id)
        await freshnessNudge($, `facts:${kind}`, result.stderr.trim())
      }
      const receipt = JSON.parse(result.stdout) as { decision?: unknown; reason?: unknown }
      if (receipt?.decision !== 'block' || typeof receipt.reason !== 'string' || receipt.reason.trim() === '') continue
      let currentTurn = false
      await update($, turn, current => {
        currentTurn = false
        if (current.currentId !== snapshot.turn_id) return current
        const fresh = current.freshness?.turnId === snapshot.turn_id ? current.freshness : freshTurn(snapshot.turn_id!)
        currentTurn = true
        return { ...current, freshness: { ...fresh, held: [...new Set([...fresh.held, kind])] } }
      })
      await publishGate($)
      if (currentTurn) noteEvent($, 'stop.block.module', { kind, held: [kind], candidates: candidates.length }, snapshot.turn_id)
      return currentTurn ? receipt.reason : undefined
    } catch (error) {
      nudgeFed($, 'claim', await freshnessNudge($, 'claim', `track: shared hold claim failed or denied (${reason(error)}); reconcile steps before finishing.`))
      return undefined
    }
  }
  return undefined
}

export async function claimUncoveredInputs($: EngineInterface, payload: { session_id?: string }, inputs: PendingInput[], currentId: string): Promise<{ held: boolean; block?: string }> {
  try {
    const snapshot = await publishGate($)
    const claim = await prepareStopClaim($)
    if (snapshot === undefined || snapshot.turn_id !== currentId || !snapshot.session_id ||
        (payload.session_id !== undefined && payload.session_id !== snapshot.session_id)) throw new Error('Stop snapshot identity unavailable')
    if (claim === undefined) throw new Error('shared hold claim configuration unavailable')
    const ids = new Set(inputs.map(i => i.id))
    const result = await claim(payload, { ...snapshot, candidates: [], inputs_complete: true, inputs: snapshot.inputs.filter(i => ids.has(i.id)) })
    const diagnostic = result.stderr.trim()
    if (diagnostic !== '') $.ui.log(diagnostic, { to: 'debug' })
    const receipt = JSON.parse(result.stdout) as { decision?: unknown; reason?: unknown } | null
    if (receipt?.decision === 'block') {
      if (typeof receipt.reason !== 'string' || receipt.reason.trim() === '') throw new Error('input claim repair text unavailable')
      return { held: true, block: receipt.reason }
    }
    if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt) || Object.keys(receipt).length !== 0) throw new Error('input claim receipt incompatible')
    // A quiet empty receipt means the command hook already spent this input's
    // claim. An unavailable fact preserves it for a later Stop.
    return { held: diagnostic === '' }
  } catch (error) {
    nudgeFed($, 'claim', await freshnessNudge($, 'claim', `track: shared hold claim failed or denied (${reason(error)}); reconcile steps before finishing.`))
    return { held: true, block: uncoveredBlock(inputs, ANSWER) }
  }
}
