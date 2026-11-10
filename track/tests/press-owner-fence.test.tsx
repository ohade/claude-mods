// FIXTURE: a pane press whose first write loses to a session switch must refuse on its retry. Real pane, handlers and engine, state in memory.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'
import type { Ledger, Question, Step } from '../types'

const OTHER = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'
const OWNER_CHANGED = 'track: session owner changed during the call; Track did not finish recording it'
const open: Question = { id: 1, head: 'Which file?', at: 100, turnId: null, status: 'open' }
const answered: Question = { id: 2, head: 'Which mode?', at: 101, turnId: null, status: 'answered' }
const done: Step = { id: 'plan:1', source: 'plan', subject: 'Finished work', status: 'completed' }
const rows = (session: string): Ledger => ({ ...EMPTY, session_id: session, nextQuestionId: 3, questions: [open, answered], steps: [done] })

// The pane is drawn for SESSION. When the press writes, another session has been selected, so
// the write loses its compare-and-set and its retry meets the other session's ledger.
for (const key of ['del-1', 'clear-questions', 'clear-answered', 'clear-steps', 'clear-completed']) {
  test(`pressing ${key} after another session was selected changes nothing and says the owner changed`, async ($, on) => {
    let ledger!: ReturnType<typeof atomStore<Ledger>>
    let enabled = false
    let injected = false
    on('state.set', { plugin: 'track', key: ['ledger'] }, (_, event, next) => {
      if (enabled && !injected) {
        injected = true
        ledger.value = rows(OTHER)
        ledger.version++
      }
      return next(event)
    })
    ledger = atomStore<Ledger>(on, 'ledger', rows(SESSION))
    atomStore<number | null>(on, 'clearArm', null)
    atomStore(on, 'turn', { currentId: null, gatedTurnId: null, eventOrder: 0 })
    atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
    atomStore(on, 'pending', { inputs: [], nextId: 1 })
    atomStore(on, 'scroll', { questions: null, steps: null })
    mock.clock(on, { now: 5000 })
    pluginStore(on)
    const toasts: string[] = []
    on('session.id', () => ({ value: SESSION }))
    on('session.messages', () => ({ value: [] }))
    on('ui.toast', (_, e) => { toasts.push(String(e.text)); return { value: undefined } })
    const ui = await $.ui.mount(pane('dock'))
    enabled = true
    await ui.press({ key })
    expect(injected, 'FIXTURE control: the other session won the attempted version').toBe(true)
    expect(ledger.value).toEqual(rows(OTHER))
    expect(toasts).toEqual([OWNER_CHANGED])
  })
}
