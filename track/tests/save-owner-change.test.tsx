// FIXTURE: a save whose caller lost the session owner is refused without marking the ledger unsaved. Real pane, handlers and engine, state in memory.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, pane, pluginStore } from './kit'
import type { On } from './kit'
import type { Ledger, Step } from '../types'

const OTHER = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'
const done: Step = { id: 'plan:1', source: 'plan', subject: 'Finished work', status: 'completed' }

// The session id changes as soon as the first ledger write lands, so the press that made the
// write reaches its save as a stale caller.
const setup = (on: On) => {
  const identity = { session: SESSION }
  on('state.set', { plugin: 'track', key: ['ledger'] }, (_, event, next) => {
    identity.session = OTHER
    return next(event)
  })
  atomStore<Ledger>(on, 'ledger', { ...EMPTY, session_id: SESSION, steps: [done] })
  const durability = atomStore(on, 'durability', { isUnsaved: false, reason: '' })
  atomStore<number | null>(on, 'clearArm', null)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  mock.clock(on, { now: 5000 })
  pluginStore(on)
  blobPool(on)
  const toasts: string[] = []
  on('session.id', () => ({ value: identity.session }))
  on('session.messages', () => ({ value: [] }))
  on('ui.toast', (_, e) => { toasts.push(String(e.text)); return { value: undefined } })

  return { identity, durability, toasts }
}

test('a clear whose session changed before its save says the owner changed and leaves the ledger saved', async ($, on) => {
  const f = setup(on)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'clear-steps' })
  expect(f.identity.session, 'FIXTURE control: the session changed during the press').toBe(OTHER)
  expect(f.toasts).toEqual(['track: session owner changed during the call; Track did not finish recording it'])
  expect(f.durability.value).toEqual({ isUnsaved: false, reason: '' })
})

test('a save after a refused stale save still runs', async ($, on) => {
  const f = setup(on)
  const ui = await $.ui.mount(pane('dock'))
  await ui.press({ key: 'clear-steps' })
  f.identity.session = SESSION
  const receipt = JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result))
  expect(receipt.ok).toBe(true)
})
