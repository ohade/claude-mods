import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, pane, pluginStore, trackPrompt } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Step } from '../types'

// WO plan:16 (Ohad, 2026-10-28: "2. yes"): the steps' "clear all" (hotkey s) removed unfinished
// steps with one press and told no one (plan:8, 2026-10-27 17:06Z: two restored open steps
// vanished). With an unfinished step the first press only arms; a second press within 5 seconds
// clears; the open steps it removed are named to the model once on its next prompt, like a
// withdrawn question. With every step completed, one press still clears at once.

type Pressable = { press: (q: { key: string }) => Promise<void>; find: (q: { key: string }) => Promise<{ text: string } | undefined> }
type Cleared = Ledger & { clearedSteps?: Array<{ id: string; head: string }> }

const step = (id: string, subject: string, status: Step['status'] = 'pending'): Step => ({ id, source: 'plan', subject, status })
const MIXED = [step('plan:1', 'Open one'), step('plan:2', 'Open two', 'in_progress'), step('plan:3', 'Done three', 'completed')]
const DONE = [step('plan:1', 'Done one', 'completed'), step('plan:2', 'Done two', 'completed')]

const prepare = async (on: On, steps: Step[], records: Record<string, unknown> = {}) => {
  const clock = mock.clock(on)
  const ledger = atomStore<Cleared>(on, 'ledger', { ...EMPTY, session_id: SESSION, steps })
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  const store = pluginStore(on, records)
  const pool = blobPool(on)
  const toasts: string[] = []
  const contexts: string[][] = []
  on('session.id', () => ({ value: SESSION }))
  on('session.messages', () => ({ value: [] }))
  on('ui.toast', (_, e) => { toasts.push(String(e.text)); return { value: undefined } })
  on('prompt.submit', (_, e) => { contexts.push([...(e.context ?? [])]); return { text: e.text } })
  return { clock, ledger, store, pool, toasts, contexts }
}

const mount = async ($: Engine) => (await $.ui.mount(pane('dock'))) as unknown as Pressable
const ids = (l: { value: Ledger }) => l.value.steps.map(s => s.id)
const notices = (lines: string[]) => lines.filter(line => line.includes('cleared open steps'))

test('a first press with unfinished steps keeps every step and says how to confirm', async ($, on) => {
  const fixture = await prepare(on, MIXED)
  const ui = await mount($)
  await ui.press({ key: 'clear-steps' })

  expect(ids(fixture.ledger)).toEqual(['plan:1', 'plan:2', 'plan:3'])
  // WO plan:16b: the confirmation is drawn in the pane, not toasted.
  expect((await ui.find({ key: 'clear-steps' }))?.text).toMatch(/confirm.*2 unfinished steps/)
})

test('a second press inside the window clears every step', async ($, on) => {
  const fixture = await prepare(on, MIXED)
  const ui = await mount($)
  await ui.press({ key: 'clear-steps' })
  expect(ids(fixture.ledger)).toEqual(['plan:1', 'plan:2', 'plan:3'])
  await fixture.clock.advance(1000)
  await ui.press({ key: 'clear-steps' })

  expect(ids(fixture.ledger)).toEqual([])
})

test('a press after the 10-second window arms again instead of clearing', async ($, on) => {
  const fixture = await prepare(on, MIXED)
  const ui = await mount($)
  await ui.press({ key: 'clear-steps' })
  expect(ids(fixture.ledger)).toEqual(['plan:1', 'plan:2', 'plan:3'])
  await fixture.clock.advance(10001)
  await ui.press({ key: 'clear-steps' })
  expect(ids(fixture.ledger)).toEqual(['plan:1', 'plan:2', 'plan:3'])

  await fixture.clock.advance(1000)
  await ui.press({ key: 'clear-steps' })
  expect(ids(fixture.ledger)).toEqual([])
})

test('the next prompt names each removed open step once, never a completed one, and not again', async ($, on) => {
  const fixture = await prepare(on, MIXED)
  const ui = await mount($)
  await ui.press({ key: 'clear-steps' })
  expect(ids(fixture.ledger)).toEqual(['plan:1', 'plan:2', 'plan:3'])
  await ui.press({ key: 'clear-steps' })
  await trackPrompt($, 'next')
  await trackPrompt($, 'after that')

  const first = notices(fixture.contexts[0] ?? [])
  expect(first).toHaveLength(1)
  expect(first[0]).toContain('plan:1 "Open one"')
  expect(first[0]).toContain('plan:2 "Open two"')
  expect(first[0]?.match(/plan:1 /g)).toHaveLength(1)
  expect(first[0]).not.toContain('plan:3')
  expect(first[0]).not.toContain('Done three')
  expect(notices(fixture.contexts[1] ?? [])).toEqual([])
})

test('the removed open steps are saved with the ledger and survive a reload', async ($, on) => {
  const fixture = await prepare(on, MIXED)
  const ui = await mount($)
  await ui.press({ key: 'clear-steps' })
  expect(ids(fixture.ledger)).toEqual(['plan:1', 'plan:2', 'plan:3'])
  await ui.press({ key: 'clear-steps' })

  const saved = (await fixture.pool.logical(fixture.store, `s:${SESSION}`) as { ledger: Cleared }).ledger
  expect(saved.clearedSteps).toEqual([{ id: 'plan:1', head: 'Open one' }, { id: 'plan:2', head: 'Open two' }])
})

test('a reload keeps the saved record of removed open steps', async ($, on) => {
  const record = { ...EMPTY, steps: [], clearedSteps: [{ id: 'plan:1', head: 'Open one' }] }
  const fixture = await prepare(on, [], { [`s:${SESSION}`]: { v: 1, savedAt: 1, ledger: record } })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect(fixture.ledger.value.clearedSteps).toEqual([{ id: 'plan:1', head: 'Open one' }])
})

test('control: with every step completed, one press clears at once', async ($, on) => {
  const fixture = await prepare(on, DONE)
  const ui = await mount($)
  await ui.press({ key: 'clear-steps' })

  expect(ids(fixture.ledger)).toEqual([])
})

test('control: clear completed hides only the completed steps, as before', async ($, on) => {
  const fixture = await prepare(on, MIXED)
  const ui = await mount($)
  await ui.press({ key: 'clear-completed' })

  expect(fixture.ledger.value.steps.map(s => [s.id, s.cleared === true])).toEqual([['plan:1', false], ['plan:2', false], ['plan:3', true]])
})
