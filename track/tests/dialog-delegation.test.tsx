// FIXTURE: a question dialog blocks main work, while explicitly delegated work continues.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, atomStore, pane } from './kit'

test('delegated work pulses while an open dialog blocks an in-progress main row', async ($, on) => {
  const clock = mock.clock(on)
  atomStore(on, 'ledger', { ...EMPTY, steps: [
    { id: 'plan:1', source: 'plan', subject: 'Wait for dialogue', status: 'in_progress' },
    { id: 'plan:2', source: 'plan', subject: 'Peer work', status: 'in_progress', delegated: true },
  ] })
  atomStore(on, 'activity', { isWorking: true, agentCalls: [], askCalls: ['toolu_ask'], background: [], tasks: [] })
  const phase = atomStore(on, 'pulse', 0)
  const ui = await $.ui.mount(pane('dock', 80))
  const rows = (await ui.findAll({ type: 'Box' })).filter(el => String(el.key ?? '').startsWith('banner-')).map(el => String(el.text ?? '')).join(' ')
  expect(rows).toContain('Waiting on you')
  expect(rows).toContain('Agents')
  await clock.advance(1300)
  expect(phase.writes.length).toBeGreaterThanOrEqual(2)
  const texts = await ui.findAll({ type: 'Text' })
  const at = texts.findIndex(t => t.text === 'S1. Wait for dialogue')
  expect(texts[at - 1]?.text).toBe('◐')
  expect(texts.filter(t => t.text === '⧗')).toHaveLength(2)
  expect(texts.filter(t => t.text === '◆')).toHaveLength(1)
})
