import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginState, Hook, MatchedHook } from 'claude-code'
import type { Step, Turn } from '../types'
import { checkpointFailure } from './checkpoint'
import type { Checkpoint } from './checkpoint'
import { cancelReasonOf, cancelOwner } from './cancel-policy'
import { launchOwner, agentLaunchOwner, rememberOwner, rememberLaunch } from './task-ownership'
import { withStatus, STEP_STATUSES } from './ledger-policy'
import { headOf } from './ledger-text'
import { createTask, updateTask, replaceTodos } from './task-sync-commands'
import { TRACK_QUESTION, MARK_STEP, TRACK_STEPS, RESTORE_TRACKER, STEPS, EMPTY_LEDGER, IDLE, persistence, ownership, OwnerChanged, isOwnerCurrent, assertOwner, updateOwnedLedger } from './track-state'
import type { OwnerToken } from './track-state'
import { publishGate, saveLedger, savePendingCause } from './ledger-store'
import { captureMintOwner, ownerChangedResult, isFailedCheckpointResult, restoreOwnerChangedResult, ensureOwner } from './session-owner'
import { stepReceiptIds, recordWork, ACTIVE_STEP_NUDGE, dueActiveStepNudge } from './turn-guidance'
import { coverInput } from './prompt-flow'
import { dropFinishedOwners } from './track-tools'

// Atom copies: identical to their register.tsx declarations (tests/helpers/architecture.ts).
const ledger = atom({ plugin: 'track', key: 'ledger' } as const, EMPTY_LEDGER)
const turn = atom({ plugin: 'track', key: 'turn' } as const, { currentId: null, gatedTurnId: null } as Turn)
const activity = atom({ plugin: 'track', key: 'activity' } as const, IDLE)
const durability = atom({ plugin: 'track', key: 'durability' } as const, { isUnsaved: false, reason: '' } as PluginState['track']['durability'])

export async function applyCancel($: EngineInterface, owners: string[], ran: { result?: unknown; deny?: unknown; text?: unknown; isError?: boolean }, token?: OwnerToken): Promise<void> {
  const reasonNote = cancelReasonOf(ran)
  if (reasonNote === undefined || owners.length === 0) return
  const currentId = (await read($, turn)).currentId
  const now = await $.clock.now()
  const owned = new Set(owners)
  let changed = false
  await updateOwnedLedger($, token, cur => {
    changed = false
    const steps = cur.steps.map(s => {
      if (!owned.has(s.id) || s.cleared === true || s.status !== 'in_progress' || s.activeTurnId !== currentId) return s
      changed = true
      return { ...withStatus(s, 'paused', now), note: reasonNote }
    })
    return changed ? { ...cur, steps } : cur
  })
  if (!changed) return
  await saveLedger($, token)
  await dropFinishedOwners($, token)
}

// 'tool.call': the registration stays in register.tsx.
type OwnedToolCallHook = Hook<'tool.call'>
export async function ownedToolCall($: Parameters<OwnedToolCallHook>[0], e: Parameters<OwnedToolCallHook>[1], next: Parameters<OwnedToolCallHook>[2], reuseCalls: Map<string, { step?: Step }>, ownedCalls: Map<string, OwnerToken>, mutationTools: Set<string>, ownedTools: Set<string>): Promise<Awaited<ReturnType<OwnedToolCallHook>>> {
  if (e.agentId !== undefined) return next(e)
  let token: OwnerToken = { owner: undefined, epoch: ownership.epoch }
  if (ownedTools.has(e.tool)) {
    const owned = await ensureOwner($)
    if (!owned.ok && !owned.isIdentity) {
      const text = `track: ${owned.reason}`
      return e.tool === RESTORE_TRACKER && e.expected_checkpoint !== undefined
        ? { result: JSON.stringify(checkpointFailure(String(e.from_session ?? ''), text, owned.destination)) }
        : { deny: text }
    }
    if (owned.ok) token = owned.token
  }
  const current = await read($, turn)
  const beforeLedger = await read($, ledger)
  const beforeActivity = await read($, activity)
  if (token.owner === undefined) token = { ...token, owner: beforeLedger.session_id ?? (await read($, durability)).memorySession ?? undefined }
  // Keep outage rows provisional, but never acquire a different owner after native execution.
  if ([TRACK_QUESTION, TRACK_STEPS, 'TaskCreate', 'TodoWrite'].includes(e.tool) && token.owner === undefined) await captureMintOwner($)
  let completed: Awaited<ReturnType<typeof next>> | undefined
  ownedCalls.set(e.tool_use_id, token)
  try {
  if (ownedTools.has(e.tool)) assertOwner(token, beforeLedger)
  const owner = cancelOwner(beforeLedger.steps, e.tool, current.currentId)
  const owners = owner === undefined ? [] : [owner]
  if (!mutationTools.has(e.tool)) {
    const ran = await next(e)
    completed = ran
    if (!isOwnerCurrent(token)) return ran
    await applyCancel($, owners, ran, token)
    if (ran.deny === undefined && ran.isError !== true) {
      if (await recordWork($, current, e.tool, e.tool_use_id, [], beforeLedger, await read($, ledger), beforeActivity, token)) await publishGate($, token)
      if (await dueActiveStepNudge($, current, token)) return { ...ran, context: [...(ran.context ?? []), ACTIVE_STEP_NUDGE] }
    }
    return ran
  }
  const before = JSON.stringify(beforeLedger)
  // TRACK-8, 2026-10-19: Stop repair replaced an active plan because marking its
  // existing step could not register the request. Only an explicit source opts
  // into reuse; repeating an old completed row is not new work.
  const reuse: { step?: Step } | undefined = e.tool === MARK_STEP && STEP_STATUSES.some(status => status === e.status) &&
    (typeof e.source_text === 'string' || typeof e.source_request_id === 'string')
    ? {} : undefined
  const reuseSession = reuse === undefined ? undefined : await $.session.id()
  if (reuse !== undefined) reuseCalls.set(e.tool_use_id, reuse)
  const ran = await next(e).finally(() => {
    if (reuse !== undefined && reuseCalls.get(e.tool_use_id) === reuse) reuseCalls.delete(e.tool_use_id)
  })
  completed = ran
  if (!isOwnerCurrent(token)) {
    if (e.tool === RESTORE_TRACKER && e.expected_checkpoint !== undefined) {
      return isFailedCheckpointResult(ran.result) ? ran : restoreOwnerChangedResult(String(e.from_session ?? ''), token.owner, ran)
    }
    return ran.deny !== undefined || ran.isError === true || (ran.result as { success?: unknown } | undefined)?.success === false ? ran : ownerChangedResult(e.tool, ran)
  }
  const reusedStep = reuse?.step
  await applyCancel($, owners, ran, token)
  if (ran.deny !== undefined || ran.isError === true) return ran
  const afterLedger = await read($, ledger)
  const touched = stepReceiptIds(e.tool, e, ran.result, beforeLedger, afterLedger)
  const recorded = await recordWork($, current, e.tool, e.tool_use_id, touched, beforeLedger, afterLedger, beforeActivity, token)
  if (before === JSON.stringify(afterLedger) && reusedStep === undefined) {
    if (recorded) await publishGate($, token)
    return ran
  }
  if (e.tool === RESTORE_TRACKER && e.expected_checkpoint !== undefined && typeof ran.result === 'string' && (JSON.parse(ran.result) as Checkpoint).ok !== true) return ran
  await publishGate($, token)
  assertOwner(token)
  if (await saveLedger($, token)) {
    if (e.tool === MARK_STEP && typeof ran.result === 'string') {
      // TRACK-23: copy the acknowledged row, not the caller's proposed note
      // or an atom that may already contain a later, unsaved edit.
      const saved = (await read($, durability)).baseline
      const row = saved?.session_id === await $.session.id()
        ? saved.ledger.steps.find(step => step.id === String(e.id)) : undefined
      if (row !== undefined) {
        // Coverage follows the same durable acknowledgement as this receipt,
        // including an unchanged status. A reconciled replacement cannot cover
        // on behalf of the row the caller meant to reuse.
        if (reusedStep !== undefined && saved?.session_id === reuseSession && row.cleared !== true && row.status === e.status &&
            row.source === reusedStep.source && row.sourceId === reusedStep.sourceId && row.subject === reusedStep.subject &&
            row.taskId === reusedStep.taskId && row.createdRequestId === reusedStep.createdRequestId) {
          await coverInput($, 'steps', { source_text: e.source_text, source_request_id: e.source_request_id }, token)
        }
        const { id, subject, status, note } = row
        return { ...ran, result: `${ran.result}\nSaved row: ${JSON.stringify({ id, subject, status, ...(note !== undefined && { note }) })}` }
      }
    }
    return ran
  }
  const pendingCause = savePendingCause()
  const warning = pendingCause === undefined ? `track: unsaved — ${persistence.failure}` : `track: save outcome pending — ${pendingCause}`
  if (e.tool === RESTORE_TRACKER && e.expected_checkpoint !== undefined && typeof ran.result === 'string') {
    const receipt = JSON.parse(ran.result) as Checkpoint
    return { ...ran, result: JSON.stringify({ ...receipt, ok: false, reason: warning }), context: [...(ran.context ?? []), warning] }
  }
  return { ...ran, ...(typeof ran.result === 'string' && { result: `${ran.result}\n${warning}` }), context: [...(ran.context ?? []), warning] }
  } catch (error) {
    if (!(error instanceof OwnerChanged)) throw error
    if (e.tool === RESTORE_TRACKER && e.expected_checkpoint !== undefined) {
      if (completed !== undefined && isFailedCheckpointResult(completed.result)) return completed
      return restoreOwnerChangedResult(String(e.from_session ?? ''), token.owner, completed)
    }
    return ownerChangedResult(e.tool, completed)
  } finally {
    if (ownedCalls.get(e.tool_use_id) === token) ownedCalls.delete(e.tool_use_id)
  }
}

// 'tool.call' { tool: 'TaskCreate' }: the registration stays in register.tsx.
type TaskCreateCallHook = MatchedHook<'tool.call', { tool: 'TaskCreate' }>
export async function taskCreateCall($: Parameters<TaskCreateCallHook>[0], e: Parameters<TaskCreateCallHook>[1], next: Parameters<TaskCreateCallHook>[2], ownedCalls: Map<string, OwnerToken>): Promise<Awaited<ReturnType<TaskCreateCallHook>>> {
  const token = ownedCalls.get(e.tool_use_id)
  const ran = await next(e)
  const task = (ran.result as { task?: { id?: unknown } } | undefined)?.task
  if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true || task?.id === undefined) {
    return ran
  }
  try {
  const taskId = String(task.id)
  const subject = headOf(String(e.subject ?? ''))
  const session = token?.owner
  await updateOwnedLedger($, token, cur => createTask(cur, { taskId, subject, toolUseId: e.tool_use_id, session }))

  return ran
  } catch (error) {
    if (!(error instanceof OwnerChanged)) throw error
    return ownerChangedResult(e.tool, ran)
  }
}

// 'tool.call' { tool: 'TaskUpdate' }: the registration stays in register.tsx.
type TaskUpdateCallHook = MatchedHook<'tool.call', { tool: 'TaskUpdate' }>
export async function taskUpdateCall($: Parameters<TaskUpdateCallHook>[0], e: Parameters<TaskUpdateCallHook>[1], next: Parameters<TaskUpdateCallHook>[2], ownedCalls: Map<string, OwnerToken>): Promise<Awaited<ReturnType<TaskUpdateCallHook>>> {
  const token = ownedCalls.get(e.tool_use_id)
  const currentId = e.agentId === undefined ? (await read($, turn)).currentId : null
  const ran = await next(e)
  const status = e.status
  const failed = (ran.result as { success?: unknown } | undefined)?.success === false
  if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true || failed || status === undefined) {
    return ran
  }
  try {
  const taskId = String(e.taskId)
  const now = await $.clock.now()
  await updateOwnedLedger($, token, cur => updateTask(cur, { taskId, status, now, currentId }))
  await dropFinishedOwners($, token)

  return ran
  } catch (error) {
    if (!(error instanceof OwnerChanged)) throw error
    return ownerChangedResult(e.tool, ran)
  }
}

// 'tool.call' { tool: 'TodoWrite' }: the registration stays in register.tsx.
type TodoWriteCallHook = MatchedHook<'tool.call', { tool: 'TodoWrite' }>
export async function todoWriteCall($: Parameters<TodoWriteCallHook>[0], e: Parameters<TodoWriteCallHook>[1], next: Parameters<TodoWriteCallHook>[2], ownedCalls: Map<string, OwnerToken>): Promise<Awaited<ReturnType<TodoWriteCallHook>>> {
  const token = ownedCalls.get(e.tool_use_id)
  const currentId = e.agentId === undefined ? (await read($, turn)).currentId : null
  const ran = await next(e)
  const todos = (ran.result as { newTodos?: Array<{ content: string; status: Step['status'] }> } | undefined)?.newTodos
  if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true || todos === undefined) {
    return ran
  }
  try {
  // Two todos whose titles normalize alike get #2, #3 after the id, so mark_step reaches each.
  // A todo written again keeps its clock.
  const session = token?.owner
  const now = await $.clock.now()
  await updateOwnedLedger($, token, cur => replaceTodos(cur, { todos, now, currentId, session }))
  await dropFinishedOwners($, token)

  return ran
  } catch (error) {
    if (!(error instanceof OwnerChanged)) throw error
    return ownerChangedResult(e.tool, ran)
  }
}

// 'tool.call' { tool: 'ExitPlanMode' }: the registration stays in register.tsx.
type ExitPlanModeCallHook = MatchedHook<'tool.call', { tool: 'ExitPlanMode' }>
export async function exitPlanModeCall($: Parameters<ExitPlanModeCallHook>[0], e: Parameters<ExitPlanModeCallHook>[1], next: Parameters<ExitPlanModeCallHook>[2]): Promise<Awaited<ReturnType<ExitPlanModeCallHook>>> {
  const ran = await next(e)
  const result = ran.result as { plan?: unknown; isAgent?: unknown } | undefined
  if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true || typeof result?.plan !== 'string' || result.isAgent === true) {
    return ran
  }
  return { ...ran, context: [...(ran.context ?? []), `track: the plan was approved. Reuse the existing open steps; register meaningful missing work with mcp__track__track_steps. ${STEPS}`] }
}

// 'tool.call' { tool: 'Agent' }: the registration stays in register.tsx.
type AgentCallHook = MatchedHook<'tool.call', { tool: 'Agent' }>
export async function agentCall($: Parameters<AgentCallHook>[0], e: Parameters<AgentCallHook>[1], next: Parameters<AgentCallHook>[2], ownedCalls: Map<string, OwnerToken>): Promise<Awaited<ReturnType<AgentCallHook>>> {
  if (e.agentId !== undefined) {
    return next(e)
  }
  const callId = e.tool_use_id
  const token = ownedCalls.get(callId)
  await update($, activity, a => ({ ...a, agentCalls: [...a.agentCalls, callId] }))
  try {
    const ran = await next(e)
    const launched = ran.result as { status?: unknown; agentId?: unknown } | undefined
    // TRACK-46 A1/C1: a launch that returns after another session was selected belongs to the
    // old owner, so it never enters the new owner's activity (as for Bash).
    if (launched?.status === 'async_launched' && typeof launched.agentId === 'string' && (token === undefined || isOwnerCurrent(token))) {
      const agentId = launched.agentId
      const steps = (await read($, ledger)).steps
      const ids = agentLaunchOwner(steps, (await read($, turn)).currentId)
      await update($, activity, a => {
        assertOwner(token)
        return { ...a, background: [...a.background.filter(id => id !== agentId), agentId], ...rememberOwner(a, agentId, ids, steps), ...rememberLaunch(a, agentId) }
      })
    }

    return ran
  } finally {
    await update($, activity, a => ({ ...a, agentCalls: a.agentCalls.filter(id => id !== callId) }))
  }
}

// 'tool.call' { tool: 'AskUserQuestion' }: the registration stays in register.tsx.
type AskUserQuestionCallHook = MatchedHook<'tool.call', { tool: 'AskUserQuestion' }>
export async function askUserQuestionCall($: Parameters<AskUserQuestionCallHook>[0], e: Parameters<AskUserQuestionCallHook>[1], next: Parameters<AskUserQuestionCallHook>[2]): Promise<Awaited<ReturnType<AskUserQuestionCallHook>>> {
  if (e.agentId !== undefined) {
    return next(e)
  }
  const callId = e.tool_use_id
  await update($, activity, a => ({ ...a, askCalls: [...a.askCalls, callId] }))
  try {
    return await next(e)
  } finally {
    await update($, activity, a => ({ ...a, askCalls: a.askCalls.filter(id => id !== callId) }))
  }
}

// 'tool.call' { tool: 'Bash' }: the registration stays in register.tsx.
type BashCallHook = MatchedHook<'tool.call', { tool: 'Bash' }>
export async function bashCall($: Parameters<BashCallHook>[0], e: Parameters<BashCallHook>[1], next: Parameters<BashCallHook>[2], ownedCalls: Map<string, OwnerToken>): Promise<Awaited<ReturnType<BashCallHook>>> {
  const token = ownedCalls.get(e.tool_use_id)
  const ran = await next(e)
  const taskId = (ran.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId
  if (e.agentId === undefined && typeof taskId === 'string' && (token === undefined || isOwnerCurrent(token))) {
    const steps = (await read($, ledger)).steps
    const ids = launchOwner(steps, (await read($, turn)).currentId)
    await update($, activity, a => {
      assertOwner(token)
      return { ...a, tasks: [...(a.tasks ?? []).filter(id => id !== taskId), taskId], ...rememberOwner(a, taskId, ids, steps), ...rememberLaunch(a, taskId) }
    })
  }

  return ran
}
