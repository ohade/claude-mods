// FIXTURE: an account view. A second account runs with CLAUDE_CONFIG_DIR set to its own folder, and
// that folder links `state` to the canonical setup's state folder. The lock helpers refuse a link
// below the config they are given, so the module must hand them the folder that owns the real state.
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, SESSION, atomStore, pluginStore } from './kit'

const VIEW = '/fixture/accounts/personal'
const CANONICAL = '/fixture/home/.claude'

const prepare = (on: any, state: { isLink: boolean; realPath: string }) => {
  mock.clock(on)
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  mock.env(on, { CLAUDE_CONFIG_DIR: VIEW })
  on('fs.stat', (_: unknown, e: { path?: unknown }) => (e.path === `${VIEW}/state`
    ? { value: { kind: 'dir', size: 0, mtimeMs: 0, ...state } }
    : { deny: 'fixture: no such file' }) as never)
  on('session.id', () => ({ value: SESSION }))
  return pluginStore(on)
}

// Every lock helper this save started, by the config it was given.
const lockConfigs = (store: ReturnType<typeof pluginStore>) => [...new Set(store.locks.spawns.map(spawn => spawn.env?.CLAUDE_CONFIG_DIR))]

const checkpoint = async ($: any) => JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: SESSION } as never)).result))

test('a linked state folder moves the lock helpers to the config that owns the real folder', async ($, on) => {
  const store = prepare(on, { isLink: true, realPath: `${CANONICAL}/state` })
  expect((await checkpoint($)).ok).toBe(true)
  expect(lockConfigs(store)).toEqual([CANONICAL])
})

test('a link that does not lead to a folder named state keeps the selected config', async ($, on) => {
  const store = prepare(on, { isLink: true, realPath: '/fixture/elsewhere/destination' })
  expect((await checkpoint($)).ok).toBe(true)
  expect(lockConfigs(store)).toEqual([VIEW])
})

test('a real state folder keeps the selected config', async ($, on) => {
  const store = prepare(on, { isLink: false, realPath: `${VIEW}/state` })
  expect((await checkpoint($)).ok).toBe(true)
  expect(lockConfigs(store)).toEqual([VIEW])
})
