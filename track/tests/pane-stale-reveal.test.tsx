// TRACK-14 4c1-fix round 2, 2026-10-13: a stored reveal without its source
// anchor drew a question head twice, and the first title press closed instead
// of opening. At 24-29 columns an opened step paged 1-3 graphemes per line.
// FIXTURE: emitted native tree and dispatch, not terminal pixels.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'
import { detailPosition } from './pane-detail-assertions'

const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] }
const NOW = 1_800_000_000_000
const source = Array.from({ length: 80 }, (_, i) => `edge${String(i).padStart(3, '0')}`).join(' ').slice(0, 420)

test('a stale question reveal without an anchor draws the head once and the first title press opens pages', async ($, on) => {
  mock.clock(on)
  const head = 'Which database should we migrate first'
  const ledger = atomStore(on, 'ledger', { ...EMPTY, questions: [{ id: 1, head, at: 1, turnId: 't', status: 'open' }] })
  atomStore(on, 'reveal', { '1': 'q' })
  atomStore(on, 'detailAnchors', {})
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', 60, 20))
  const drawn = (await ui.findAll({ type: 'Text' })).filter(text => String(text.text ?? '').includes('Which database'))
  expect(drawn).toHaveLength(1)
  await ui.press({ key: 'title-q-1' })
  expect(await ui.find({ key: 'detail-page-q-1' })).toBeDefined()
  expect((await detailPosition(ui, 'q', 1)).page).toBe(1)
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})

test('a stale step reveal without an anchor draws closed and the first title press opens pages', async ($, on) => {
  mock.clock(on)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: [{ id: 'plan:1', source: 'plan', subject: source, status: 'pending' }] })
  atomStore(on, 'reveal', { 'step:plan:1': 'q' })
  atomStore(on, 'detailAnchors', {})
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', 60, 20))
  expect(await ui.find({ key: 'detail-page-s-plan:1' })).toBeUndefined()
  await ui.press({ key: 'title-s-plan:1' })
  expect(await ui.find({ key: 'detail-page-s-plan:1' })).toBeDefined()
  expect((await detailPosition(ui, 's', 'plan:1')).page).toBe(1)
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})

for (const width of [24, 26]) test(`an opened step shows at least six source graphemes per first line, or metadata below, at ${width} columns`, async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(NOW)
  atomStore(on, 'ledger', { ...EMPTY, steps: [{ id: 'plan:1', source: 'plan', subject: source, status: 'in_progress', startedAt: NOW - 65_000 }] })
  atomStore(on, 'activity', { ...IDLE, isWorking: true })
  const ui = await $.ui.mount(pane('dock', width, 12))
  await ui.press({ key: 'title-s-plan:1' })
  const total = (await detailPosition(ui, 's', 'plan:1')).total
  for (let page = 1; page < total; page++) {
    if (await ui.find({ key: 's-detail-meta-plan:1' }) === undefined) {
      const first = String((await ui.find({ key: 's-text-plan:1' }))?.text ?? '')
      expect(first.startsWith('S1. ')).toBe(true)
      expect(Array.from(first.slice('S1. '.length)).length).toBeGreaterThanOrEqual(6)
    }
    await ui.press({ key: 'detail-next-s-plan:1' })
  }
  await ui.unmount()
})
