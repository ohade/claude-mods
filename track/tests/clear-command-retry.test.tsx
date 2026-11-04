// FIXTURE: bulk clear decisions use the ledger from the successful compare-and-set attempt.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'
import type { Ledger, Step } from '../types'

const NOW = 5000
const step = (id: string, status: Step['status']): Step => ({ id, source: 'plan', subject: id, status })

for (const mode of ['add-unarmed', 'complete-unarmed', 'add-armed'] as const) {
  test(`bulk clear retry ${mode} recomputes its decision and notices`, async ($, on) => {
    let ledger!: ReturnType<typeof atomStore<Ledger>>
    let enabled = false
    let injected = false
    on('state.set', { plugin: 'track', key: ['ledger'] }, (_, event, next) => {
      if (enabled && !injected) {
        injected = true
        ledger.value = { ...ledger.value, steps: mode === 'complete-unarmed'
          ? ledger.value.steps.map(row => ({ ...row, status: 'completed' as const }))
          : [...ledger.value.steps, step('plan:2', 'pending')] }
        ledger.version++
      }
      return next(event)
    })
    mock.clock(on, { now: NOW })
    ledger = atomStore<Ledger>(on, 'ledger', {
      ...EMPTY, session_id: SESSION,
      steps: [step('plan:1', mode === 'add-unarmed' ? 'completed' : 'pending')],
      clearedSteps: [{ id: 'plan:0', head: 'Prior notice' }],
    })
    const arm = atomStore<number | null>(on, 'clearArm', mode === 'add-armed' ? NOW : null)
    atomStore(on, 'turn', { currentId: null, gatedTurnId: null, eventOrder: 0 })
    atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
    atomStore(on, 'pending', { inputs: [], nextId: 1 })
    atomStore(on, 'scroll', { questions: null, steps: null })
    pluginStore(on)
    on('session.id', () => ({ value: SESSION }))
    on('session.messages', () => ({ value: [] }))
    on('ui.toast', () => ({ value: undefined }))
    const ui = await $.ui.mount(pane('dock'))
    enabled = true
    await ui.press({ key: 'clear-steps' })
    expect(injected, 'FIXTURE control: a competing ledger write won the attempted version').toBe(true)
    if (mode === 'add-unarmed') {
      expect(ledger.value.steps, 'new unfinished work requires a confirming press').toEqual([step('plan:1', 'completed'), step('plan:2', 'pending')])
      expect(arm.value).toBe(NOW)
      expect(ledger.value.clearedSteps).toEqual([{ id: 'plan:0', head: 'Prior notice' }])
    } else {
      expect(ledger.value.steps, 'the successful retry determines whether the press clears').toEqual([])
      expect(arm.value, 'the successful retry must not leave a stale arming decision').toBeNull()
      expect(ledger.value.clearedSteps, 'every unfinished row removed on the successful retry is reported').toEqual([
        { id: 'plan:0', head: 'Prior notice' },
        ...(mode === 'add-armed' ? [{ id: 'plan:1', head: 'plan:1' }, { id: 'plan:2', head: 'plan:2' }] : []),
      ])
    }
  })
}
