// FIXTURE: after clearing answered questions the pane still showed Q25 instead
// of Q1. Display positions must not replace permanent model/store identities.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'
import type { On } from './kit'
import type { Ledger, Question } from '../types'

const question = (id: number, status: Question['status'], extra: Partial<Question> = {}): Question => ({
  id, head: id === 25 ? 'Keep' : `Old ${id}`, at: id, turnId: 't1', status,
  sourceId: `${SESSION}:Q${id}`, trackedBy: `track-${id}`, askedRequestId: `track-${id}`, ...extra,
})
const prepare = (on: On, questions: Question[]) => {
  mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', { ...EMPTY, v: 1, nextQuestionId: 100, questions })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('env.set', () => ({ value: undefined }))
  let context = ''
  on('prompt.submit', (_, e) => { context = (e.context ?? []).join('\n'); return { text: e.text } })
  return { ledger, context: () => context }
}
const toolRow = (tool: string, id: number, use = `mark-${id}`, status = 'answered') => ({
  plugin: 'track', surface: 'terminal' as const, component: 'ToolUse' as const, requestId: use,
  props: { tool_use_id: use, tool, input: { id, status }, isRunning: false, isErrored: false, isInterrupted: false },
})

for (const width of [17, 80]) {
  test(`clear answered gives the remaining question Q1 at ${width} columns while model id stays 25`, async ($, on) => {
    const fixture = prepare(on, [question(7, 'answered', { cleared: true }), question(24, 'answered'), question(25, 'open')])
    const ui = await $.ui.mount(pane('dock', width, 30))
    await ui.press({ key: 'clear-answered' })
    expect(fixture.ledger.value.questions.map(q => q.id)).toEqual([7, 24, 25])
    expect(fixture.ledger.value.nextQuestionId).toBe(100)
    expect(fixture.ledger.value.questions[2].sourceId).toBe(`${SESSION}:Q25`)
    await $.prompt.submit({ text: 'Continue', origin: { kind: 'composer' } } as never)
    expect(fixture.context()).toContain('Q25 "Keep"')
    const marked = await $.tool.call({ tool: 'mcp__track__mark_answered', id: 25, status: 'answered', answer_text: 'Kept answer', tool_use_id: 'mark-25' } as never)
    expect(marked.result).toBe('Q25 marked answered.')
    expect(fixture.ledger.value.questions[2]).toMatchObject({ id: 25, status: 'answered', sourceId: `${SESSION}:Q25` })
    await ui.redraw()
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('Q1. Keep')
    expect(await ui.find({ key: 'row-q-25' })).toBeDefined()
    expect(await ui.find({ key: 'row-q-1' })).toBeUndefined()
  })
}

test('positions follow visible array order without reusing permanent ids or changing saved checkpoints', async ($, on) => {
  const fixture = prepare(on, [question(99, 'answered', { cleared: true }), question(25, 'open'), question(4, 'deferred', { note: 'Waiting' })])
  const before = await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)
  const ui = await $.ui.mount(pane('dock', 80, 40))
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('Q1. Keep')
  expect(texts).toContain('Q2. Old 4')
  const after = await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)
  expect(JSON.parse(String(after.result))).toEqual(JSON.parse(String(before.result)))
  expect(fixture.ledger.value.questions.map(q => q.id)).toEqual([99, 25, 4])
  expect(fixture.ledger.value.nextQuestionId).toBe(100)
})

test('question and acknowledgement tool rows match the pane while cleared rows fall back to permanent labels', async ($, on) => {
  const fixture = prepare(on, [question(24, 'answered', { cleared: true }), question(25, 'answered', { answerText: 'Kept answer', answeredBy: 'mark-25', answerKey: 'mark-25' })])
  const source = await $.ui.mount(toolRow('mcp__track__track_question', 25, 'track-25'))
  expect((await source.findAll({ type: 'Text' })).map(t => t.text)).toContain('Q1. Keep')
  const acknowledgement = await $.ui.mount(toolRow('mcp__track__mark_answered', 25))
  expect((await acknowledgement.findAll({ type: 'Text' })).map(t => t.text)).toContain('✓ Q1. answered')
  expect((await acknowledgement.findAll({ type: 'Text' })).map(t => t.text)).toContain('Kept answer')
  const staleStatus = await $.ui.mount(toolRow('mcp__track__mark_answered', 25, 'older-mark', 'deferred'))
  expect((await staleStatus.findAll({ type: 'Text' })).map(t => t.text)).toContain('Q1. answered')
  const ui = await $.ui.mount(pane('dock', 80, 30))
  await ui.press({ key: 'clear-answered' })
  await source.redraw()
  await acknowledgement.redraw()
  expect((await source.findAll({ type: 'Text' })).map(t => t.text)).toContain('Q25. Keep')
  expect((await acknowledgement.findAll({ type: 'Text' })).map(t => t.text)).toContain('✓ Q25. answered')
  expect(fixture.ledger.value.questions[1].id).toBe(25)
})

test('restored tool rows use current pane positions but retain snapshot words and permanent ids after clear', async ($, on) => {
  const fixture = prepare(on, [question(24, 'answered', { cleared: true }), question(25, 'open')])
  fixture.ledger.value = { ...fixture.ledger.value, restores: [{ by: 'restore-row', from: SESSION, steps: 0, questions: [question(25, 'open', { head: 'Saved words' })] }] }
  const row = await $.ui.mount(toolRow('mcp__track__restore_tracker', 25, 'restore-row'))
  expect((await row.findAll({ type: 'Text' })).map(t => t.text)).toContain('Q1. Saved words')
  const ui = await $.ui.mount(pane('dock', 80, 30))
  await ui.press({ key: 'clear-questions' })
  await row.redraw()
  expect((await row.findAll({ type: 'Text' })).map(t => t.text)).toContain('Q25. Saved words')
  expect(fixture.ledger.value.restores?.[0].questions[0].id).toBe(25)
})
