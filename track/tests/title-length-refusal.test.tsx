// FIXTURE: tool results. Ohad 2026-11-10: "we need to make sure that we have track having the title
// in two lines, the model needs to summarize it efficiently", then chose "Refuse over 90". A step
// or question title over 90 characters is refused: nothing is saved, and the refusal asks the
// model to resend a shorter title. Titles of 90 characters or fewer are saved as before.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, blobPool, pluginStore } from './kit'
import type { Engine, On } from './kit'
import type { Ledger } from '../types'

const LONG = 'Prismantis fork: failing test for an answer reply whose segment holds a list, code, table or long code'
const EDGE = 'x'.repeat(90)
const prepare = (on: On) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, session_id: SESSION })
  atomStore(on, 'turn', { currentId: 'turn-1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'scroll', { questions: null, steps: null })
  pluginStore(on)
  blobPool(on)
  on('session.id', () => ({ value: SESSION }))
  return ledger
}
const call = async ($: Engine, input: Record<string, unknown>) => await $.tool.call(input as never) as { result?: unknown; deny?: string }

test('a step title over 90 characters is refused and no step is saved', async ($, on) => {
  const ledger = prepare(on)
  expect([...LONG].length).toBe(102)
  const outcome = await call($, { tool: 'mcp__track__track_steps', steps: ['Short step', LONG] })
  expect(outcome.deny).toContain('step 2 is 102 characters')
  expect(outcome.deny).toContain('Nothing was saved')
  expect(ledger.value.steps).toEqual([])
})

test('a question summary over 90 characters is refused and no question is saved', async ($, on) => {
  const ledger = prepare(on)
  const outcome = await call($, { tool: 'mcp__track__track_question', summary: LONG })
  expect(outcome.deny).toContain('summary is 102 characters')
  expect(outcome.deny).toContain('Nothing was saved')
  expect(ledger.value.questions).toEqual([])
})

test('titles of 90 characters or fewer are saved', async ($, on) => {
  const ledger = prepare(on)
  expect((await call($, { tool: 'mcp__track__track_steps', steps: ['Short step', EDGE] })).deny).toBeUndefined()
  expect((await call($, { tool: 'mcp__track__track_question', summary: EDGE })).deny).toBeUndefined()
  expect(ledger.value.steps.map(s => s.subject)).toEqual(['Short step', EDGE])
  expect(ledger.value.questions.map(q => q.head)).toEqual([EDGE])
})
