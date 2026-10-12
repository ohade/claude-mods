import { expect, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

// Fable mutation M5 (2026-10-11): swapping the eviction passes escaped the suite.
test('at the steps cap, a cleared middle row goes before an older completed row', async ($, on) => {
  const steps = Array.from({ length: 300 }, (_, i) => ({
    id: `plan:${i + 1}`, source: 'plan', subject: `Step ${i + 1}`,
    status: i === 0 || i === 149 ? 'completed' : 'pending',
    ...(i === 149 && { cleared: true as const }),
  }))
  const ledger = atomStore(on, 'ledger', { ...EMPTY, steps })
  pluginStore(on)
  on('session.id', () => ({ value: SESSION }))

  await $.tool.call({ tool: 'mcp__track__track_steps', steps: ['New work'], after: 'plan:300' } as never)

  const ids = ledger.value.steps.map(s => s.id)
  expect(ids).toHaveLength(300)
  expect(ids).toContain('plan:1')
  expect(ids).not.toContain('plan:150')
  expect(ledger.value.steps.at(-1)?.subject).toBe('New work')
  expect(ids.filter(id => id !== 'plan:1' && id !== 'plan:301')).toHaveLength(298)
})
