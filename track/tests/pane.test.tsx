import { expect, mock, test } from 'claude-code/testing'

import { EMPTY, SESSION, atomStore, pane } from './kit'
import type { Engine, On } from './kit'

// The banner and the two rings: what the pane says about the session's work.

const IDLE = { isWorking: false, agentCalls: [] as string[], askCalls: [] as string[], background: [] as string[] }
const AMBER = ['#7a5410', '#9a6c16', '#bb861d', '#dba126']

type Drawn = { findAll: (q: { type: string }) => Promise<Array<{ key?: string; text?: string; props: unknown }>> }

const draw = async ($: Engine, on: On, ledger: unknown, activity: unknown) => {
  atomStore(on, 'ledger', ledger)
  atomStore(on, 'activity', activity)
  mock.clock(on)

  return (await $.ui.mount(pane('dock'))) as unknown as Drawn
}

const textsOf = async (ui: Drawn) => (await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? ''))

const bannerColor = async (ui: Drawn) =>
  ((await ui.findAll({ type: 'Box' })).find(b => b.key === 'banner')?.props as { backgroundColor?: string } | undefined)?.backgroundColor

const step = (n: number, status: string, cleared = false) => ({ id: `plan:${n}`, source: 'plan', subject: `step ${n}`, status, ...(cleared && { cleared: true }) })

const question = (id: number, status: string, cleared = false) => ({ id, head: `question ${id}`, at: id, turnId: 't1', status, ...(cleared && { cleared: true }) })

// Waiting on agents blinks amber whether or not a step is in progress: with none in progress the
// banner was a still orange bar, and nothing on the pane moved.
test('waiting on agents pulses the banner amber with no step in progress', async ($, on) => {
  const ui = await draw($, on, { ...EMPTY, steps: [step(1, 'completed')] }, { ...IDLE, background: ['agent-1'] })

  expect(AMBER).toContain(await bannerColor(ui))
})

// While the main turn runs, background agents still run: the banner says both.
test('a running turn with background agents names them in the banner', async ($, on) => {
  const ui = await draw($, on, EMPTY, { ...IDLE, isWorking: true, background: ['agent-1', 'agent-2'] })

  const banner = (await textsOf(ui)).at(-1) ?? ''
  expect(banner).toContain('Working')
  expect(banner).toContain('agents (2)')
})

// Stop lists the session's background work in flight. A task whose notification never came (killed,
// or lost) stayed in the list and held the banner on "Waiting on agents".
test('a Stop replaces the background list with the tasks still in flight', async ($, on) => {
  const activity = atomStore(on, 'activity', { ...IDLE, background: ['stale-1', 'agent-2'] })
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  on('classic.Stop', () => ({}))

  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{ id: 'agent-2', type: 'subagent', status: 'running', description: 'a review' }],
  } as never)

  expect(activity.value.background).toEqual(['agent-2'])
})

test('/clear forgets the activity of the session it ends', async ($, on) => {
  const activity = atomStore(on, 'activity', { ...IDLE, isWorking: true, background: ['agent-1'] })
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  on('session.id', () => ({ value: SESSION }))
  on('store.get', () => ({ value: undefined }))
  on('store.keys', () => ({ value: [] }))
  on('store.set', () => ({ value: undefined }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))

  await $.session.end({ reason: 'clear', sessionId: SESSION } as never)

  expect(activity.value).toEqual(IDLE)
})

// The rings count the rows the pane shows: after clear completed hid 33 done steps of 39, the
// ring read "33 of 39"; it reads "0 of 6".
test('the steps ring counts only the steps still shown', async ($, on) => {
  const steps = [...Array.from({ length: 33 }, (_, i) => step(i + 1, 'completed', true)), ...Array.from({ length: 6 }, (_, i) => step(34 + i, 'pending'))]
  const ui = await draw($, on, { ...EMPTY, steps }, IDLE)

  const texts = await textsOf(ui)
  expect(texts).toContain('○ 0 of 6 · 0%')
  expect(texts.join('\n')).not.toContain('of 39')
})

test('the questions ring counts only the questions still shown', async ($, on) => {
  const questions = [question(1, 'answered', true), question(2, 'answered', true), question(3, 'open'), question(4, 'answered')]
  const ui = await draw($, on, { ...EMPTY, nextQuestionId: 5, questions }, IDLE)

  expect(await textsOf(ui)).toContain('◑ 1 of 2 · 50%')
})

// A deferred answer still waits: it is not done in the ring, clear completed keeps it, and the
// banner goes on waiting on the person.
test('a deferred question is not done: the ring leaves it out and clear completed keeps it', async ($, on) => {
  const ledger = atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 3, questions: [question(1, 'answered'), question(2, 'deferred')] })
  atomStore(on, 'activity', IDLE)
  mock.clock(on)
  const ui = await $.ui.mount(pane('dock'))

  expect(await textsOf(ui as unknown as Drawn)).toContain('◑ 1 of 2 · 50%')
  // With no steps only the bottom bar is drawn.
  await ui.press({ key: 'clear-completed-bottom' })
  const rows = (ledger.value as { questions: Array<{ id: number; cleared?: true }> }).questions
  expect(rows.map(q => `${q.id}:${q.cleared === true ? 'cleared' : 'shown'}`)).toEqual(['1:cleared', '2:shown'])
})

// The caps keep the register small. At the cap, room is made from rows already cleared, then
// done ones; an open question or an unfinished step is never dropped while a spent one remains.
test('at the questions cap, the oldest answered question goes, not the open one', async ($, on) => {
  const questions = [question(1, 'open'), ...Array.from({ length: 199 }, (_, i) => question(i + 2, 'answered'))]
  const ledger = atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 201, questions, prompts: [{ rowKey: 'r', head: 'p', turnId: 't1', at: 1 }] })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  atomStore(on, 'scroll', { questions: null, steps: null })

  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'one more', tool_use_id: 'toolu_new' } as never)

  const ids = (ledger.value as { questions: Array<{ id: number }> }).questions.map(q => q.id)
  expect(ids).toHaveLength(200)
  expect(ids).toContain(1)
  expect(ids).not.toContain(2)
})

test('at the steps cap, a done step goes, not an unfinished one', async ($, on) => {
  const steps = [step(1, 'pending'), ...Array.from({ length: 299 }, (_, i) => step(i + 2, 'completed'))]
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps })
  atomStore(on, 'scroll', { questions: null, steps: null })

  await $.tool.call({ tool: 'mcp__track__track_steps', steps: ['one more'], after: 'plan:300' } as never)

  const ids = (ledger.value as { steps: Array<{ id: string }> }).steps.map(s => s.id)
  expect(ids).toHaveLength(300)
  expect(ids).toContain('plan:1')
  expect(ids).not.toContain('plan:2')
})
