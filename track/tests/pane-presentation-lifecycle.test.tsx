// TRACK-14 4c1-fix items 11-12: resume/adoption left another ledger selected.
// FIXTURE: owned native resume, stored rows and callback interleaving.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, logs, pane, pluginStore } from './kit'

const OTHER = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] }
const oldHead = 'Old question from the previous source connection'
const oldTitle = 'Old step from the previous source connection'
const oldRows = {
  ...EMPTY, nextQuestionId: 2,
  questions: [{ id: 1, head: oldHead, at: 1, turnId: 't', status: 'open' }],
  steps: [{ id: 'plan:1', source: 'plan', subject: oldTitle, status: 'pending' }],
}
const savedRows = {
  ...oldRows,
  questions: [{ ...oldRows.questions[0], head: 'Resumed question from the new source connection' }],
  steps: [{ ...oldRows.steps[0], subject: 'Resumed step from the new source connection' }],
}

for (const path of ['session-switch', 'resume', 'conflict-adoption']) test(`${path} clears selection and anchors before reused ids are drawn`, async ($, on) => {
  mock.clock(on)
  const destination = path === 'session-switch' ? OTHER : SESSION
  const initial = path === 'resume' ? { ...EMPTY, session_id: SESSION } : { ...oldRows, session_id: SESSION }
  const ledger = atomStore(on, 'ledger', initial as typeof savedRows & { session_id: string })
  const reveal = atomStore(on, 'reveal', { '1': 'q', 'step:plan:1': 'q' })
  const anchors = atomStore(on, 'detailAnchors', { 'q:1': { source: oldHead, offset: 20 }, 'step:plan:1': { source: oldTitle, offset: 20 } })
  const store = pluginStore(on, { [`s:${destination}`]: { v: 1, session_id: destination, savedAt: 1, ledger: { ...savedRows, session_id: destination } } })
  atomStore(on, 'activity', IDLE)
  on('session.id', () => ({ value: destination }))
  on('classic.SessionStart', () => ({}))
  logs(on)
  await $.classic.SessionStart({ source: 'resume', session_id: destination } as never)
  expect(ledger.value.session_id).toBe(destination)
  expect(ledger.value.steps[0].subject).toBe(savedRows.steps[0].subject)
  expect(ledger.value.questions[0].head).toBe(savedRows.questions[0].head)
  if (path === 'conflict-adoption') expect([...store.held.keys()].some(key => key.startsWith(`r:${destination}:conflict-`))).toBe(true)
  expect(reveal.value).toEqual({})
  expect(anchors.value).toEqual({})
  const before = { ledger: ledger.writes.length, reveal: reveal.writes.length, anchors: anchors.writes.length }
  const ui = await $.ui.mount(pane('dock', 60, 30))
  for (const key of ['detail-page-q-1', 'detail-page-s-plan:1']) expect(await ui.find({ key })).toBeUndefined()
  await ui.redraw()
  expect({ ledger: ledger.writes.length, reveal: reveal.writes.length, anchors: anchors.writes.length }).toEqual(before)
  await ui.unmount()
})

test('a question status-only update retains its source selection and anchor', async ($, on) => {
  mock.clock(on)
  const ledger = atomStore(on, 'ledger', oldRows)
  const reveal = atomStore(on, 'reveal', { '1': 'q' })
  const original = { 'q:1': { source: oldHead, offset: 20 } }
  const anchors = atomStore(on, 'detailAnchors', original)
  pluginStore(on)
  logs(on)
  await $.tool.call({ tool: 'mcp__track__mark_answered', id: 1, status: 'deferred', note: 'Waiting for source review' } as never)
  expect(ledger.value.questions[0].status).toBe('deferred')
  expect(reveal.value).toEqual({ '1': 'q' })
  expect(anchors.value).toEqual(original)
})

test('a replacement during the reveal compare-and-set cannot open the new source', async ($, on) => {
  mock.clock(on)
  const ledger = atomStore(on, 'ledger', { ...oldRows, questions: [] })
  atomStore(on, 'activity', IDLE)
  const anchors = atomStore<Record<string, { source: string; offset: number } | undefined>>(on, 'detailAnchors', {})
  let selected: Record<string, 'q' | 'a' | undefined> = {}
  let version = 1
  let replaceOnRead = false
  on('state.get', { plugin: 'track', key: 'reveal' }, () => {
    if (replaceOnRead) {
      replaceOnRead = false
      ledger.value = { ...ledger.value, steps: [{ ...oldRows.steps[0], subject: savedRows.steps[0].subject }] }
    }
    return { value: { value: selected, version } }
  })
  on('state.set', { plugin: 'track', key: 'reveal' }, (_, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false as const, version } }
    selected = e.value as typeof selected
    version++
    return { value: { isSet: true as const, version } }
  })
  const ui = await $.ui.mount(pane('dock', 60, 30))
  expect((await ui.find({ key: 'title-s-plan:1' }))?.type).toBe('Button')
  replaceOnRead = true
  await ui.press({ key: 'title-s-plan:1' })
  expect(selected['step:plan:1']).toBeUndefined()
  expect(anchors.value['step:plan:1']).toBeUndefined()
  expect(await ui.find({ key: 'detail-page-s-plan:1' })).toBeUndefined()
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})
