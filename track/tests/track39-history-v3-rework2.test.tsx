// FIXTURE: refuter r2 rows for the A1 history client. A pending save outcome never reads as "Unsaved"
// on the pane banner; resume, checkpoint and restore_tracker resolve a pending record that names the
// routed session before they read it; the flag-off checkpoint lets a legacy store read throw as at
// base; an exit-0 ok save receipt without its seq and root hash stays pending and is resolved first.
// The history.py model here is minimal: bind, read, save and resolve, keyed by session.
import { expect, mock, test } from 'claude-code/testing'
import type { PluginState, ProcessRunResult } from 'claude-code'
import type { Ledger } from '../types'
import { describeCheckpoint } from '../hooks/checkpoint'
import { EMPTY, atomStore, blobPool, logs, pane, pluginStore } from './kit'
import type { Engine, On } from './kit'

const CONFIG = '/fixture/config'
const SESSION = '39393939-2222-4000-8000-000000000001'
const FOREIGN = '39393939-2222-4000-8000-000000000002'
const KEY = 'plugins--track_inline-a0b48c8b9db0'
const DRIVE_MS = 10000

type Pending = PluginState['track']['historyPending']
type Root = { seq: number; generation: string; checkpoint: unknown; savedAt: number; text: string; hash: string }
type Options = {
  rejectSave?: (ordinal: number) => boolean
  malformedSave?: (ordinal: number) => boolean
  historyPending?: Pending
  beforeGet?: (key: string) => void
  onFlagRead?: () => void
}

const reply = (response: Record<string, unknown>, exitCode = 0): ProcessRunResult =>
  ({ exitCode, stdout: `${JSON.stringify(response)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('')

const fixture = (on: On, options: Options = {}) => {
  const clock = mock.clock(on)
  const ledger = atomStore<Ledger>(on, 'ledger', structuredClone(EMPTY))
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'pane', { isOpen: false, hidden: false, closedByPerson: false, autoOpenDone: true })
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'pulse', 0)
  const durability = atomStore(on, 'durability', { isUnsaved: false, reason: '' } as PluginState['track']['durability'])
  const historyPending = atomStore<Pending>(on, 'historyPending', options.historyPending ?? null)
  const store = pluginStore(on, {}, undefined, { beforeGet: options.beforeGet })
  blobPool(on, { configDir: CONFIG })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: SESSION }))
  on('session.start', (_, event) => ({ cwd: event.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  const flag = { value: '1' as string | undefined }
  on('env.get', { name: /^TRACK_HISTORY_V3$/ }, () => {
    options.onFlagRead?.()
    return { value: flag.value }
  })
  const lines = logs(on)
  const roots = new Map<string, Root>()
  const committed = new Set<string>()
  const ops: Array<{ op: string; request: Record<string, unknown> }> = []
  const saves: Array<Record<string, unknown>> = []
  const held = new Map<number, Promise<void>>()
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
      await held.get(ordinal)
      if (options.rejectSave?.(ordinal) === true) throw new Error('fixture history receipt lost before commit')
      const session = String(request.session_id)
      const seq = (roots.get(session)?.seq ?? 0) + 1
      const text = String(request.ledger_text)
      const root = { seq, generation: String(request.generation), checkpoint: request.checkpoint, savedAt: Number(request.savedAt), text, hash: await digest(`${seq}:${text}`) }
      roots.set(session, root)
      committed.add(String(request.request_id))
      if (options.malformedSave?.(ordinal) === true) return { value: reply({ ok: true, protocol: 3, op, request_id: request.request_id }) }
      return { value: reply({ ok: true, protocol: 3, op, request_id: request.request_id, seq, root_sha256: root.hash }) }
    }
    if (op === 'resolve') {
      return { value: committed.has(String(request.request_id))
        ? reply({ ok: true, protocol: 3, op, request_id: request.request_id, outcome: 'committed', seq: roots.get(String(request.session_id))!.seq, root_sha256: roots.get(String(request.session_id))!.hash })
        : reply({ ok: false, protocol: 3, op, request_id: request.request_id, phase: 'postcommit', reason: 'fixture outcome unknown' }, 1) }
    }
    return { value: reply({ ok: false, protocol: 3, op, phase: 'precommit', reason: 'fixture op unsupported' }, 1) }
  })
  // Holds the save with this ordinal until the returned release runs.
  const holdSave = (ordinal: number): (() => void) => {
    let release = () => {}
    held.set(ordinal, new Promise<void>(resolve => { release = resolve }))
    return () => release()
  }
  const seedRoot = async (session: string, subjects: string[]) => {
    const rows: Ledger = { ...structuredClone(EMPTY), session_id: session,
      steps: subjects.map((subject, index) => ({ id: `plan:${index + 1}`, source: 'plan', subject, status: 'pending' })) } as Ledger
    const text = JSON.stringify(rows)
    roots.set(session, { seq: 1, generation: crypto.randomUUID(), checkpoint: await describeCheckpoint(rows, session), savedAt: 1, text, hash: await digest(`1:${text}`) })
  }
  // Sets the record as a fresh version, as a write from an earlier save would.
  const setPending = (value: Pending) => {
    historyPending.value = value
    historyPending.version += 1
  }
  return { clock, ledger, durability, historyPending, setPending, store, lines, roots, ops, saves, flag, holdSave, seedRoot }
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
type El = { key?: string; text?: string }
const bannerTexts = async ($: Engine) => {
  const ui = await $.ui.mount(pane('dock', 80, 30)) as unknown as { findAll: (q: { type?: string }) => Promise<El[]> }
  return (await ui.findAll({ type: 'Box' })).filter(el => String(el.key ?? '').startsWith('banner-')).map(el => String(el.text ?? ''))
}

test('TRACK-39 V3 RW1 a pending save outcome never reads as Unsaved on the pane banner', async ($, on) => {
  const f = fixture(on, { rejectSave: ordinal => ordinal === 2 })
  await drive(f, call($, 'track_steps', { steps: ['A'] }))
  await drive(f, call($, 'track_steps', { steps: ['B'], after: 'plan:1' }))
  expect(f.saves.length, 'RW1: the second save was attempted').toBe(2)
  expect(f.durability.value.reason.startsWith('save outcome pending: '), 'RW1: the outcome is pending').toBe(true)
  expect(f.durability.value.isUnsaved, 'RW1: the warning row stays').toBe(true)
  const banner = await bannerTexts($)
  expect(banner.filter(row => /unsaved/i.test(row)), 'RW1: no banner row says Unsaved for a pending outcome').toEqual([])
  expect(banner.some(row => /save outcome pending/i.test(row)), 'RW1: the banner shows the pending outcome').toBe(true)
})

test('TRACK-39 V3 RW2a resume resolves a pending record for its session before reading and refuses while pending', async ($, on) => {
  const f = fixture(on)
  await drive(f, call($, 'track_steps', { steps: ['A'] }))
  f.setPending({ session_id: SESSION, request_id: 'lost-resume', expect: { absent: true } })
  const start = f.ops.length
  await drive(f, $.session.start({ cwd: '/fixture/work', surface: 'terminal', isInteractive: true }))
  const resolved = opIndex(f, 'resolve', start, 'lost-resume')
  const readAt = opIndex(f, 'read', start)
  expect(resolved >= 0, 'RW2a: resume resolved the pending request').toBe(true)
  expect(readAt === -1 || resolved < readAt, 'RW2a: resolve ran before any history read').toBe(true)
  expect(f.durability.value.reason.includes('save outcome pending'), 'RW2a: resume refuses while the outcome is pending').toBe(true)
  expect(f.historyPending.value?.request_id, 'RW2a: the pending request is kept').toBe('lost-resume')
})

test('TRACK-39 V3 RW2b checkpoint resolves a save left pending behind it before reading its snapshot', async ($, on) => {
  const f = fixture(on, { rejectSave: ordinal => ordinal === 3 })
  await drive(f, call($, 'track_steps', { steps: ['A'] }))
  const release = f.holdSave(2)
  const checkpoint = call($, 'checkpoint', { expected_session: SESSION })
  await f.clock.settle()
  expect(f.saves.length, 'RW2b: the checkpoint save is held').toBe(2)
  const later = call($, 'track_steps', { steps: ['B'], after: 'plan:1' })
  await f.clock.settle()
  release()
  const result = await drive(f, checkpoint)
  await drive(f, later)
  expect(f.saves.length, 'RW2b: the later save ran before the snapshot').toBe(3)
  const lost = String(f.saves[2]!.request_id)
  const resolved = opIndex(f, 'resolve', 0, lost)
  expect(resolved > opIndex(f, 'save', 0, lost), 'RW2b: the checkpoint resolved the pending later save').toBe(true)
  const receipt = JSON.parse(String(result.result ?? '{}')) as { ok?: boolean; reason?: string }
  expect(receipt.ok, 'RW2b: checkpoint refuses while an outcome is pending').toBe(false)
  expect(String(receipt.reason).includes('save outcome pending'), 'RW2b: the refusal names the pending outcome').toBe(true)
})

test('TRACK-39 V3 RW2c restore_tracker resolves a pending record for its source before reading it', async ($, on) => {
  const f = fixture(on, { historyPending: { session_id: FOREIGN, request_id: 'lost-restore', expect: { absent: true } } })
  await f.seedRoot(FOREIGN, ['A', 'B'])
  const result = await drive(f, call($, 'restore_tracker', { from_session: FOREIGN }))
  const resolved = opIndex(f, 'resolve', 0, 'lost-restore')
  const readAt = f.ops.findIndex(entry => entry.op === 'read' && entry.request.session_id === FOREIGN)
  expect(resolved >= 0, 'RW2c: restore resolved the pending request').toBe(true)
  expect(readAt === -1 || resolved < readAt, 'RW2c: resolve ran before the source read').toBe(true)
  expect(text(result as never).includes('save outcome pending'), 'RW2c: restore refuses while the outcome is pending').toBe(true)
  expect(f.ledger.value.steps, 'RW2c: nothing was restored').toEqual([])
})

test('TRACK-39 V3 RW3 flag off, a legacy checkpoint store read failure propagates as at base', async ($, on) => {
  // The checkpoint reads the flag once in its save and once before its own legacy read;
  // only that second read arms the failure, so the save itself still succeeds.
  let flagReads: number | undefined
  let armed = false
  let thrown = false
  const f = fixture(on, {
    beforeGet: key => {
      if (!armed || key !== `s:${SESSION}`) return
      thrown = true
      throw new Error('fixture store read failed')
    },
    onFlagRead: () => { if (flagReads !== undefined && ++flagReads === 2) armed = true },
  })
  f.flag.value = undefined
  await drive(f, call($, 'track_steps', { steps: ['A'] }))
  expect(f.store.held.has(`s:${SESSION}`), 'RW3: the flag-off save is legacy').toBe(true)
  expect(f.ops, 'RW3: history.py never ran').toEqual([])
  flagReads = 0
  const outcome = await drive(f, call($, 'checkpoint', { expected_session: SESSION }).then(value => ({ value }), (error: unknown) => ({ error: String(error) })))
  expect(thrown, 'RW3: the checkpoint\'s own legacy store read failed').toBe(true)
  expect('error' in outcome, 'RW3: the store read throw propagates instead of becoming a checkpoint receipt').toBe(true)
})

test('TRACK-39 V3 RW4 an exit-0 ok save receipt without seq or root hash stays pending and is resolved first', async ($, on) => {
  const f = fixture(on, { malformedSave: ordinal => ordinal === 2 })
  await drive(f, call($, 'track_steps', { steps: ['A'] }))
  const result = await drive(f, call($, 'track_steps', { steps: ['B'], after: 'plan:1' }))
  expect(f.saves.length, 'RW4: the second save committed in the model').toBe(2)
  const malformed = String(f.saves[1]!.request_id)
  expect(f.historyPending.value?.request_id, 'RW4: the malformed success keeps its request pending').toBe(malformed)
  const shown = text(result as never)
  expect(shown.includes('save outcome pending'), 'RW4: the tool reports the pending outcome').toBe(true)
  expect(/unsaved/i.test(shown), 'RW4: the tool never says unsaved').toBe(false)
  expect(f.lines.filter(line => /unsaved/i.test(line)), 'RW4: no unsaved log or toast').toEqual([])
  await drive(f, call($, 'track_steps', { steps: ['C'], after: 'plan:2' }))
  const resolved = opIndex(f, 'resolve', 0, malformed)
  const nextSave = f.ops.findIndex((entry, index) => entry.op === 'save' && index > opIndex(f, 'save', 0, malformed))
  expect(resolved >= 0, 'RW4: the next save resolved the same request').toBe(true)
  expect(nextSave === -1 || resolved < nextSave, 'RW4: resolve ran before any new save').toBe(true)
  expect(f.historyPending.value, 'RW4: the committed resolve cleared the pending record').toBe(null)
  expect(f.saves.length, 'RW4: one new save followed the resolve').toBe(3)
})
