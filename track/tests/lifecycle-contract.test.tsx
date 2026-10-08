// FIXTURE: native lifecycle inputs publish the independent Track Stop snapshot.
import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

test('restore tool description teaches repeat-safe preservation instead of a false repeat refusal', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  let description = ''
  on('tool.register', (_, e) => {
    if (e.name === 'restore_tracker') description = e.description
    return { value: { tool: `mcp__track__${e.name}` } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(description).not.toContain('already restored questions')
  expect(description).toMatch(/repeat.*preserve/i)
})

test('native tracking publishes the exact current open question to the ordinary Stop hook', async ($, on) => {
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  const values: string[] = []
  on('env.set', (_, e) => { if (e.name === 'TRACK_GATE_SNAPSHOT') values.push(String(e.value)); return { value: undefined } })
  await $.tool.call({ tool: 'mcp__track__track_question', summary: 'Substantive question', tool_use_id: 'q1' } as never)
  const snapshot = JSON.parse(values.at(-1) ?? '{}')
  expect(snapshot.session_id).toBe(SESSION)
  expect(snapshot.turn_id).toBe('t1')
  expect(snapshot.open).toEqual([{ id: 1, head: 'Substantive question' }])
  await $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'deferred', note: 'Peer is running' } as never)
  expect(JSON.parse(values.at(-1) ?? '{}').open).toEqual([])
})

test('capacity is checked inside the atomic question write under concurrent registrations', async ($, on) => {
  const questions = Array.from({ length: 199 }, (_, i) => ({ id: i + 1, head: `Open ${i}`, at: 1, turnId: 't1', status: 'open' }))
  const l = atomStore(on, 'ledger', { ...EMPTY, questions, nextQuestionId: 200 }, { holdReads: 2 })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  const results = await Promise.all([
    $.tool.call({ tool: 'mcp__track__track_question', summary: 'first' } as never),
    $.tool.call({ tool: 'mcp__track__track_question', summary: 'second' } as never),
  ])
  expect(l.value.questions).toHaveLength(200)
  expect(results.filter(r => r.deny?.includes('capacity'))).toHaveLength(1)
  expect(l.value.questions.slice(0, 199)).toEqual(questions)
})
