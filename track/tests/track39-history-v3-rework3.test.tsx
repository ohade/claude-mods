// FIXTURE: refuter r3 rows for the A1 history client. A committed resolve whose rows already match
// memory still acknowledges the same save intent, so a pane preference it carried is persisted or
// stays visibly pending, with no second root save. Save and resolve ok receipts follow the declared
// schema: save needs seq >= 1 and a lowercase SHA-256 hex root hash; resolve needs both keys, either
// both null (no root) or seq >= 1 with a hex hash; a truncated stderr is pending like a truncated stdout.
// The history.py model here is minimal: bind, read, save and resolve, keyed by session.
import { expect, mock, test } from 'claude-code/testing'
import type { PluginState, ProcessRunResult } from 'claude-code'
import type { Ledger } from '../types'
import { EMPTY, atomStore, blobPool, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'

const CONFIG = '/fixture/config'
const SESSION = '39393939-3333-4000-8000-000000000001'
const KEY = 'plugins--track_inline-a0b48c8b9db0'
const DRIVE_MS = 10000

type Pending = PluginState['track']['historyPending']
type Durability = PluginState['track']['durability']
type Root = { seq: number; generation: string; checkpoint: unknown; savedAt: number; text: string; hash: string }
type Options = {
  // The save with this ordinal commits, then its receipt is lost.
  loseReceipt?: (ordinal: number) => boolean
  // Replaces the ok receipt of a committed save.
  shapeSave?: (ordinal: number, response: Record<string, unknown>) => ProcessRunResult | undefined
  // Replaces the resolve answer; undefined keeps the model's own.
  shapeResolve?: (request: Record<string, unknown>, root: Root | undefined) => ProcessRunResult | undefined
  refuseSet?: (key: string) => string | undefined
}

const reply = (response: Record<string, unknown>, exitCode = 0, stderrTruncated = false): ProcessRunResult =>
  ({ exitCode, stdout: `${JSON.stringify(response)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: stderrTruncated })
const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('')

const fixture = (on: On, options: Options = {}) => {
  const clock = mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', structuredClone(EMPTY))
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'pane', { isOpen: false, hidden: false, closedByPerson: false, autoOpenDone: true })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'pulse', 0)
  const durability = atomStore(on, 'durability', { isUnsaved: false, reason: '' } as Durability)
  const historyPending = atomStore<Pending>(on, 'historyPending', null)
  const store = pluginStore(on, {}, undefined, { refuseSet: options.refuseSet })
  blobPool(on, { configDir: CONFIG })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: SESSION }))
  on('session.start', (_, event) => ({ cwd: event.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('env.get', { name: /^TRACK_HISTORY_V3$/ }, () => ({ value: '1' }))
  const lines = logs(on)
  const roots = new Map<string, Root>()
  const committed = new Set<string>()
  const ops: Array<{ op: string; request: Record<string, unknown> }> = []
  const saves: Array<Record<string, unknown>> = []
  on('process.run', { argv: /\/hooks\/history\.py$/ }, async (_, event) => {
    const op = String(event.argv[2])
    const request = JSON.parse(event.init!.stdin!) as Record<string, unknown>
    ops.push({ op, request })
    if (op === 'bind') return { value: reply({ ok: true, protocol: 3, op, store: KEY }) }
    if (op === 'read') {
      const root = roots.get(String(request.session_id))
      return { value: reply(root === undefined ? { ok: true, protocol: 3, op, state: 'absent' }
        : { ok: true, protocol: 3, op, state: 'valid', root: { seq: root.seq, generation: root.generation, checkpoint: root.checkpoint, savedAt: root.savedAt }, root_sha256: root.hash, ledger_text: root.text }) }
    }
    if (op === 'save') {
      saves.push(request)
      const ordinal = saves.length
      const session = String(request.session_id)
      const seq = (roots.get(session)?.seq ?? 0) + 1
      const text = String(request.ledger_text)
      const root = { seq, generation: String(request.generation), checkpoint: request.checkpoint, savedAt: Number(request.savedAt), text, hash: await digest(`${seq}:${text}`) }
      roots.set(session, root)
      committed.add(String(request.request_id))
      if (options.loseReceipt?.(ordinal) === true) throw new Error('fixture history receipt lost after commit')
      const response = { ok: true, protocol: 3, op, request_id: request.request_id, seq, root_sha256: root.hash }
      return { value: options.shapeSave?.(ordinal, response) ?? reply(response) }
    }
    if (op === 'resolve') {
      const root = roots.get(String(request.session_id))
      const shaped = options.shapeResolve?.(request, root)
      if (shaped !== undefined) return { value: shaped }
      return { value: committed.has(String(request.request_id))
        ? reply({ ok: true, protocol: 3, op, request_id: request.request_id, outcome: 'committed', seq: root!.seq, root_sha256: root!.hash })
        : reply({ ok: false, protocol: 3, op, request_id: request.request_id, phase: 'postcommit', reason: 'fixture outcome unknown' }, 1) }
    }
    return { value: reply({ ok: false, protocol: 3, op, phase: 'precommit', reason: 'fixture op unsupported' }, 1) }
  })
  // Sets the atom as a fresh version, as a write from the module would.
  const setDurability = (value: Durability) => {
    durability.value = value
    durability.version += 1
  }
  const setPending = (value: Pending) => {
    historyPending.value = value
    historyPending.version += 1
  }
  return { clock, ledger, durability, historyPending, setDurability, setPending, store, lines, roots, ops, saves }
}
type Fixture = ReturnType<typeof fixture>

const drive = async <T,>(f: Fixture, call: Promise<T>): Promise<T> => {
  let finished = false
  void call.then(() => { finished = true }, () => { finished = true })
  await f.clock.settle()
  if (!finished) await f.clock.advance(DRIVE_MS)
  return call
}
const call = ($: Engine, tool: string, fields: Record<string, unknown>) => $.tool.call({ tool: `mcp__track__${tool}`, ...fields } as never)
const text = (result: { result?: unknown; context?: unknown; deny?: unknown }) => `${String(result.result ?? '')}\n${String(result.deny ?? '')}\n${(Array.isArray(result.context) ? result.context : []).join('\n')}`
const opIndex = (f: Fixture, op: string, from = 0, requestId?: string) =>
  f.ops.findIndex((entry, index) => index >= from && entry.op === op && (requestId === undefined || entry.request.request_id === requestId))

// Saves A, then saves B carrying a person's pane close; B commits but its receipt is lost.
const lostSaveWithPreference = async ($: Engine, f: Fixture): Promise<string> => {
  await drive(f, call($, 'track_steps', { steps: ['A'] }))
  f.setDurability({ ...f.durability.value, isUnsaved: true, reason: 'pane preference save pending', closedByPerson: true })
  await drive(f, call($, 'track_steps', { steps: ['B'], after: 'plan:1' }))
  expect(f.saves.length, 'the lost save was attempted').toBe(2)
  const lost = String(f.saves[1]!.request_id)
  expect(f.historyPending.value?.request_id, 'the lost save is pending').toBe(lost)
  return lost
}

test('TRACK-39 V3 RW5a a committed resolve over matching rows persists the pane preference it carried, with no second root save', async ($, on) => {
  const f = fixture(on, { loseReceipt: ordinal => ordinal === 2 })
  const lost = await lostSaveWithPreference($, f)
  await drive(f, call($, 'checkpoint', { expected_session: SESSION }))
  expect(opIndex(f, 'resolve', 0, lost) >= 0, 'RW5a: the next save resolved the lost request').toBe(true)
  expect(f.historyPending.value, 'RW5a: the committed resolve cleared the pending record').toBe(null)
  expect(f.saves.length, 'RW5a: no second root save').toBe(2)
  expect(f.store.held.get('closedByPerson'), 'RW5a: the pane preference was persisted').toBe(true)
  expect(f.durability.value.isUnsaved, 'RW5a: clean only once the preference is saved').toBe(false)
})

test('TRACK-39 V3 RW5b a committed resolve over matching rows keeps a refused pane preference pending, with no second root save', async ($, on) => {
  const f = fixture(on, { loseReceipt: ordinal => ordinal === 2, refuseSet: key => key === 'closedByPerson' ? 'fixture preference refused' : undefined })
  const lost = await lostSaveWithPreference($, f)
  await drive(f, call($, 'checkpoint', { expected_session: SESSION }))
  expect(opIndex(f, 'resolve', 0, lost) >= 0, 'RW5b: the next save resolved the lost request').toBe(true)
  expect(f.saves.length, 'RW5b: no second root save').toBe(2)
  expect(f.durability.value.reason.startsWith('pane preference save pending'), 'RW5b: the refused preference stays pending').toBe(true)
  expect(f.durability.value.isUnsaved, 'RW5b: the state does not read clean').toBe(true)
  expect(f.durability.value.closedByPerson, 'RW5b: the preference is kept for the next save').toBe(true)
})

const HEX = 'a'.repeat(64)
const saveRows: Array<{ name: string; shape: (response: Record<string, unknown>) => ProcessRunResult }> = [
  { name: 'RW6a seq 0', shape: response => reply({ ...response, seq: 0 }) },
  { name: 'RW6b seq -1', shape: response => reply({ ...response, seq: -1 }) },
  { name: 'RW6c a non-hex root hash', shape: response => reply({ ...response, root_sha256: 'not-a-sha256-hash' }) },
  { name: 'RW6d a truncated stderr', shape: response => reply(response, 0, true) },
]
for (const row of saveRows) {
  test(`TRACK-39 V3 ${row.name}: an exit-0 ok save receipt with it stays pending`, async ($, on) => {
    const f = fixture(on, { shapeSave: (ordinal, response) => ordinal === 2 ? row.shape(response) : undefined })
    await drive(f, call($, 'track_steps', { steps: ['A'] }))
    const result = await drive(f, call($, 'track_steps', { steps: ['B'], after: 'plan:1' }))
    expect(f.saves.length, `${row.name}: the second save committed in the model`).toBe(2)
    expect(f.historyPending.value?.request_id, `${row.name}: the request stays pending`).toBe(String(f.saves[1]!.request_id))
    const shown = text(result as never)
    expect(shown.includes('save outcome pending'), `${row.name}: the tool reports the pending outcome`).toBe(true)
    expect(/unsaved/i.test(shown), `${row.name}: the tool never says unsaved`).toBe(false)
  })
}

const resolveRows: Array<{ name: string; fields: (root: Root) => Record<string, unknown> }> = [
  { name: 'RW7a a committed resolve without root_sha256', fields: root => ({ seq: root.seq }) },
  { name: 'RW7b a committed resolve without seq', fields: root => ({ root_sha256: root.hash }) },
  { name: 'RW7c a committed resolve with a null seq and a root hash', fields: root => ({ seq: null, root_sha256: root.hash }) },
  { name: 'RW7d a committed resolve with a seq and a null root hash', fields: root => ({ seq: root.seq, root_sha256: null }) },
]
for (const row of resolveRows) {
  test(`TRACK-39 V3 ${row.name} keeps the request pending and saves nothing new`, async ($, on) => {
    const f = fixture(on, { loseReceipt: ordinal => ordinal === 2,
      shapeResolve: (request, root) => reply({ ok: true, protocol: 3, op: 'resolve', request_id: request.request_id, outcome: 'committed', ...row.fields(root!) }) })
    await drive(f, call($, 'track_steps', { steps: ['A'] }))
    await drive(f, call($, 'track_steps', { steps: ['B'], after: 'plan:1' }))
    const lost = String(f.saves[1]!.request_id)
    const result = await drive(f, call($, 'track_steps', { steps: ['C'], after: 'plan:2' }))
    expect(opIndex(f, 'resolve', 0, lost) >= 0, `${row.name}: the next save ran a resolve`).toBe(true)
    expect(f.historyPending.value?.request_id, `${row.name}: the request stays pending`).toBe(lost)
    expect(f.saves.length, `${row.name}: no new save followed`).toBe(2)
    const shown = text(result as never)
    expect(shown.includes('save outcome pending'), `${row.name}: the tool reports the pending outcome`).toBe(true)
    expect(/unsaved/i.test(shown), `${row.name}: the tool never says unsaved`).toBe(false)
  })
}

test('TRACK-39 V3 RW7e a superseded resolve with both seq and root hash null (no root) is still accepted', async ($, on) => {
  const f = fixture(on, { shapeResolve: request => reply({ ok: true, protocol: 3, op: 'resolve', request_id: request.request_id, outcome: 'superseded', seq: null, root_sha256: null }) })
  f.setPending({ session_id: SESSION, request_id: 'lost-superseded', expect: { seq: 1, root_sha256: HEX } })
  await drive(f, call($, 'track_steps', { steps: ['A'] }))
  const resolved = opIndex(f, 'resolve', 0, 'lost-superseded')
  expect(resolved >= 0, 'RW7e: the save resolved the pending request').toBe(true)
  expect(f.historyPending.value, 'RW7e: the superseded resolve cleared the pending record').toBe(null)
  expect(f.saves.length, 'RW7e: the new save followed the resolve').toBe(1)
  expect(resolved < opIndex(f, 'save', 0), 'RW7e: resolve ran before the save').toBe(true)
})
