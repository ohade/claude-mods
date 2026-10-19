// FIXTURE: TRACK-29 (2026-10-19). Display ordinals must follow the same
// uncleared rows as the native pane; permanent tool ids must never be guessed.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger } from '../types'

const prepare = async ($: Engine, on: On) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1,
    steps: [
      { id: 'plan:1', source: 'plan', subject: 'Already finished', status: 'completed', cleared: true },
      { id: 'plan:2', source: 'plan', subject: 'Waiting for an answer', status: 'waiting' },
      { id: 'plan:3', source: 'plan', subject: 'Implement the next change', status: 'pending' },
    ],
    questions: [
      { id: 2, head: 'Cleared question', at: 1, turnId: 'old', status: 'answered', cleared: true },
      { id: 7, head: 'Current question', at: 2, turnId: 'old', status: 'open' },
    ],
  })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'scroll', { questions: null, steps: null })
  const store = pluginStore(on)
  const contexts: string[] = []
  on('session.id', () => ({ value: SESSION }))
  on('prompt.submit', (_, e) => { contexts.push(...(e.context ?? [])); return { text: e.text } })
  return { ledger, store, contexts }
}

test('TRACK-29 mentioned S2 and Q1 resolve after completed rows are cleared', async ($, on) => {
  const f = await prepare($, on)
  await $.prompt.submit({ text: 'Continue S2, and explain Q1.', origin: { kind: 'composer' }, turnId: 't1' } as never)
  const context = f.contexts.join('\n')
  expect(context).toContain('S2 = plan:3')
  expect(context).toContain('Q1 = question:7')
  expect(context).not.toContain('S1 = plan:2')
  expect(context).not.toContain('S2 = plan:2')
})

test('TRACK-29 an unmentioned order map costs no prompt context', async ($, on) => {
  const f = await prepare($, on)
  await $.prompt.submit({ text: 'Continue the agreed work.', origin: { kind: 'composer' }, turnId: 't1' } as never)
  expect(f.contexts.join('\n')).not.toContain('S1 =')
  expect(f.contexts.join('\n')).not.toContain('S2 =')
  expect(f.contexts.join('\n')).not.toContain('Q1 =')
})

test('TRACK-29 repeated references use the latest order and never guess an absent row', async ($, on) => {
  const f = await prepare($, on)
  await $.prompt.submit({ text: 'Show S2.', origin: { kind: 'composer' }, turnId: 't1' } as never)
  expect(f.contexts.join('\n')).toContain('S2 = plan:3')
  f.contexts.length = 0
  f.ledger.value = { ...f.ledger.value, steps: f.ledger.value.steps.map(step => step.id === 'plan:2' ? { ...step, cleared: true } : step) }
  await $.prompt.submit({ text: 'Show S1 and S2.', origin: { kind: 'composer' }, turnId: 't1' } as never)
  const context = f.contexts.join('\n')
  expect(context).toContain('S1 = plan:3')
  expect(context).toContain('S2 = not shown')
  expect(context).not.toContain('S2 = plan:3')
})
