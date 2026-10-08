// FIXTURE: 2026-10-08, Steps' clear-completed action also cleared answered
// questions, while Questions had no separate completed-clear control.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'
import type { On } from './kit'

const QUESTIONS = [
  { id: 1, head: 'Answered שאלה 😀', at: 1, turnId: 't', status: 'answered', answerText: 'Saved answer 😀' },
  { id: 2, head: 'Still open', at: 2, turnId: 't', status: 'open' },
  { id: 3, head: 'Deferred', at: 3, turnId: 't', status: 'deferred', note: 'Later' },
  { id: 4, head: 'Already cleared', at: 4, turnId: 't', status: 'answered', cleared: true },
]
const STEPS = [
  { id: 'plan:1', source: 'plan', subject: 'Finished', status: 'completed', startedAt: 1, endedAt: 2 },
  { id: 'plan:2', source: 'plan', subject: 'Working', status: 'in_progress', delegated: true, startedAt: 3 },
  { id: 'plan:3', source: 'plan', subject: 'Waiting for you', status: 'waiting' },
]
const setup = (on: On) => {
  mock.clock(on)
  const l = atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 5, questions: QUESTIONS, steps: STEPS })
  atomStore(on, 'turn', { currentId: 't', gatedTurnId: null })
  const store = pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('env.set', () => ({ value: undefined }))
  return { l, store }
}

for (const width of [17, 80]) {
  for (const key of ['clear-completed', 'clear-completed-bottom']) {
    test(`Steps ${key} at ${width} columns saves only completed-step clears`, async ($, on) => {
      const { l, store } = setup(on)
      const ui = await $.ui.mount(pane('dock', width, 30))
      expect(store.held.size).toBe(0)
      await ui.press({ key })
      expect(l.value.questions).toEqual(QUESTIONS)
      expect(l.value.steps).toEqual(STEPS.map(s => s.status === 'completed' ? { ...s, cleared: true } : s))
      expect((store.held.get(`s:${SESSION}`) as any).ledger).toEqual(l.value)
    })
  }

  test(`Questions has its own completed-clear control at ${width} columns and preserves every step`, async ($, on) => {
    const { l, store } = setup(on)
    const ui = await $.ui.mount(pane('dock', width, 30))
    const button = await ui.find({ key: 'clear-answered' })
    expect(button).toBeDefined()
    expect(button?.props.hotkey).toBe('a')
    expect(button?.props.label).toBe(width < 40 ? 'done' : 'clear completed')
    expect(String(button?.props.label).length + 3).toBeLessThanOrEqual(width)
    expect(store.held.size).toBe(0)
    await ui.press({ key: 'clear-answered' })
    expect(l.value.steps).toEqual(STEPS)
    expect(l.value.questions).toEqual(QUESTIONS.map(q => q.status === 'answered' ? { ...q, cleared: true } : q))
    expect((store.held.get(`s:${SESSION}`) as any).ledger).toEqual(l.value)
    const writes = l.writes.length
    await ui.redraw()
    expect(l.writes.length).toBe(writes)
  })
}
