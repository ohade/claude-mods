import { expect, test } from 'claude-code/testing'

import { EMPTY, atomStore } from './kit'
import type { Engine, On } from './kit'

// What rides beside a prompt typed as a slash command: a skill reaches the model, a built-in
// command does not.

const OPEN = {
  ...EMPTY,
  nextQuestionId: 3,
  questions: [{ id: 2, head: 'still open', status: 'open', at: 1, turnId: 't0' }],
  steps: [{ id: 'plan:1', source: 'plan', subject: 'the step at work', status: 'in_progress' }],
  withdrawn: [{ id: 1, head: 'the withdrawn one' }],
}

const submit = async ($: Engine, on: On, text: string) => {
  let context: readonly string[] = []
  on('command.list', () => ({
    value: [
      { name: 'retro', description: 'retro', source: 'plugin' as const },
      { name: 'compact', description: 'compact', source: 'builtin' as const },
    ],
  }))
  on('prompt.submit', (_, e) => {
    context = e.context ?? []

    return { text: e.text }
  })
  await $.prompt.submit({ text, origin: { kind: 'composer' } } as never)

  return context.join('\n')
}

test('a skill command tells the model of a withdrawn question, the open ones and the step at work', async ($, on) => {
  const ledger = atomStore(on, 'ledger', OPEN as typeof OPEN & { withdrawn: unknown[] })
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null, composeSeen: true })

  const context = await submit($, on, '/retro')

  expect(context).toContain('withdrew Q1')
  expect(context).toContain('Q2')
  expect(context).toContain('plan:1')
  expect(ledger.value.withdrawn).toEqual([])
})

test('a built-in command keeps the withdrawn notice for the next prompt the model reads', async ($, on) => {
  const ledger = atomStore(on, 'ledger', OPEN as typeof OPEN & { withdrawn: unknown[] })
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null, composeSeen: true })

  const context = await submit($, on, '/compact')

  expect(context).not.toContain('withdrew')
  expect(ledger.value.withdrawn).toHaveLength(1)
})
