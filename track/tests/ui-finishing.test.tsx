// FIXTURE: pane descriptions, not painted terminal pixels. LIVE acceptance is separate.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] }
const setup = (on: any, steps: any[] = [], questions: any[] = [], unsaved = false) => {
  atomStore(on, 'ledger', { ...EMPTY, steps, questions })
  atomStore(on, 'activity', IDLE)
  atomStore(on, 'durability', { isUnsaved: unsaved, reason: unsaved ? 'quota exhausted' : '' })
  mock.clock(on)
}

for (const [status, wanted] of [['paused', 'Paused'], ['pending', 'Idle'], ['waiting', 'Waiting on you'], ['in_progress', 'Activity unknown']] as const) {
  test(`idle ${status} step shows ${wanted}`, async ($, on) => {
    setup(on, [{ id: 'plan:1', source: 'plan', subject: 'Work item', status, note: 'Peer result pending' }])
    const ui = await $.ui.mount(pane('dock'))
    const banner = (await ui.findAll({ type: 'Text' })).at(-1)?.text ?? ''
    expect(banner).toContain(wanted)
    if (status !== 'waiting') expect(banner).not.toContain('Waiting on you')
  })
}

test('an unsaved ledger remains visible in the banner during idle work', async ($, on) => {
  setup(on, [], [], true)
  const ui = await $.ui.mount(pane('dock'))
  expect((await ui.findAll({ type: 'Text' })).at(-1)?.text).toContain('Unsaved')
})

test('question and answer markers have a fixed column before both short and long text', async ($, on) => {
  setup(on, [], [
    { id: 1, head: 'Short', at: 1, turnId: 't', status: 'open', askedRequestId: 'question-1' },
    { id: 2, head: 'שאלה ארוכה 😀 '.repeat(3), at: 2, turnId: 't', status: 'answered', askedRequestId: 'question-2', answerRequestId: 'answer-2' },
  ])
  const ui = await $.ui.mount(pane('dock', 46, 30))
  const all = await ui.findAll({})
  for (const id of [1, 2]) {
    const marker = all.find(el => el.key === `q-markers-${id}`)
    expect(marker?.props.width).toBe(13)
    expect(marker?.props.flexShrink).toBe(0)
    expect(all.findIndex(el => el.key === `q-markers-${id}`)).toBeLessThan(all.findIndex(el => el.key === `q-text-${id}`))
  }
  const first = all.find(el => el.key === 'q-answer-slot-1')
  const second = all.find(el => el.key === 'q-answer-slot-2')
  expect(first?.props.width).toBe(second?.props.width)
  expect(second?.props.width).toBeGreaterThan(0)
})

test('narrow truncation never splits an emoji or a combined grapheme', async ($, on) => {
  setup(on, [], [{ id: 1, head: '😀e\u0301שלום'.repeat(80), at: 1, turnId: 't', status: 'open' }])
  for (let width = 30; width <= 42; width++) {
    const ui = await $.ui.mount(pane('dock', width, 16))
    const text = (await ui.findAll({ type: 'Text' })).find(el => el.text.startsWith('Q1. '))?.text ?? ''
    expect(text.endsWith('…')).toBe(true)
    expect(Array.from(text).some(c => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff)).toBe(false)
    expect(text.endsWith('e…')).toBe(false)
    await ui.unmount()
  }
})
