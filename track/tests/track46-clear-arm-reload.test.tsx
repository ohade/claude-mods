// FIXTURE: TRACK-46 A2. A mod reload keeps the clearArm atom but cancels the
// managed 10-second timer that would reset it. The fixture seeds that state
// directly: an arm from the earlier load, older than the window, with no timer
// left. The pane must show the ordinary "clear all" label, not the red confirm,
// and a press must arm again, never clear.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger, Step } from '../types'

type Pressable = { press: (q: { key: string }) => Promise<void>; find: (q: { key: string }) => Promise<{ text: string } | undefined>; unmount: () => Promise<void> }
const step = (id: string, subject: string, status: Step['status'] = 'pending'): Step => ({ id, source: 'plan', subject, status })
const MIXED = [step('plan:1', 'Open one'), step('plan:2', 'Open two', 'in_progress'), step('plan:3', 'Done three', 'completed')]

const prepare = async (on: On) => {
  const clock = mock.clock(on)
  const start = await clock.now()
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, session_id: SESSION, steps: MIXED })
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  // The earlier load armed clear-all; its reset timer died with that load. This fixture store
  // does not redraw a mounted pane on later writes, so each check below mounts a fresh pane.
  atomStore(on, 'clearArm', start as number | null)
  pluginStore(on)
  blobPool(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.messages', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  return { clock, ledger, start }
}
const mount = async ($: Engine) => (await $.ui.mount(pane('dock'))) as unknown as Pressable
const ids = (l: { value: Ledger }) => l.value.steps.map(s => s.id)

test('A2 a stale arm left by a reload shows the ordinary label and a press arms again', async ($, on) => {
  const f = await prepare(on)
  await f.clock.advance(10_001)
  const ui = await mount($)
  expect((await ui.find({ key: 'clear-steps' }))?.text, 'no red confirm after the window').not.toMatch(/confirm/)
  await ui.press({ key: 'clear-steps' })
  expect(ids(f.ledger), 'the first press after the window keeps every step').toEqual(['plan:1', 'plan:2', 'plan:3'])
  await ui.unmount()
  const fresh = await mount($)
  expect((await fresh.find({ key: 'clear-steps' }))?.text, 'the new arm draws the confirm').toMatch(/confirm.*2 unfinished steps/)
  await f.clock.advance(1000)
  await fresh.press({ key: 'clear-steps' })
  expect(ids(f.ledger), 'a timely second press clears').toEqual([])
})
