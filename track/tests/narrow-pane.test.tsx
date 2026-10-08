// FIXTURE: render descriptions, not painted terminal pixels.
// Regression: 2026-10-08, narrow Track panes clipped the title, hints and banner,
// and empty-state instructions consumed several rows.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'
import type { On } from './kit'

const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] }
const setup = (on: On, questions: unknown[] = [], steps: unknown[] = [], activity: unknown = IDLE) => {
  atomStore(on, 'ledger', { ...EMPTY, questions, steps })
  atomStore(on, 'activity', activity)
  mock.clock(on)
}

test('empty sections each use one concise line at 17, 30 and 46 columns', async ($, on) => {
  setup(on)
  for (const width of [17, 30, 46]) {
    const ui = await $.ui.mount(pane('dock', width, 30))
    const all = await ui.findAll({})
    const texts = all.filter(el => el.type === 'Text').map(el => el.text)
    expect(texts.filter(text => text.trim() === 'None yet.')).toHaveLength(2)
    expect(all.find(el => el.key === 'questions')?.props.height).toBe(1)
    expect(all.find(el => el.key === 'steps')?.props.height).toBe(1)
    expect(texts.join('\n')).not.toContain('track_question')
    expect(texts.join('\n')).not.toContain('approved plan steps')
    await ui.unmount()
  }
})

test('title, footer controls and banner respect the actual 17-column body', async ($, on) => {
  setup(on, [], [{ id: 'plan:1', source: 'plan', subject: 'Work', status: 'pending' }])
  const ui = await $.ui.mount(pane('dock', 17, 30))
  const texts = await ui.findAll({ type: 'Text' })
  const headerEnd = texts.findIndex(el => el.text === 'Questions')
  expect(texts.slice(0, headerEnd).reduce((n, el) => n + el.text.length, 0)).toBeLessThanOrEqual(17)
  expect((await ui.find({ key: 'banner' }))?.props.width).toBe(17)
  expect(texts.at(-1)?.text.length).toBeLessThanOrEqual(17)
  const hint = await ui.find({ key: 'hint-hide' })
  const close = await ui.find({ key: 'hint-close' })
  expect(hint?.text).toBe('/track hide')
  expect(close?.text).toBe('ctrl+x x close')
  for (const key of ['clear-steps-bottom', 'clear-completed-bottom']) {
    const button = await ui.find({ key })
    expect(String(button?.props.label).length + 3).toBeLessThanOrEqual(17)
  }
})

test('narrow questions put readable text above the unchanged Q/A controls', async ($, on) => {
  setup(on, [{ id: 1, head: 'שאלה ארוכה 😀 e\u0301 '.repeat(10), at: 1, turnId: 't', status: 'open', askedRequestId: 'question-1' }])
  const ui = await $.ui.mount(pane('dock', 17, 30))
  const row = await ui.find({ key: 'row-q-1' })
  expect(row?.props.flexDirection).toBe('column')
  const text = await ui.find({ key: 'q-text-1' })
  expect(text?.props.width).toBeGreaterThanOrEqual(13)
  expect(text?.props.width).toBeLessThanOrEqual(15)
  expect((await ui.find({ key: 'q-markers-1' }))?.props.width).toBe(13)
  const all = await ui.findAll({})
  expect(all.findIndex(el => el.key === 'q-text-1')).toBeLessThan(all.findIndex(el => el.key === 'q-markers-1'))
  expect((await ui.find({ key: 'q-1' }))?.props.hotkey).toBe('1')
  expect((await ui.find({ key: 'del-1' }))?.props.label).toBe('✕')
})

test('narrow counts fit on one item and clocks sit below step text', async ($, on) => {
  setup(on, [], Array.from({ length: 39 }, (_, i) => ({
    id: `plan:${i}`, source: 'plan', subject: 'A long step title to wrap',
    status: i < 12 ? 'completed' : 'pending', startedAt: 0, endedAt: 3_700_000,
  })))
  const ui = await $.ui.mount(pane('dock', 17, 30))
  const all = await ui.findAll({})
  expect(all.filter(el => el.type === 'Text').map(el => el.text)).toContain('◔ 12/39')
  const step = all.find(el => el.key?.startsWith('row-s-'))
  expect(step?.props.flexDirection).toBe('column')
  expect(all.find(el => el.key?.startsWith('s-clock-'))?.props.alignSelf).toBe('flex-end')
})

test('a narrow banner preserves each state without wrapping or clipping', async ($, on) => {
  const steps = [{ id: 'plan:1', source: 'plan', subject: 'Work', status: 'waiting' }]
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps })
  const activity = atomStore(on, 'activity', IDLE)
  const durability = atomStore(on, 'durability', { isUnsaved: false, reason: '' })
  mock.clock(on)
  for (const [status, wanted] of [['waiting', 'Waiting on you'], ['paused', 'Paused'], ['in_progress', 'Unknown']] as const) {
    ledger.value.steps[0].status = status
    const ui = await $.ui.mount(pane('dock', 17, 30))
    const banner = (await ui.findAll({ type: 'Text' })).at(-1)?.text ?? ''
    expect(banner).toContain(wanted)
    expect(banner.length).toBeLessThanOrEqual(17)
    await ui.unmount()
  }
  activity.value = { ...IDLE, isWorking: true, background: ['a', 'b'], tasks: ['x', 'y', 'z'] } as typeof IDLE
  for (const unsaved of [false, true]) {
    durability.value.isUnsaved = unsaved
    const ui = await $.ui.mount(pane('dock', 17, 30))
    const banner = (await ui.findAll({ type: 'Text' })).at(-1)?.text ?? ''
    expect(banner).toContain(unsaved ? 'Unsaved' : 'Working')
    expect(banner.length).toBeLessThanOrEqual(17)
    await ui.unmount()
  }
})
