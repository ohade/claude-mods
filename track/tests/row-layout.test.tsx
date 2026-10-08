// FIXTURE: tree geometry, not painted pixels. Observed 2026-10-08:
// native Fragment is a column Box. Using it inside a row stacked the status,
// labels and controls, so the measured region clipped saved questions/steps.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] }

test('wide question controls and title are siblings on the same horizontal row', async ($, on) => {
  atomStore(on, 'ledger', { ...EMPTY, questions: [{ id: 1, head: 'A complete question title', at: 1, turnId: 't', status: 'open' }] })
  atomStore(on, 'activity', IDLE)
  mock.clock(on)
  const ui = await $.ui.mount(pane('dock', 80, 40))
  const row = await ui.find({ key: 'row-q-1' })
  const children = row?.children as Array<{ props?: { key?: string } }>
  expect(children.some(child => child.props?.key === 'q-markers-1')).toBe(true)
  expect(children.some(child => child.props?.key === 'q-text-1')).toBe(true)
  expect(children.some(child => child.props?.key === 'del-1')).toBe(true)
})

test('four short steps use four horizontal rows, with a fixed status column', async ($, on) => {
  atomStore(on, 'ledger', { ...EMPTY, steps: Array.from({ length: 4 }, (_, i) => ({
    id: `plan:${i + 1}`, source: 'plan', subject: `Work item ${i + 1}`, status: i < 3 ? 'completed' : 'paused',
  })) })
  atomStore(on, 'activity', IDLE)
  mock.clock(on)
  const ui = await $.ui.mount(pane('dock', 80, 40))
  expect((await ui.find({ key: 'steps' }))?.props.height).toBe(4)
  for (let i = 1; i <= 4; i++) {
    const row = await ui.find({ key: `row-s-plan:${i}` })
    const children = row?.children as Array<{ props?: { key?: string; width?: number; flexShrink?: number } }>
    expect(children.some(child => child.props?.key === `s-text-plan:${i}`)).toBe(true)
    const status = children.find(child => child.props?.key === `s-status-plan:${i}`)
    expect(status?.props?.width).toBe(2)
    expect(status?.props?.flexShrink).toBe(0)
    expect(row?.text).toContain(`S${i}. Work item ${i}`)
  }
})

test('a narrow question uses exactly two explicit horizontal groups', async ($, on) => {
  atomStore(on, 'ledger', { ...EMPTY, questions: [{ id: 1, head: 'Narrow question', at: 1, turnId: 't', status: 'open' }] })
  atomStore(on, 'activity', IDLE)
  mock.clock(on)
  const ui = await $.ui.mount(pane('dock', 17, 40))
  const row = await ui.find({ key: 'row-q-1' })
  const children = row?.children as Array<{ type?: string; props?: { flexDirection?: string } }>
  expect(children).toHaveLength(2)
  expect(children.every(child => child.type === 'Box' && child.props?.flexDirection === 'row')).toBe(true)
})
