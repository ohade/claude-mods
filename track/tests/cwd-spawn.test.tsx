// FIXTURE contract pin only: the native kit cannot delete cwd or run a child.
// helpers/check_cwd_spawn.ts separately exercises actual OS child processes.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

test('checkpoint lease and write helpers use the plugin root as their cwd', async ($, on) => {
  mock.clock(on)
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  const modes: string[] = []
  const store = pluginStore(on, {}, undefined, { beforeLockSpawn: request => {
    const root = request.argv[1].slice(0, -'/hooks/writer-lock.py'.length)
    expect(root.startsWith('/')).toBe(true)
    expect(request.cwd).toBe(root)
    modes.push(request.argv[2])
  } })
  on('session.id', () => ({ value: SESSION }))

  const result = await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)

  expect(JSON.parse(String(result.result)).ok).toBe(true)
  expect((store.held.get(`s:${SESSION}`) as { ledger: unknown }).ledger).toEqual(EMPTY)
  expect(modes).toEqual(['lease', 'write'])
})
