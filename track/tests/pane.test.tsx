import { expect, mock, test } from 'claude-code/testing'

import { EMPTY, SESSION, atomStore, pane } from './kit'
import type { Engine, On } from './kit'

// The banner and the two rings: what the pane says about the session's work.

const IDLE = { isWorking: false, agentCalls: [] as string[], askCalls: [] as string[], background: [] as string[], tasks: [] as string[] }
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

  const banner = (await ui.findAll({ type: 'Box' })).filter(el => String(el.key ?? '').startsWith('banner-')).map(el => String(el.text ?? '')).join(' ')
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
  // Completed Questions have their own control; Steps controls preserve them.
  await ui.press({ key: 'clear-answered' })
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

// Layout in a narrow pane: nothing is cut. Text wraps onto more rows, and the scrolling regions
// give up the rows the wrapping takes, so the banner stays inside the pane.
type Box = { key?: string; type?: string; text?: string; props: unknown }
const heightOf = (all: Box[], key: string) => (all.find(el => el.key === key)?.props as { height?: number } | undefined)?.height ?? 0

const layout = async ($: Engine, on: On, ledger: unknown, columns: number, rows = 30) => {
  atomStore(on, 'ledger', ledger)
  atomStore(on, 'activity', IDLE)
  mock.clock(on)
  const ui = await $.ui.mount(pane('dock', columns, rows))

  return (await ui.findAll({})) as Box[]
}

test('with no questions and no steps, each concise placeholder takes one row', async ($, on) => {
  const all = await layout($, on, EMPTY, 30)

  const placeholder = all.find(el => el.type === 'Text' && String(el.text ?? '').trim() === 'None yet.')
  expect((placeholder?.props as { wrap?: string } | undefined)?.wrap).toBe('wrap')
  expect(heightOf(all, 'questions')).toBe(1)
  expect(heightOf(all, 'steps')).toBe(1)
})

test('a steps header too wide for the pane wraps, and the regions give up the extra row', async ($, on) => {
  const steps = Array.from({ length: 39 }, (_, i) => step(i + 1, i < 12 ? 'completed' : 'pending'))
  const narrow = await layout($, on, { ...EMPTY, steps }, 46)
  const header = narrow.find(el => el.key === 'steps-header')
  expect((header?.props as { flexWrap?: string } | undefined)?.flexWrap).toBe('wrap')
  // Each header item keeps its width: the word, the ring and each button wrap whole.
  const word = narrow.find(el => el.key === 'steps-word')
  expect((word?.props as { flexShrink?: number } | undefined)?.flexShrink).toBe(0)
})

test('the regions of a narrow pane are shorter by the rows its wrapped bars take', async ($, on) => {
  const steps = Array.from({ length: 39 }, (_, i) => step(i + 1, i < 12 ? 'completed' : 'pending'))
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps })
  atomStore(on, 'activity', IDLE)
  mock.clock(on)
  const first = await $.ui.mount(pane('dock', 120, 30))
  const wide = (await first.findAll({})) as Box[]
  await first.unmount()
  const narrow = (await (await $.ui.mount(pane('dock', 46, 30))).findAll({})) as Box[]
  void ledger

  const rowsOf = (all: Box[]) => heightOf(all, 'questions') + heightOf(all, 'steps')
  expect(rowsOf(narrow)).toBeLessThan(rowsOf(wide))
})

test('the bottom bar wraps its hint instead of cutting it with an ellipsis', async ($, on) => {
  const all = await layout($, on, { ...EMPTY, steps: [step(1, 'pending')] }, 46)

  const bar = all.find(el => el.key === 'bottom-bar')
  expect((bar?.props as { flexWrap?: string } | undefined)?.flexWrap).toBe('wrap')
  const hint = all.find(el => el.type === 'Text' && /\/track hides/.test(String(el.text ?? '')))
  expect((hint?.props as { wrap?: string } | undefined)?.wrap).not.toBe('truncate-end')
})

// A row taller than its whole region had its last lines clipped with no way to scroll to them; it
// is cut to the region with an ellipsis instead.
test('a question taller than its region is cut to fit, ending in an ellipsis', async ($, on) => {
  const long = { ...question(1, 'open'), head: 'why '.repeat(50).trim() }
  const all = await layout($, on, { ...EMPTY, nextQuestionId: 2, questions: [long], steps: [step(1, 'pending')] }, 46, 16)

  const row = all.find(el => el.type === 'Text' && String(el.text ?? '').startsWith('Q1. why'))
  const text = String(row?.text ?? '')
  expect(text.endsWith('…')).toBe(true)
  expect(text.length).toBeLessThan(long.head.length)
})
