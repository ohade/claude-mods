import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'
import type { Engine } from './kit'
import type { Ledger, Step } from '../types'

// FIXTURE, WO plan:16c (refuter, unreproduced): the first clear-all press decides to arm on the
// ledger, then writes clearArm. If the last open step completes and new work is added while that
// positive write is still in flight, the arm lands after the zero transition. This test holds the
// real write once through an unfiltered state.set relay and checks that the next press does not
// clear the newly added step without its own confirmation. Fixture-only providers: the relay, the
// atom stores and the session/toast answers. A deadline, a refused concurrent event or a setup
// error is INVALID FIXTURE, never behavioral RED; only the final named assertion can be RED.

type Found = { key?: string; text: string; props: Record<string, unknown> }
type Drawn = { press: (q: { key: string }) => Promise<void>; redraw: () => Promise<void>; find: (q: { key?: string; type?: string; text?: string | RegExp }) => Promise<Found | undefined>; findAll: (q: { key?: string; type?: string; text?: string | RegExp }) => Promise<Found[]>; unmount: () => Promise<void> }
type ToolResult = { deny?: unknown; isError?: boolean }

const NOW = 5000
const step = (id: string, subject: string, status: Step['status'] = 'pending'): Step => ({ id, source: 'plan', subject, status })

const latch = () => {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  return { entered, released, enter, release }
}

const outcome = async <T,>(request: Promise<T>) => {
  try { return { value: await request } }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
}

// Real time bounds fixture orchestration only (track34-session-switch.test.tsx). A deadline is an
// invalid native run, never the assertion that earns behavioral RED.
const fixtureWait = async <T,>(request: Promise<T>, phase: string): Promise<T> => {
  const timers = globalThis as unknown as {
    setTimeout: (run: () => void, ms: number) => unknown; clearTimeout: (timer: unknown) => void
  }
  let timer: unknown
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = timers.setTimeout(() => reject(new Error(`INVALID FIXTURE: deadline during ${phase}`)), 2000)
    })])
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer)
  }
}

const ids = (l: { value: Ledger }) => l.value.steps.map(s => s.id)
const unfinished = (l: { value: Ledger }) => l.value.steps.filter(s => s.status !== 'completed').map(s => s.id)

// A refused or failed concurrent tool call is an unsupported schedule, not behavioral RED.
const callWhileHeld = async ($: Engine, request: Record<string, unknown>, phase: string) => {
  const result = await fixtureWait(outcome($.tool.call(request as never) as Promise<ToolResult>), phase)
  if ('error' in result) throw new Error(`INVALID FIXTURE: ${phase} rejected: ${result.error}`)
  if (result.value.deny !== undefined || result.value.isError === true) {
    throw new Error(`INVALID FIXTURE: ${phase} refused: ${JSON.stringify(result.value)}`)
  }
}

test('FIXTURE clear-all arm race: a press armed on old work does not confirm work added while its arm write was held', async ($, on) => {
  const held = latch()
  let heldOnce = false
  const armSets: Array<{ value: unknown; ifVersion: unknown; held: boolean; answer?: unknown }> = []
  // Registered before the atom providers so it sees every clearArm write first. Holds only the
  // first positive write, once; null resets and the native compare-and-set retry relay unchanged.
  on('state.set', async (_, e, next) => {
    if (e.plugin !== 'track' || e.key !== 'clearArm') return next(e)
    const hold = !heldOnce && typeof e.value === 'number'
    const attempt: { value: unknown; ifVersion: unknown; held: boolean; answer?: unknown } = { value: e.value, ifVersion: e.ifVersion, held: hold }
    armSets.push(attempt)
    if (hold) {
      heldOnce = true
      held.enter()
      await held.released
    }
    const answer = await next(e)
    attempt.answer = answer
    return answer
  })
  const clock = mock.clock(on, { now: NOW })
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, session_id: SESSION, steps: [step('plan:1', 'Old work')] })
  const arm = atomStore<number | null>(on, 'clearArm' as never, null)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.messages', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  const ui = (await $.ui.mount(pane('dock', 60))) as unknown as Drawn
  const snapshot = () => ({ ids: ids(ledger), unfinished: unfinished(ledger), arm: arm.value, armVersion: arm.version, now: clock.now() })
  const snapshots: Record<string, ReturnType<typeof snapshot>> = { mounted: snapshot() }

  const press = outcome(ui.press({ key: 'clear-steps' }))
  try {
    const phase = await fixtureWait(Promise.race([
      held.entered.then(() => 'held'), press.then(() => 'returned'),
    ]), 'positive clearArm write admission')
    if (phase !== 'held') {
      throw new Error(`INVALID FIXTURE: first press returned before its positive clearArm write; clearArm sets=${JSON.stringify(armSets)}; press=${JSON.stringify(await press)}`)
    }
    snapshots.held = snapshot()

    await callWhileHeld($, { tool: 'mcp__track__mark_step', id: 'plan:1', status: 'completed', tool_use_id: 'arming-complete-old' }, 'mark_step plan:1 completed while the arm write is held')
    snapshots.completedOld = snapshot()
    // Proves the real zero transition: no unfinished step and clearArm stored as null.
    expect({ zeroTransitionWhileHeld: { unfinished: unfinished(ledger), arm: arm.value } }).toEqual({ zeroTransitionWhileHeld: { unfinished: [], arm: null } })

    await callWhileHeld($, { tool: 'mcp__track__track_steps', steps: ['New work'], after: 'last', tool_use_id: 'arming-add-new' }, 'track_steps New work while the arm write is held')
    snapshots.addedNew = snapshot()
    expect({ newWorkWhileHeld: { ids: ids(ledger), unfinished: unfinished(ledger) } }).toEqual({ newWorkWhileHeld: { ids: ['plan:1', 'plan:2'], unfinished: ['plan:2'] } })
  } finally {
    held.release()
    const first = await fixtureWait(press, 'first press after release')
    if ('error' in first) throw new Error(`INVALID FIXTURE: first press failed: ${first.error}`)
  }
  snapshots.firstPressDone = snapshot()

  await ui.redraw()
  // No 10-second expiry has elapsed: the mock clock never moved.
  expect({ mockTimeBeforeNewPress: clock.now() }).toEqual({ mockTimeBeforeNewPress: NOW })
  await ui.press({ key: 'clear-steps' })
  snapshots.newPress = snapshot()

  // Named behavior: a press armed on old work before the zero transition cannot confirm work added
  // afterward, so one new press keeps pending plan:2. The diagnosis rides along on both sides
  // only so a failure prints the barrier and compare-and-set record; it constrains nothing.
  const diagnosis = { armSets, snapshots }
  expect({ idsAfterOneNewPress: ids(ledger), diagnosis }).toEqual({ idsAfterOneNewPress: ['plan:1', 'plan:2'], diagnosis })
})
