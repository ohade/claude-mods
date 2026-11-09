// FIXTURE: actual native registration payloads/order, frozen before the pure-owner move.
// The payload checksum includes the reviewed TRACK-30 mark_step extension (external_owner property
// and its description sentence); lifecycle and registration order are the pre-owner-move baseline.
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
  // 2026-11-09 (Ohad chose re-pointing with Codex review): only the summary and steps descriptions
  // changed, to ask for short one-line titles; was c9cde67a…24f3. Then the same two descriptions say
  // the pane shows two lines (Ohad allowed a second line); was 69aaca50…b00e.
  expect(await checksumOf(canonical(payloads))).toBe('b82d99a4569cc6f858248a3d6e8c4a7114504686c88b8b9cc1e8aa3baa78c286')
  expect(payloads[0]!.inputSchema!.required).toEqual(['summary'])
  expect(payloads[1]!.inputSchema!.required).toEqual(['id', 'status'])
  expect(payloads[3]!.inputSchema!.required).toEqual(['from_session'])
  expect(payloads[4]!.inputSchema!.required).toEqual(['expected_session'])
  expect(payloads[8]!.inputSchema!.required).toEqual(['id', 'status'])
  expect((payloads[8]!.inputSchema!.properties as Record<string, { enum?: string[] }>).status!.enum).toEqual(['pending', 'in_progress', 'completed', 'paused', 'waiting'])
  expect((payloads[7]!.inputSchema!.properties as Record<string, { maxItems?: number }>).ids!.maxItems).toBe(300)
  // TRACK-30: the local-owner declaration, pinned literally so the checksum is not its only guard.
  expect((payloads[8]!.inputSchema!.properties as Record<string, unknown>).external_owner).toEqual({ type: 'boolean',
    description: 'Only with delegated:true. Set false ONLY when every owner is a recorded local background task; true or an unknown declaration keeps external work nonblocking. Omission retains any prior declaration.' })
  expect(payloads[8]!.description).toContain('Set external_owner:false only when every owner is a recorded local background task.')
  expect(payloads.every(payload => payload.isDeferred === undefined)).toBe(true)
})
