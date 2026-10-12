// TRACK-14 4b correction 1, 2026-10-12: decorative frames must not
// appear or disappear when the running clock changes its displayed width.
// FIXTURE: native descriptions/virtual time, not terminal paint.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const START = 1_800_000_000_000

test('a running clock crossing 59m to 1h does not toggle either section frame', async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(START + 3_599_000)
  const step = { id: 'plan:1', source: 'plan', subject: 'Measured work', status: 'in_progress', startedAt: START }
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps: [step] })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: [], background: [], tasks: [] })
  const ui = await $.ui.mount(pane('dock', 60, 30))
  const frames = async () => Promise.all(['questions-frame', 'steps-frame'].map(async key =>
    (await ui.find({ key }))?.props.borderStyle === 'round'))
  expect((await ui.findAll({ type: 'Text' })).map(el => el.text)).toContain('59m')
  const before = await frames()
  await clock.advance(1_000)
  await ui.redraw()
  expect((await ui.findAll({ type: 'Text' })).map(el => el.text)).toContain('1h 00m')
  expect(await frames()).toEqual(before)
  expect(ledger.value.steps).toEqual([step])
  expect(ledger.writes).toHaveLength(0)
  await ui.unmount()
})
