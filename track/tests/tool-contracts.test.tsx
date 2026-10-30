// FIXTURE: actual native registration payloads/order, frozen before the pure-owner move.
import { expect, mock, test } from 'claude-code/testing'
import { checksumOf } from '../hooks/checkpoint'
import { EMPTY, SESSION, atomStore, logs, pluginStore } from './kit'

// JSON object order is irrelevant; schema arrays and registration order are preserved.
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]))
}
const NAMES = ['track_question', 'mark_answered', 'track_steps', 'restore_tracker', 'checkpoint', 'lookup_rows', 'diagnose', 'reorder_steps', 'mark_step']

test('native tool registration preserves all discovery contracts and its lifecycle order', async ($, on) => {
  mock.clock(on)
  mock.env(on, { CLAUDE_CONFIG_DIR: '/fixture/config', TRACK_HISTORY_V3: '0' })
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  pluginStore(on)
  logs(on)
  const trace: string[] = []
  const payloads: Array<{ name: string; description: string; inputSchema?: Record<string, unknown>; isDeferred?: boolean }> = []
  on('tool.register', (_, e) => {
    trace.push(`tool:${e.name}`)
    payloads.push({ name: e.name, description: e.description, inputSchema: e.inputSchema,
      ...(e.isDeferred !== undefined && { isDeferred: e.isDeferred }) })
    return { value: { tool: `mcp__track__${e.name}` } }
  })
  on('command.register', (_, e) => { trace.push(`command:${e.name}`); return { value: { command: e.name } } })
  on('session.id', () => { trace.push('owner'); return { value: SESSION } })
  on('ui.panes', () => { trace.push('housekeeping'); return { value: [] } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(payloads.map(payload => payload.name)).toEqual(NAMES)
  expect(trace.slice(0, 10)).toEqual(['command:track', ...NAMES.map(name => `tool:${name}`)])
  expect(trace.indexOf('owner') > 9).toBe(true)
  expect(trace.indexOf('housekeeping') > trace.indexOf('owner')).toBe(true)
  expect(await checksumOf(canonical(payloads))).toBe('715855064492afda0f13a79c2b059a3b7ee478d0c023faec6e4ead4ccef71ee7')
  expect(payloads[0]!.inputSchema!.required).toEqual(['summary'])
  expect(payloads[1]!.inputSchema!.required).toEqual(['id', 'status'])
  expect(payloads[3]!.inputSchema!.required).toEqual(['from_session'])
  expect(payloads[4]!.inputSchema!.required).toEqual(['expected_session'])
  expect(payloads[8]!.inputSchema!.required).toEqual(['id', 'status'])
  expect((payloads[8]!.inputSchema!.properties as Record<string, { enum?: string[] }>).status!.enum).toEqual(['pending', 'in_progress', 'completed', 'paused', 'waiting'])
  expect((payloads[7]!.inputSchema!.properties as Record<string, { maxItems?: number }>).ids!.maxItems).toBe(300)
  expect(payloads.every(payload => payload.isDeferred === undefined)).toBe(true)
})
