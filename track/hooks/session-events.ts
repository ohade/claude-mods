import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginState, Hook, MatchedHook } from 'claude-code'
import type { Pane, Pending, PendingInput, Question, Step, Turn } from '../types'
import { checksumOf } from './checkpoint'
import { deploymentDriftMessage } from './deploy-drift'
import { MAX_INPUTS, admitInput } from './prompt-intake'
import { unregisteredContext, promptContext, remainingNotices } from './prompt-context'
import { gateable, looksLikeQuestion, needsQuestion } from './turn-policy'
import { MAX_STEPS, withStatus, STEP_STATUSES } from './ledger-policy'
import { headOf } from './ledger-text'
import { toolContracts } from './tool-contracts'
import { PANE, STEP_RESULT, STEPS, ANSWER, RULE, AGENT_TASK, EMPTY_LEDGER, IDLE, textOf, reason, writer, noteEvent, freshTurn, ownership, OwnerChanged, isOwnerCurrent, assertOwner, updateLedger } from './track-state'
import type { OwnerToken } from './track-state'
import { closeLock } from './writer-lock'
import { publishGate, saveLedger, saveFailureText } from './ledger-store'
import { renderInstances, renderSaved, memoryToken, switchOwner, ensureOwner } from './session-owner'
import { freshnessNudge, nudgeFed, missingResultText, nudgeMissingResults, remindFinishedTurn, readStopInventory, inventoryDrops, finishTasks, stepStop, claimUncoveredInputs } from './turn-guidance'
import { recordTranscriptBaseline, dropRewound, observeResponse, captureResponse, recordPrompt, classifying, labelScheduled, classifierOn, classifyInput, forgetTranscriptBaseline } from './prompt-flow'
import { STEPS_LINE, MIDTURN_FRAME, light } from './pane-actions'
import { dropFinishedOwners } from './track-tools'

// Atom copies: identical to their register.tsx declarations (tests/helpers/architecture.ts).
const ledger = atom({ plugin: 'track', key: 'ledger' } as const, EMPTY_LEDGER)
const turn = atom({ plugin: 'track', key: 'turn' } as const, { currentId: null, gatedTurnId: null } as Turn)
const pane = atom({ plugin: 'track', key: 'pane' } as const, { isOpen: false, hidden: false, closedByPerson: false } as Pane)
const pending = atom({ plugin: 'track', key: 'pending' } as const, { inputs: [], nextId: 1 } as Pending)
const lit = atom({ plugin: 'track', key: 'lit' } as const, [] as string[])
const renders = atom({ plugin: 'track', key: 'renders' } as const, { session: null, rows: [] } as { session: string | null; rows: [string, string][] })
const activity = atom({ plugin: 'track', key: 'activity' } as const, IDLE)
const durability = atom({ plugin: 'track', key: 'durability' } as const, { isUnsaved: false, reason: '' } as PluginState['track']['durability'])


// A background task's id in its notification text.
export const TASK_ID = /<task-id>([^<]+)<\/task-id>/g
// CC-179, 2026-10-10: a rejected or unrelated Track call counted as tracking a question, one
// excerpt was kept and every later prompt overwrote it. Each question-like main prompt is now a
// pending input until an accepted row covers it: a question created or reused for it, or new steps.
// The pending atom, not the turn atom: a turn-atom write retries forever against a test that pins
// the turn version. $.state survives a mod reload; module memory did not.
// Round 2 (Codex's review of 12e11c8): an unresolved input stays until a row covers it, across
// turns; it is held once, then named on each later prompt. At the cap a covered input leaves
// first, then one Haiku called not_question; with none, the new prompt is not recorded, with a
// toast. Never an unresolved one.
// How long Stop waits for a Haiku label already in flight.
export const STOP_JOIN_MS = 2000

// Whether the drift status shows: while it does, each main turn's end checks
// again, so a land clears it; with none, a session checks at start alone.
export const deployDrift = { isShown: false }

// CC-159, 2026-10-10: tested main changes repeatedly remained absent from live.
// Engine calls must stay in this file for the native capability scanner.
export async function checkDeployDrift($: EngineInterface): Promise<void> {
  const deadline = Date.now() + 2000
  let isShowing = false
  try {
    const home = await $.env.get('HOME')
    if (!home?.startsWith('/')) return
    const repo = `${home}/git/claude-mods`
    const live = `${home}/git/worktrees/claude-mods/live`
    const git = (path: string, args: string[]) => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('drift check deadline reached')
      return $.process.run(['git', '-C', path, ...args], { timeoutMs: remaining, cwd: repo })
    }
    const [main, deployed, receiptText] = await Promise.all([
      git(repo, ['rev-parse', '--verify', 'refs/heads/main']),
      git(live, ['rev-parse', '--verify', 'HEAD']),
      $.fs.read(`${home}/.claude/state/claude-mods-live.json`),
    ])
    if (main.exitCode !== 0 || deployed.exitCode !== 0) return
    const mainHead = main.stdout.trim()
    const liveHead = deployed.stdout.trim()
    const message = deploymentDriftMessage(mainHead, liveHead, receiptText)
    if (message === undefined) return
    const ancestry = await git(repo, ['merge-base', '--is-ancestor', liveHead, mainHead])
    if (ancestry.exitCode !== 0 || Date.now() > deadline) return
    $.ui.status(message)
    isShowing = true
  } catch {
    // Advisory only: missing receipts, refused I/O and Git errors stay silent.
    // Never turn an unknown deployment state into a false drift warning.
  } finally {
    // Any check that shows no drift takes down a status shown before.
    if (!isShowing && deployDrift.isShown) $.ui.status(undefined)
    deployDrift.isShown = isShowing
  }
}

// 'session.start': the registration stays in register.tsx.
type SessionStartEventHook = Hook<'session.start'>
export async function sessionStartEvent($: Parameters<SessionStartEventHook>[0], e: Parameters<SessionStartEventHook>[1], next: Parameters<SessionStartEventHook>[2]): Promise<Awaited<ReturnType<SessionStartEventHook>>> {
  // A reload keeps the status the last load set, so the first check clears it.
  deployDrift.isShown = true
  $.clock.after(0, () => checkDeployDrift($))
  renderInstances.clear()
  renderSaved.session = undefined
  // Like /btw: typed while a turn runs, /track acts at once instead of waiting for the turn to
  // end, and the toggle answers with no text, so the session gets no row.
  await $.command.register({
    name: 'track',
    description: 'Show or hide the track pane: questions asked, where answered, and the steps',
    argumentHint: '[order | reorder <JSON step-id array> | status | classifier [on|off] | export <absolute-path> | import <absolute-path>]',
    immediate: true,
  })
  const catalog = toolContracts(STEPS, STEP_RESULT, STEP_STATUSES, MAX_STEPS)
  await $.tool.register(catalog.track_question)
  await $.tool.register(catalog.mark_answered)
  await $.tool.register(catalog.track_steps)
  await $.tool.register(catalog.restore_tracker)
  await $.tool.register(catalog.checkpoint)
  await $.tool.register(catalog.lookup_rows)
  await $.tool.register(catalog.diagnose)
  await $.tool.register(catalog.reorder_steps)
  await $.tool.register(catalog.mark_step)

  try {
    const saved = await read($, renders)
    renderSaved.session = await $.session.id()
    if (saved.session === renderSaved.session) {
      for (const [key, id] of saved.rows) if (!renderInstances.has(key)) renderInstances.set(key, id)
    }
  } catch (error) {
    $.ui.log(`track: render instances not restored: ${reason(error)}`, { to: 'debug' })
  }

  try {
    const id = await $.session.id()
    await switchOwner($, id)
  } catch (error) {
    $.ui.log(`track: resume failed: ${reason(error)}`, { to: 'debug' })
  }

  // Housekeeping runs after the registrations, so a refused call here never costs the session
  // /track or the tools.
  try {
    // session.start runs again on a reload, an enable or a worker respawn, while the pane stays
    // up (closing it here made the pane open by itself, then close). Only a pane asked for by
    // code below 144 columns, which waits unseen, is dropped.
    const mine = (await $.ui.panes()).find(p => p.id === PANE)
    if (mine !== undefined && !mine.isPlaced) {
      await $.ui.close({ id: PANE })
    } else if (mine !== undefined) {
      await update($, pane, p => ({ ...p, isOpen: true }))
    }
    const stale = await read($, lit)
    if (stale.length > 0) {
      await Promise.all(stale.map(id => light($, id, 0)))
      await update($, lit, () => [])
    }
  } catch (error) {
    $.ui.log(`track: session.start housekeeping failed: ${reason(error)}`, { to: 'debug' })
  }

  return next(e)
}

// 'session.append' { door: 'prompt' }: the registration stays in register.tsx.
type PromptAppendEventHook = MatchedHook<'session.append', { door: 'prompt' }>
export async function promptAppendEvent($: Parameters<PromptAppendEventHook>[0], e: Parameters<PromptAppendEventHook>[1], next: Parameters<PromptAppendEventHook>[2]): Promise<Awaited<ReturnType<PromptAppendEventHook>>> {
  await recordPrompt($, e, textOf(e.message.content))

  return next(e)
}

// 'session.append' { door: 'delivery' }: the registration stays in register.tsx.
type DeliveryAppendEventHook = MatchedHook<'session.append', { door: 'delivery' }>
export async function deliveryAppendEvent($: Parameters<DeliveryAppendEventHook>[0], e: Parameters<DeliveryAppendEventHook>[1], next: Parameters<DeliveryAppendEventHook>[2]): Promise<Awaited<ReturnType<DeliveryAppendEventHook>>> {
  if (e.message.name === 'queued_command') {
    await recordPrompt($, e, textOf(e.message.content).replace(MIDTURN_FRAME, ''))
  }

  return next(e)
}

// 'session.append' { door: 'response' }: the registration stays in register.tsx.
type ResponseAppendEventHook = MatchedHook<'session.append', { door: 'response' }>
export async function responseAppendEvent($: Parameters<ResponseAppendEventHook>[0], e: Parameters<ResponseAppendEventHook>[1], next: Parameters<ResponseAppendEventHook>[2]): Promise<Awaited<ReturnType<ResponseAppendEventHook>>> {
  const epoch = ownership.epoch
  const text = textOf(e.message.content).trim()
  if (e.agentId === undefined && text !== '') {
    try { await observeResponse($, e.uuid, text, await memoryToken($, epoch)) }
    catch (error) {
      if (!(error instanceof OwnerChanged)) throw error
      $.ui.log('track: reply observation stopped: session owner changed during the reply.', { to: 'debug' })
    }
  }

  return next(e)
}

// 'session.append' { door: 'response' } #1: the registration stays in register.tsx.
type ResponseTurnAppendEventHook = MatchedHook<'session.append', { door: 'response' }>
export async function responseTurnAppendEvent($: Parameters<ResponseTurnAppendEventHook>[0], e: Parameters<ResponseTurnAppendEventHook>[1], next: Parameters<ResponseTurnAppendEventHook>[2]): Promise<Awaited<ReturnType<ResponseTurnAppendEventHook>>> {
  const epoch = ownership.epoch
  const observed = (await read($, turn)).lastText
  const stored = await next(e)
  if (stored.deny !== undefined || e.agentId !== undefined || e.origin.kind !== 'model' || stored.message.type !== 'assistant' || observed?.requestId !== e.uuid || observed.turnId === null || observed.order === undefined) return stored
  try { await captureResponse($, textOf(stored.message.content), stored.uuid, { turnId: observed.turnId, order: observed.order }, await memoryToken($, epoch)) }
  catch (error) {
    if (!(error instanceof OwnerChanged)) throw error
    $.ui.log('track: answer capture stopped: session owner changed during the reply.', { to: 'debug' })
  }
  return stored
}

// 'turn.start': the registration stays in register.tsx.
type TurnStartEventHook = Hook<'turn.start'>
export async function turnStartEvent($: Parameters<TurnStartEventHook>[0], e: Parameters<TurnStartEventHook>[1], next: Parameters<TurnStartEventHook>[2]): Promise<Awaited<ReturnType<TurnStartEventHook>>> {
  // A subagent's loop starts turns too (agentId set). Everything below is the main turn's:
  // its current id, freshness record, input and row binding, and activity. A subagent's start
  // touches none of it, or the main turn's Stop would judge an emptied record.
  if (e.agentId !== undefined) return next(e)
  // prompt.submit may already have stored this turn's inputs, unbound: they are this turn's.
  // A covered input of an earlier turn is done and leaves, and so is one Haiku called
  // not_question; an unresolved one stays. Steps coverage waits for a label still to come: a late
  // question label undoes it.
  await update($, turn, t => ({ ...t, currentId: e.turnId, freshness: typeof e.turnId === 'string' ? freshTurn(e.turnId) : undefined } as Turn))
  if (typeof e.turnId === 'string') {
    await update($, pending, p => (p.inputs.length === 0 ? p : {
      ...p,
      inputs: p.inputs.filter(i => i.turnId === null || i.turnId === e.turnId || (i.covered === undefined ? i.label !== 'not_question' : i.covered === 'steps' && i.label === undefined)).map(i => (i.turnId === null ? { ...i, turnId: e.turnId } : i)),
    }))
  }
  await update($, activity, a => ({ ...a, isWorking: true, mainTurnId: e.turnId }))
  await updateLedger($, l => ({
    ...l,
    prompts: l.prompts.map(p => (p.turnId === null ? { ...p, turnId: e.turnId } : p)),
    questions: l.questions.map(q => (q.turnId === null ? { ...q, turnId: e.turnId } : q)),
  }))
  await publishGate($)

  return next(e)
}

// 'prompt.compose': the registration stays in register.tsx.
type PromptComposeEventHook = Hook<'prompt.compose'>
export async function promptComposeEvent($: Parameters<PromptComposeEventHook>[0], e: Parameters<PromptComposeEventHook>[1], next: Parameters<PromptComposeEventHook>[2]): Promise<Awaited<ReturnType<PromptComposeEventHook>>> {
  const composed = await next(e)
  // The rule reaches the model this session, so prompts need not carry the steps line.
  if ((await read($, turn)).composedRule !== RULE) {
    await update($, turn, t => ({ ...t, composedRule: RULE }))
  }

  return { sections: [...composed.sections, { id: 'track:rule', text: RULE, scope: 'session' as const }] }
}

// 'prompt.submit': the registration stays in register.tsx.
type PromptSubmitEventHook = Hook<'prompt.submit'>
export async function promptSubmitEvent($: Parameters<PromptSubmitEventHook>[0], e: Parameters<PromptSubmitEventHook>[1], next: Parameters<PromptSubmitEventHook>[2]): Promise<Awaited<ReturnType<PromptSubmitEventHook>>> {
  // The pending write runs after several awaits, so it checks the admitted owner inside its atom.
  const admissionEpoch = ownership.epoch
  let token: OwnerToken | undefined
  let provisional = false
  if ((e as { agentId?: string }).agentId === undefined) {
    const owned = await ensureOwner($)
    if (!owned.ok && !owned.isIdentity) {
      // Keep the prompt available when Track cannot select its session's rows.
      return next({ ...e, context: [...(e.context ?? []), `track: ${owned.reason}; Track did not record this prompt.`] })
    }
    token = owned.ok ? owned.token : undefined
    provisional = !owned.ok
  }
  // Every write after an await checks the admitted owner, inside its atom where there is one.
  const assertAdmitted = (): void => {
    assertOwner(token)
    if (provisional && !isOwnerCurrent({ owner: undefined, epoch: admissionEpoch })) throw new OwnerChanged()
  }
  const passThrough = () => {
    // Another session owns the rows now: pass the prompt through and leave its state alone.
    $.ui.log('track: prompt input not recorded: session owner changed during the call.', { to: 'debug' })
    return next({ ...e, context: [...(e.context ?? []), 'track: session owner changed during the call; Track did not record this prompt.'] })
  }
  const trimmed = (e as { agentId?: string }).agentId === undefined ? gateable(String(e.text ?? ''), e.origin?.kind) : undefined
  const wording = trimmed !== undefined && looksLikeQuestion(trimmed)
  const classify = trimmed !== undefined && (await classifierOn($))
  let added: number | undefined
  if (trimmed !== undefined && (wording || classify)) {
    const excerpt = trimmed.slice(0, 80)
    const head = headOf(String(e.text))
    const turnId = typeof e.turnId === 'string' ? e.turnId : null
    const textHash = await checksumOf(String(e.text))
    // The prompt row may already be recorded: the newest with these words, not yet taken.
    const prompts = (await read($, ledger)).prompts
    let full = false
    try {
      await update($, pending, p => {
        assertAdmitted()
        added = undefined
        full = false
        const admission = admitInput(p, { head, excerpt, textHash, turnId, wording, prompts, labelling: new Set([...classifying.keys(), ...labelScheduled]), needsRow: needsQuestion })
        added = admission.added
        full = admission.full
        // Permanent helper claims are named per epoch, so a restarted runtime's input 1 is new.
        // Inputs already queued when the epoch is minted (a hot reload from an older version)
        // keep their legacy claim names, so a held one is never held again.
        if (admission.added === undefined) return admission.next
        if (p.epoch !== undefined) return { ...admission.next, epoch: p.epoch }
        const fresh = admission.added
        return { ...admission.next, inputs: admission.next.inputs.map(i => i.id === fresh ? i : { ...i, legacy: true as const }), epoch: crypto.randomUUID() }
      })
    } catch (error) {
      if (!(error instanceof OwnerChanged)) throw error
      return passThrough()
    }
    if (full) $.ui.toast(`track: ${MAX_INPUTS} prompts still wait for a Track row; this one was not recorded.`)
    // Started, not awaited: the label is read at Stop. A managed timer stops on a reload.
    if (added !== undefined && classify) {
      const id = added
      const text = String(e.text)
      const epoch = ownership.epoch
      labelScheduled.add(id)
      $.clock.after(0, () => {
        labelScheduled.delete(id)
        const run = classifyInput($, id, text, epoch).finally(() => classifying.delete(id))
        classifying.set(id, run)
        return run
      })
    }
  }
  const entered = await (async () => {
    assertAdmitted()
    // A finished background task or agent says so in its notification: it leaves the banner.
    // Its step stays as it is and gains a visible flag, plus one nudge to update it.
    let followUpLine: string | undefined
    if (e.origin?.kind === 'task-notification') {
      const done = [...e.text.matchAll(new RegExp(TASK_ID.source, 'g'))].map(m => m[1] ?? '')
      if (done.length > 0) followUpLine = await finishTasks($, () => done, assertAdmitted, token)
    }
    assertAdmitted()
    const kept = await dropRewound($, String(e.text ?? ''))
    // A rewind check that ran after an owner change speaks for the new owner, not for this prompt.
    assertAdmitted()
    if (!kept) return { drop: `track: ${saveFailureText('rewind')}. Retry after storage is available.` }
    const typed = e.origin?.kind === 'composer'
    // A plugin's prompt (Plannotator's review comments) can add work to a running plan.
    const fromPlugin = e.origin?.kind === 'plugin'
    const needsSteps = (await read($, turn)).composedRule !== RULE
    if (e.text.trim().startsWith('/')) {
      // /track and the built-in commands reach no main-loop work: nothing rides on them, and a
      // withdrawn question waits for a prompt the model reads. A skill's slash command reaches the
      // model and starts work, so it carries what a typed prompt carries.
      const name = /^\/([^\s]+)/.exec(e.text.trim())?.[1] ?? ''
      const isBuiltin = name === 'track' || (await $.command.list()).some(c => c.name === name && c.source === 'builtin')
      assertAdmitted()
      if (isBuiltin) return next(e)
    }
    // Phase 2 D6: classic.Stop may not run on this host, so the command hook's inventory of the
    // finished turn's live tasks retires the rest at the next main prompt. Ids launched later stay.
    // After the builtin return: a builtin command reaches no model, so it would lose the line.
    const origin = e.origin?.kind
    if ((e as { agentId?: string }).agentId === undefined && typeof token?.owner === 'string' && (origin === 'composer' || origin === 'plugin' || origin === 'task-notification')) {
      const live = await readStopInventory($, token.owner)
      if (live !== undefined) {
        let dropped = 0
        const line = await finishTasks($, a => {
          const drops = inventoryDrops(a, live)
          dropped = drops.length
          return drops
        }, assertAdmitted, token)
        noteEvent($, 'stop.inventory_applied', { dropped, launch_seq: live.launchSeq }, live.turnId)
        if (line !== undefined) followUpLine = followUpLine === undefined ? line : `${followUpLine} ${line}`
      }
    }
    const lines: string[] = [...(needsSteps ? [STEPS_LINE] : []), ...(followUpLine !== undefined ? [followUpLine] : [])]
    if ((typed || fromPlugin || e.origin?.kind === 'task-notification') && (e as { agentId?: string }).agentId === undefined) await remindFinishedTurn($, assertAdmitted)
    const reminder = (await read($, turn)).stepReminder
    if ((typed || fromPlugin) && (e as { agentId?: string }).agentId === undefined && reminder !== undefined) {
      lines.push(reminder)
      await update($, turn, current => {
        assertAdmitted()
        return current.stepReminder === reminder ? { ...current, stepReminder: undefined } : current
      })
    }
    const resultReminder = (await read($, turn)).resultReminder
    if ((typed || fromPlugin) && (e as { agentId?: string }).agentId === undefined && resultReminder !== undefined) {
      const text = missingResultText((await read($, ledger)).steps, resultReminder.ids)
      if (text !== undefined) lines.push(text)
      await update($, turn, current => {
        assertAdmitted()
        return current.resultReminder?.turnId === resultReminder.turnId ? { ...current, resultReminder: undefined } : current
      })
    }
    // A prompt Stop already asked about once and no row covers yet is named again here.
    const unresolved = (await read($, pending)).inputs.filter(i => i.held === true && i.covered === undefined && needsQuestion(i))
    const waiting = unregisteredContext(unresolved)
    if (waiting !== undefined) lines.push(waiting)
    const l = await read($, ledger)
    assertAdmitted()
    const context = promptContext(l, e.text, ANSWER)
    if (context.references !== undefined) lines.push(context.references)
    // A question the user withdrew with ✕ is told to the model once, on whatever prompt it reads next.
    if (context.withdrawn !== undefined) {
      lines.push(context.withdrawn)
      await updateLedger($, cur => {
        assertAdmitted()
        return { ...cur, withdrawn: remainingNotices(cur.withdrawn, l.withdrawn) }
      })
    }
    // Unfinished steps the user removed with a confirmed "clear all", told once like a withdrawal.
    if (context.cleared !== undefined) {
      lines.push(context.cleared)
      await updateLedger($, cur => {
        assertAdmitted()
        return { ...cur, clearedSteps: remainingNotices(cur.clearedSteps, l.clearedSteps) }
      })
    }
    if (context.open === undefined) {
      return lines.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...lines] })
    }
    return next({ ...e, context: [...(e.context ?? []), ...lines, context.open] })
  })().catch((error: unknown) => {
    if (!(error instanceof OwnerChanged)) throw error
    return passThrough()
  })
  if (added !== undefined && 'drop' in entered) {
    const dropped = added
    // The drop removes this prompt's own input; after an owner change it is not in these rows.
    await update($, pending, p => {
      try { assertAdmitted() } catch (error) {
        if (error instanceof OwnerChanged) return p
        throw error
      }
      return { ...p, inputs: p.inputs.filter(i => i.id !== dropped) }
    })
  }

  return entered
}

// 'classic.Stop': the registration stays in register.tsx.
type StopEventHook = Hook<'classic.Stop'>
export async function stopEvent($: Parameters<StopEventHook>[0], e: Parameters<StopEventHook>[1], next: Parameters<StopEventHook>[2]): Promise<Awaited<ReturnType<StopEventHook>>> {
  const below = await next(e)
  // Stop lists the background work still in flight: a task whose notification never came
  // (killed, or lost) leaves the banner here.
  if (e.agent_id === undefined && Array.isArray(e.background_tasks)) {
    const inFlight = e.background_tasks
    const background = inFlight.filter(task => AGENT_TASK.test(task.type)).map(task => task.id)
    const tasks = inFlight.filter(task => !AGENT_TASK.test(task.type)).map(task => task.id)
    await update($, activity, a => ({ ...a, background, tasks }))
  }
  if (below.block !== undefined || e.agent_id !== undefined) {
    return below
  }
  const t = await read($, turn)
  await nudgeMissingResults($, t)
  // Each uncovered input is held once, even after another Stop hook continued the turn: its
  // own mark bounds the repair, so no loop. Unbound inputs are this turn's and are bound now.
  if (t.currentId !== null) {
    const currentId = t.currentId
    // Wait briefly for a Haiku label already in flight; past the wait the wording check decides.
    const inFlight = (await read($, pending)).inputs.filter(i => i.covered === undefined && i.held !== true && i.label === undefined).map(i => classifying.get(i.id)).filter(run => run !== undefined)
    if (inFlight.length > 0) await Promise.race([Promise.all(inFlight), $.clock.sleep(STOP_JOIN_MS)])
    let uncovered: PendingInput[] = []
    await update($, pending, p => {
      // Any unresolved input not yet asked about: this turn's, or one an interrupted turn left.
      uncovered = p.inputs.filter(i => i.covered === undefined && i.held !== true && needsQuestion(i))
      const bound = p.inputs.some(i => i.turnId === null)
      return bound ? { ...p, inputs: p.inputs.map(i => ({ ...i, turnId: i.turnId ?? currentId })) } : p
    })
    if (uncovered.length > 0) {
      // On hosts with both hooks, the command hook claims first. Both paths
      // use that same per-input claim, so the module cannot block it twice.
      const claim = await claimUncoveredInputs($, e, uncovered, currentId)
      if (claim.held) {
        const held = new Set(uncovered.map(i => i.id))
        await update($, pending, p => ({ ...p, inputs: p.inputs.map(i => held.has(i.id) ? { ...i, held: true as const } : i) }))
      }
      if (claim.block !== undefined) {
        await update($, turn, cur => ({ ...cur, gatedTurnId: currentId }))
        noteEvent($, 'stop.block.module', { kind: 'uncovered_input', inputs: uncovered.length }, currentId)
        return { ...below, block: claim.block }
      }
    }
  }
  if (t.currentId === null) {
    if (!e.stop_hook_active) nudgeFed($, 'identity', await freshnessNudge($, 'identity', 'track: current turn identity unavailable; reconcile steps before finishing.'))
    return below
  }
  // Ohad, 2026-10-18: every Stop after a block carries stop_hook_active, and it still checks
  // the freshness kinds. Each kind's shared hold allows one block per turn, so this cannot
  // loop. The open-question gate keeps its bypass.
  if (e.stop_hook_active) {
    const block = await stepStop($, e)
    return block === undefined ? below : { ...below, block }
  }
  const l = await read($, ledger)
  const open = l.questions.filter(q => q.status === 'open' && q.turnId === t.currentId)
  if (open.length === 0 || t.gatedTurnId === t.currentId) {
    const block = await stepStop($, e)
    return block === undefined ? below : { ...below, block }
  }
  await update($, turn, cur => ({ ...cur, gatedTurnId: t.currentId }))
  await publishGate($)
  noteEvent($, 'stop.block.module', { kind: 'open_question', open: open.length }, t.currentId)
  const first = open[0] as Question
  const rest = open.length > 1 ? ` (${open.length - 1} more open: ${open.slice(1).map(q => `Q${q.id}`).join(', ')})` : ''

  return {
    ...below,
    block: `track: Q${first.id} "${first.head}" from this turn is still open${rest}. ${ANSWER.replaceAll('{id}', String(first.id))}. If it must wait, call mcp__track__mark_answered with status "deferred" and a note. Then finish.`,
  }
}

// 'session.compact': the registration stays in register.tsx.
type SessionCompactEventHook = Hook<'session.compact'>
export async function sessionCompactEvent($: Parameters<SessionCompactEventHook>[0], e: Parameters<SessionCompactEventHook>[1], next: Parameters<SessionCompactEventHook>[2]): Promise<Awaited<ReturnType<SessionCompactEventHook>>> {
  const compacted = await next(e)
  if (e.agentId === undefined && !('skip' in compacted)) {
    await updateLedger($, l => ({ ...l, compactedAt: Date.now() }))
    // The transcript before compaction is no baseline for the one after it.
    forgetTranscriptBaseline()
  }

  return compacted
}

// 'turn.complete': the registration stays in register.tsx.
type TurnCompleteEventHook = Hook<'turn.complete'>
export async function turnCompleteEvent($: Parameters<TurnCompleteEventHook>[0], e: Parameters<TurnCompleteEventHook>[1], next: Parameters<TurnCompleteEventHook>[2]): Promise<Awaited<ReturnType<TurnCompleteEventHook>>> {
  if (e.agentId === undefined) {
    const currentId = (await read($, turn)).currentId
    // The activity atom's own identity fences a new turn that starts during this update.
    await update($, activity, a => (a.mainTurnId ?? currentId) === e.turnId || (a.mainTurnId ?? currentId) === null
      ? { ...a, isWorking: false, agentCalls: [], askCalls: [] }
      : a)
  } else {
    // A background agent's loop ended: retire it as a finished task, so the step it owned is flagged now.
    const agentId = e.agentId
    // Fence on the owner at completion. A child receipt never claims or switches the session owner.
    const epoch = ownership.epoch
    try {
      const owner = (await read($, ledger)).session_id ?? (await read($, durability)).memorySession ?? undefined
      const token: OwnerToken = { owner, epoch }
      const assertAdmitted = () => assertOwner(token)
      assertAdmitted()
      await finishTasks($, () => [agentId], assertAdmitted, token)
      await publishGate($, token)
    } catch (error) {
      // The owner changed during this child completion: its writes belong to the old session, so drop them.
      if (!(error instanceof OwnerChanged)) throw error
    }
  }
  const done = await next(e)
  if (e.agentId === undefined && deployDrift.isShown) $.clock.after(0, () => checkDeployDrift($))
  if (e.agentId === undefined) {
    if (e.isAborted) {
      const now = await $.clock.now()
      await updateLedger($, l => ({ ...l, steps: l.steps.map(s => {
        if (s.cleared === true || s.status !== 'in_progress' || s.delegated === true || s.activeTurnId !== e.turnId) return s
        return { ...withStatus(s, 'paused', now), note: s.note ? `${s.note}; interrupted` : 'interrupted' }
      }) }))
      await dropFinishedOwners($)
    }
    await recordTranscriptBaseline($)
    await saveLedger($)
  }

  return done
}

// 'classic.SessionStart': the registration stays in register.tsx.
type ClassicSessionStartEventHook = Hook<'classic.SessionStart'>
export async function classicSessionStartEvent($: Parameters<ClassicSessionStartEventHook>[0], e: Parameters<ClassicSessionStartEventHook>[1], next: Parameters<ClassicSessionStartEventHook>[2]): Promise<Awaited<ReturnType<ClassicSessionStartEventHook>>> {
  if (e.source === 'resume') {
    await switchOwner($, e.session_id)
  }

  return next(e)
}

// 'session.end': the registration stays in register.tsx.
type SessionEndEventHook = Hook<'session.end'>
export async function sessionEndEvent($: Parameters<SessionEndEventHook>[0], e: Parameters<SessionEndEventHook>[1], next: Parameters<SessionEndEventHook>[2]): Promise<Awaited<ReturnType<SessionEndEventHook>>> {
  await saveLedger($)
  if (writer.lease !== null) await closeLock(writer.lease).catch(() => undefined)
  writer.lease = null
  writer.session = ''
  if (e.reason === 'clear') {
    await updateLedger($, () => EMPTY_LEDGER)
    await update($, turn, () => ({ currentId: null, gatedTurnId: null }))
    await update($, activity, () => IDLE)
  }

  return next(e)
}
