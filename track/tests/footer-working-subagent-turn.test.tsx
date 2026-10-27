import { expect, mock, test } from 'claude-code/testing'

import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'

// WO plan:7 (2026-10-27): the footer read "Working" after the turn ended and the workspace was
// Idle (demo take s4-s6, 00:45Z, two subagent jobs under one delegated row). turn.start also
// fires for a subagent's loop, with agentId; it must not take over the main turn's activity, or
// the main turn.complete no longer matches and nothing ever clears isWorking.

type Activity = { isWorking: boolean; mainTurnId?: string; agentCalls: string[]; askCalls: string[]; background: string[]; tasks: string[] }
type Drawn = { findAll: (q: { type: string }) => Promise<Array<{ key?: string; text?: string }>> }

const IDLE: Activity = { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] }

const prepare = (on: On, start: Activity = IDLE) => {
  mock.clock(on)
  const activity = atomStore<Activity>(on, 'activity', start)
  atomStore(on, 'ledger', EMPTY)
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.messages', () => ({ value: [] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('env.get', () => ({ value: undefined }))
  return activity
}

const bannerOf = async ($: Engine) => {
  const ui = (await $.ui.mount(pane('dock'))) as unknown as Drawn
  const rows = (await ui.findAll({ type: 'Box' })).filter(el => String(el.key ?? '').startsWith('banner-'))

  return rows.map(el => String(el.text ?? '')).join(' ')
}

const start = ($: Engine, turnId: string, agentId?: string) =>
  $.turn.start({ text: '', turnId, ...(agentId !== undefined && { agentId }) } as never)
const complete = ($: Engine, turnId: string, agentId?: string) =>
  $.turn.complete({ answer: 'done', reason: 'answer', turnId, durationMs: 1, isAborted: false, ...(agentId !== undefined && { agentId }) } as never)

test('P1 a subagent turn inside the main turn: after both end, the footer is not Working', async ($, on) => {
  const activity = prepare(on)
  await start($, 'main-1')
  await start($, 'agent-turn-1', 'ag1')
  await complete($, 'agent-turn-1', 'ag1')
  await complete($, 'main-1')

  expect(activity.value.isWorking).toBe(false)
  expect(await bannerOf($)).not.toContain('Working')
})

test('P2 a background agent outlives the main turn: Agents while it runs, never Working', async ($, on) => {
  const activity = prepare(on, { ...IDLE, background: ['ag1'] })
  await start($, 'main-1')
  await start($, 'agent-turn-1', 'ag1')
  await complete($, 'main-1')

  expect(activity.value.isWorking).toBe(false)
  const during = await bannerOf($)
  expect(during).toContain('Agents')
  expect(during).not.toContain('Working')
})

// The pane mounts once per test, so the after-state of P2 is its own test.
test('P3 a background agent that outlived the main turn ends: the footer is not Working', async ($, on) => {
  const activity = prepare(on, { ...IDLE, background: ['ag1'] })
  await start($, 'main-1')
  await start($, 'agent-turn-1', 'ag1')
  await complete($, 'main-1')
  await complete($, 'agent-turn-1', 'ag1')

  expect(activity.value.isWorking).toBe(false)
  expect(activity.value.background).toEqual([])
  expect(await bannerOf($)).not.toContain('Working')
})

test('C1 control: while the main turn runs beside a subagent, the footer reads Working', async ($, on) => {
  const activity = prepare(on)
  await start($, 'main-1')
  await start($, 'agent-turn-1', 'ag1')

  expect(activity.value.isWorking).toBe(true)
  expect(activity.value.mainTurnId).toBe('main-1')
  expect(await bannerOf($)).toContain('Working')
})
