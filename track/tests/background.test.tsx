import { expect, mock, test } from 'claude-code/testing'

import { EMPTY, atomStore, pane } from './kit'
import type { Engine } from './kit'

// Background work in the banner: a background shell task is not an agent. A hung shell and a
// Plannotator review gate (both Bash run in the background) read "Working · agents (1)" while no
// agent ran, and the person waited on agents that did not exist.

const IDLE = { isWorking: false, agentCalls: [] as string[], askCalls: [] as string[], background: [] as string[], tasks: [] as string[] }

type Drawn = { findAll: (q: { type: string }) => Promise<Array<{ text?: string }>> }

// mock.clock goes first in each test: the hooks beneath the plugins register before any $ call.
const bannerOf = async ($: Engine) => {
  const ui = (await $.ui.mount(pane('dock'))) as unknown as Drawn

  return (await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? '')).at(-1) ?? ''
}

test('a background shell task is counted as a task, not as an agent', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'activity', IDLE)
  atomStore(on, 'ledger', EMPTY)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { backgroundTaskId: 'b1' } }) as never)

  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_b', command: 'sleep 999', run_in_background: true } as never)

  const banner = await bannerOf($)
  expect(banner).not.toContain('agents')
  expect(banner).toContain('Waiting on tasks (1)')
})

test('a Stop sorts the work in flight into agents and tasks', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'activity', IDLE)
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  on('classic.Stop', () => ({}))

  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [
      { id: 'ag1', type: 'subagent', status: 'running', description: 'a review' },
      { id: 'b1', type: 'shell', status: 'running', description: 'a hung shell' },
      { id: 'b2', type: 'shell', status: 'running', description: 'plannotator annotate --gate' },
    ],
  } as never)

  const banner = await bannerOf($)
  expect(banner).toContain('Waiting on agents (1)')
  expect(banner).toContain('tasks (2)')
})

test('a running turn names its background agents and tasks apart', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'activity', { ...IDLE, isWorking: true, background: ['ag1'], tasks: ['b1'] })
  atomStore(on, 'ledger', EMPTY)

  expect(await bannerOf($)).toContain('Working · agents (1) · tasks (1)')
})

test('a finished shell task leaves the banner on its notification', async ($, on) => {
  mock.clock(on)
  const activity = atomStore(on, 'activity', { ...IDLE, tasks: ['b1'] })
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.prompt.submit({ text: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' } } as never)

  expect(activity.value.tasks).toEqual([])
})
