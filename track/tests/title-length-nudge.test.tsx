// FIXTURE: tool results. Ohad 2026-11-09: rows should fit two pane lines ("we should try and be
// more focus with what we say"). Agreed: a step or question title over 90 characters is still
// saved, and the tool result names it and asks for a shorter one. No refusal (Codex's earlier
// advice); titles at or under 90 characters get no extra text.
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
const call = async ($: Engine, input: Record<string, unknown>) => String((await $.tool.call(input as never) as { result: unknown }).result)

test('a step title over 90 characters is saved whole and the result asks for a shorter one', async ($, on) => {
  const ledger = prepare(on)
  expect([...LONG].length).toBe(102)
  const result = await call($, { tool: 'mcp__track__track_steps', steps: ['Short step', LONG, EDGE] })
  expect(ledger.value.steps.map(s => s.subject)).toEqual(['Short step', LONG, EDGE])
  expect(result).toContain('Too long for two pane lines: plan:2 (102 characters).')
  expect(result).not.toContain('plan:1 (')
  expect(result).not.toContain('plan:3 (')
})

test('a question summary over 90 characters is saved whole and the result asks for a shorter one', async ($, on) => {
  const ledger = prepare(on)
  const result = await call($, { tool: 'mcp__track__track_question', summary: LONG })
  expect(ledger.value.questions.map(q => q.head)).toEqual([LONG])
  expect(result).toContain('Too long for two pane lines: Q1 (102 characters).')
})

test('titles of 90 characters or fewer get no length note', async ($, on) => {
  prepare(on)
  expect(await call($, { tool: 'mcp__track__track_steps', steps: ['Short step', EDGE] })).not.toContain('Too long')
  expect(await call($, { tool: 'mcp__track__track_question', summary: EDGE })).not.toContain('Too long')
})
