// TRACK-14 4c2, 2026-10-13: removed/replaced rows retained presentation state.
// Approved D rewrite: actual mutation handlers prune; renders must only draw.
// FIXTURE: native descriptions/dispatch and stored rows, not terminal pixels.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'
import { detailPosition } from './pane-detail-assertions'

type Step = { id: string; source: string; subject: string; status: string; taskId?: string; cleared?: true }
type Question = { id: number; head: string; at: number; turnId: string; status: string; cleared?: true }
type PaneUI = Awaited<ReturnType<Engine['ui']['mount']>>
const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] }
const title = 'Inspect every marked edge of the original folded bracket drawing and record the complete alignment result before continuing. '.repeat(2).slice(0, 180)
const question: Question = { id: 1, head: title, at: 1, turnId: 't', status: 'open' }
const step: Step = { id: 'plan:1', source: 'plan', subject: title, status: 'pending' }
const OLD_SESSION = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'

const setup = (on: On, steps: Step[] = [step], questions: Question[] = [question]) => {
  mock.clock(on)
  on('session.id', () => ({ value: SESSION }))
  const ledger = atomStore(on, 'ledger', { ...EMPTY, session_id: SESSION, steps, questions })
  const reveal = atomStore<Record<string, 'q' | 'a' | undefined>>(on, 'reveal', { '1': 'q', 'step:plan:1': 'q' })
  const anchors = atomStore<Record<string, { source: string; offset: number } | undefined>>(on, 'detailAnchors', {
    'q:1': { source: title, offset: 40 }, 'step:plan:1': { source: title, offset: 40 },
  })
  atomStore(on, 'activity', IDLE)
  const store = pluginStore(on)
  return { ledger, reveal, anchors, store }
}

const snapshot = (held: ReturnType<typeof setup>) => ({
  ledger: JSON.stringify(held.ledger.value), ledgerWrites: held.ledger.writes.length,
  reveal: JSON.stringify(held.reveal.value), revealWrites: held.reveal.writes.length,
  anchors: JSON.stringify(held.anchors.value), anchorWrites: held.anchors.writes.length,
  store: JSON.stringify([...held.store.held]),
})
const renderDoesNotWrite = async (ui: PaneUI, held: ReturnType<typeof setup>) => {
  const before = snapshot(held)
  await ui.redraw()
  expect(snapshot(held)).toEqual(before)
}
const closed = async (ui: PaneUI, kind: 'q' | 's', id: string | number) => {
  for (const key of [`detail-${kind}-${id}`, `detail-page-${kind}-${id}`, `detail-controls-${kind}-${id}`]) {
    expect(await ui.find({ key })).toBeUndefined()
  }
}
const pruned = (held: ReturnType<typeof setup>, kind: 'q' | 's', id: string | number) => {
  expect(Object.hasOwn(held.reveal.value, kind === 'q' ? String(id) : `step:${id}`)).toBe(false)
  expect(Object.hasOwn(held.anchors.value, kind === 'q' ? `q:${id}` : `step:${id}`)).toBe(false)
}

for (const cleared of [false, true]) test(`${cleared ? 'cleared' : 'removed'} title selections are pruned by handlers and reused ids start closed`, async ($, on) => {
  const held = setup(on, [{ ...step, status: cleared ? 'completed' : 'pending' }], [{ ...question, status: cleared ? 'answered' : 'open' }])
  const ui = await $.ui.mount(pane('dock', 60, 30))
  expect((await ui.find({ key: cleared ? 'clear-answered' : 'del-1' }))?.type).toBe('Button')
  await ui.press({ key: cleared ? 'clear-answered' : 'del-1' })
  if (cleared) expect(held.ledger.value.questions[0].cleared).toBe(true)
  else expect(held.ledger.value.questions).toHaveLength(0)
  pruned(held, 'q', 1)
  // Pruning one section must retain the other selection and its source anchor.
  expect(held.reveal.value['step:plan:1']).toBe('q')
  expect(held.anchors.value['step:plan:1']?.offset).toBe(40)
  await ui.press({ key: cleared ? 'clear-completed' : 'clear-steps' })
  if (cleared) expect(held.ledger.value.steps[0].cleared).toBe(true)
  else expect(held.ledger.value.steps).toHaveLength(0)
  pruned(held, 's', 'plan:1')
  await renderDoesNotWrite(ui, held)
  // Fixture reuse deliberately supplies the same ids and source text.
  held.ledger.value = { ...EMPTY, session_id: SESSION, steps: [{ ...step }], questions: [{ ...question }] }
  await ui.redraw()
  await closed(ui, 'q', 1)
  await closed(ui, 's', 'plan:1')
  await renderDoesNotWrite(ui, held)
  await ui.unmount()
})

for (const section of ['questions', 'steps'] as const) test(`clear all ${section} removes only its selection and anchor`, async ($, on) => {
  const held = setup(on)
  const ui = await $.ui.mount(pane('dock', 60, 30))
  await ui.press({ key: `clear-${section}` })
  const q = section === 'questions'
  expect(held.ledger.value[section]).toHaveLength(0)
  pruned(held, q ? 'q' : 's', q ? 1 : 'plan:1')
  expect(held.reveal.value[q ? 'step:plan:1' : '1']).toBe('q')
  expect(held.anchors.value[q ? 'step:plan:1' : 'q:1']?.offset).toBe(40)
  await renderDoesNotWrite(ui, held)
  await ui.unmount()
})

test('successful Task deletion prunes the removed task but retains a linked plan row', async ($, on) => {
  const task = { ...step, id: 'task:7', source: 'task', taskId: '7' }
  const held = setup(on, [task, { ...step, taskId: '7' }], [])
  held.reveal.value = { 'step:task:7': 'q' }
  held.anchors.value = { 'step:task:7': { source: title, offset: 100 } }
  on('tool.call', { tool: 'TaskUpdate' }, () => ({ result: { success: true } }))
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'deleted' })
  expect(held.ledger.value.steps.map(row => row.id)).toEqual(['plan:1'])
  expect(held.ledger.value.steps[0].taskId).toBeUndefined()
  pruned(held, 's', 'task:7')
  const ui = await $.ui.mount(pane('dock', 60, 30))
  await renderDoesNotWrite(ui, held)
  await ui.unmount()
})

test('TodoWrite removal prunes its title and page state while leaving other sources open', async ($, on) => {
  const todo = { ...step, id: 'todo:inspect', source: 'todo' }
  const held = setup(on, [todo, step])
  held.reveal.value = { 'step:todo:inspect': 'q', '1': 'q' }
  held.anchors.value = { 'step:todo:inspect': { source: title, offset: 100 }, 'q:1': { source: title, offset: 40 } }
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [{ content: 'Inspect', status: 'pending' }], newTodos: [] } }))
  await $.tool.call({ tool: 'TodoWrite', todos: [] })
  expect(held.ledger.value.steps.map(row => row.id)).toEqual(['plan:1'])
  pruned(held, 's', todo.id)
  expect(held.reveal.value['1']).toBe('q')
  expect(held.anchors.value['q:1']?.offset).toBe(40)
  const ui = await $.ui.mount(pane('dock', 60, 30))
  await renderDoesNotWrite(ui, held)
  await ui.unmount()
})

test('an explicit same-title plan replacement closes reused ids even when saved rows are identical', async ($, on) => {
  const held = setup(on)
  const ui = await $.ui.mount(pane('dock', 60, 30))
  const original = JSON.stringify(held.ledger.value.steps)
  await $.tool.call({ tool: 'mcp__track__track_steps', steps: [title] } as never)
  expect(JSON.stringify(held.ledger.value.steps)).toBe(original)
  pruned(held, 's', 'plan:1')
  expect(held.reveal.value['1']).toBe('q')
  expect(held.anchors.value['q:1']?.offset).toBe(40)
  await ui.redraw()
  await closed(ui, 's', 'plan:1')
  await renderDoesNotWrite(ui, held)
  await ui.unmount()
})

test('restore replacement closes the old plan selection even when its id and text recur', async ($, on) => {
  const held = setup(on, [step], [])
  held.store.held.set(`s:${OLD_SESSION}`, { v: 1, savedAt: 1, ledger: { ...EMPTY, steps: [step] } })
  const ran = await $.tool.call({ tool: 'mcp__track__restore_tracker', from_session: OLD_SESSION, replace: true } as never)
  expect(ran.deny).toBeUndefined()
  expect(held.ledger.value.steps.map(row => row.id)).toEqual(['plan:1'])
  expect(held.ledger.value.steps[0].subject).toBe(title)
  pruned(held, 's', 'plan:1')
  const ui = await $.ui.mount(pane('dock', 60, 30))
  await closed(ui, 's', 'plan:1')
  await renderDoesNotWrite(ui, held)
  await ui.unmount()
})

test('status-only updates retain the selected source and a nonzero page anchor', async ($, on) => {
  const held = setup(on, [step], [])
  held.reveal.value = {}
  held.anchors.value = {}
  const ui = await $.ui.mount(pane('dock', 60, 12))
  await ui.press({ key: 'title-s-plan:1' })
  expect((await detailPosition(ui, 's', 'plan:1')).total).toBeGreaterThan(1)
  await ui.press({ key: 'detail-next-s-plan:1' })
  const anchor = held.anchors.value['step:plan:1']
  expect(anchor?.offset).toBeGreaterThan(0)
  await $.tool.call({ tool: 'mcp__track__mark_step', id: 'plan:1', status: 'paused' } as never)
  expect(held.ledger.value.steps[0].status).toBe('paused')
  expect(held.reveal.value['step:plan:1']).toBe('q')
  expect(held.anchors.value['step:plan:1']).toEqual(anchor)
  await renderDoesNotWrite(ui, held)
  await ui.unmount()
})

test('a refused Task deletion changes neither presentation state nor saved rows', async ($, on) => {
  const task = { ...step, id: 'task:7', source: 'task', taskId: '7' }
  const held = setup(on, [task], [])
  held.reveal.value = { 'step:task:7': 'q' }
  held.anchors.value = { 'step:task:7': { source: title, offset: 100 } }
  on('tool.call', { tool: 'TaskUpdate' }, () => ({ result: { success: false } }))
  const before = snapshot(held)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'deleted' })
  expect(snapshot(held)).toEqual(before)
})

test('a stale title Button cannot open a replacement row with the same id', async ($, on) => {
  const held = setup(on, [step], [])
  held.reveal.value = {}
  held.anchors.value = {}
  const ui = await $.ui.mount(pane('dock', 60, 12))
  expect((await ui.find({ key: 'title-s-plan:1' }))?.type).toBe('Button')
  // Changing the fixture backing value causes no state event or new frame.
  // The press therefore invokes the control bound to the old displayed source.
  held.ledger.value = { ...held.ledger.value, steps: [{ ...step, subject: `Replacement ${title}` }] }
  await ui.press({ key: 'title-s-plan:1' })
  expect(held.reveal.value['step:plan:1']).toBeUndefined()
  expect(held.anchors.value['step:plan:1']).toBeUndefined()
  await closed(ui, 's', 'plan:1')
  expect(held.ledger.writes).toHaveLength(0)
  await renderDoesNotWrite(ui, held)
  await ui.unmount()
})
