// TRACK-14 part 3, 2026-10-12: the quieter Activity unknown banner is a design
// choice (grey background, subtle words) that keeps its explicit label.
// The reused-id prune tests moved to part 4: pruning must happen outside ui.render.
// FIXTURE: presentation state and render descriptions, not terminal pixels.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

const IDLE = { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] }
const step = { id: 'plan:1', source: 'plan', subject: 'Replacement step full title', status: 'pending' }

test('unknown activity uses a quiet grey banner while keeping its explicit label', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, steps: [{ ...step, status: 'in_progress' }] })
  atomStore(on, 'activity', IDLE)
  const ui = await $.ui.mount(pane('dock', 60, 30))
  const banner = await ui.find({ key: 'banner-unknown' })
  expect(banner?.props.backgroundColor).toBe('#5f6670')
  expect(banner?.text).toContain('Activity unknown')
  expect((banner?.children as Array<{ type?: string; props?: { color?: string } }>)?.find(child => child.type === 'Text')?.props?.color).toBe('subtle')
  await ui.unmount()
})
