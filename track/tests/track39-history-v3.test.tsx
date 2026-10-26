// FIXTURE: opt-in v3 public-client coverage with an in-memory history.py model. Each test owns
// its atoms, store, roots, objects and fault schedule. This is neither fresh-module coverage nor
// filesystem, SDK lifecycle, flock, fsync or LIVE durability proof. The helper tests own OS proof.
// Sequences use TS=track_steps, MS=mark_step, CP=checkpoint, ST=session.start, RT=restore_tracker.
import { expect, mock, test } from 'claude-code/testing'
import type { ProcessRunResult } from 'claude-code'
import type { Baseline, Checkpoint, Ledger, Step } from '../types'
import { checksumOf, describeCheckpoint } from '../hooks/checkpoint'
import { identifyLedger } from '../hooks/reconcile'
import { EMPTY, TX_REQUEST, atomStore, blobPool, logs, pane, pluginStore, trackCommand } from './kit'
import type { Engine, LockAck, On, WriterLockOptions } from './kit'

const CONFIG = '/fixture/config'
const SESSION = '39393939-0000-4000-8000-000000000001'
const FOREIGN = '39393939-0000-4000-8000-000000000002'
const GENERATION = '39393939-0000-4000-8000-000000000003'
const SEED_REQUEST = '39393939-0000-4000-8000-000000000004'
const FOREIGN_REQUEST = '39393939-0000-4000-8000-000000000005'
const RESOLVE_REQUEST = '39393939-0000-4000-8000-000000000006'
const KEY = 'plugins--track_inline-a0b48c8b9db0'
const RAW_LIMIT = 3145728
const LEDGER_LIMIT = 1048576
const READ_LIMIT = 4194304 - 65536
const DRIVE_MS = 10000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA = /^[0-9a-f]{64}$/

type Operation = 'bind' | 'read' | 'save' | 'resolve' | 'collect'
type ExpectedRoot = { absent: true } | { seq: number; root_sha256: string }
type HistoryPending = { session_id: string; request_id: string; expect: ExpectedRoot }
type Recent = { kind: 'save'; request_id: string; seq: number }
  | { kind: 'fence'; request_id: string; seq: number; fences: string }
type Root = {
  v: 3; session_id: string; seq: number; generation: string | null; checkpoint: Checkpoint | null
  savedAt: number | null; object: { checksum: string; bytes: number } | null; request_id: string
  recent: Recent[]; writer: { module_token: string; owner: Record<string, unknown> }
}
type ModelState = { roots: Map<string, string>; objects: Map<string, string>; bindValue?: unknown }
type SaveFields = {
  store: string; session_id: string; module_token: string; request_id: string; expect: ExpectedRoot
  generation: string; checkpoint: Checkpoint; savedAt: number; ledger_text: string
}
type SaveRequest = SaveFields & { v: 3; op: 'save' }
type ModelReply = { state: ModelState; result: ProcessRunResult }
type HistoryCall = { op: Operation; ordinal: number; argv: readonly string[]; stdin: string; request: Record<string, unknown>; pluginRoot: string }
type ModelReceipt = { op: Operation; request: Record<string, unknown>; response: Record<string, unknown> }
type FixtureOptions = {
  enabled?: boolean; session?: string; ledger?: Ledger; records?: Record<string, unknown>
  locks?: WriterLockOptions; damage?: 'invalid-root' | 'missing-object'; dropBindNonce?: boolean
  reject?: (op: Operation, ordinal: number) => boolean
  // A lost receipt may follow a committed save or precede any commit. Each pending row chooses.
  commitRejectedSave?: boolean
  respond?: (op: Operation, request: Record<string, unknown>, ordinal: number) => ProcessRunResult | undefined
}

const copy = <T,>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T
const objectValue = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const byteLength = (text: string) => new TextEncoder().encode(text).length
const digestText = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('')
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).sort().join('|') === [...keys].sort().join('|')
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1
const nonnegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === 'string' && pattern.test(value)
const emptyModel = (): ModelState => ({ roots: new Map(), objects: new Map() })
const resultOf = (exitCode: number, response: Record<string, unknown>): ProcessRunResult => ({
  exitCode, stdout: `${JSON.stringify(response)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
})
// ce('track@inline') uses the pinned sanitized label and the first 12 raw SHA-256 hex digits.
const namespaceKey = async () => `plugins--track_inline-${(await digestText('track@inline')).slice(0, 12)}`

// Schema-exact builder shared by seeded saves and the real-client key-set assertion. No root
// JSON or object text is hand-inserted by resume rows; all seeds pass historyModel's save path.
export const clientSaveRequest = (fields: SaveFields): SaveRequest => ({
  v: 3, op: 'save', store: fields.store, session_id: fields.session_id, module_token: fields.module_token,
  request_id: fields.request_id, expect: copy(fields.expect), generation: fields.generation,
  checkpoint: copy(fields.checkpoint), savedAt: fields.savedAt, ledger_text: fields.ledger_text,
})

const validExpectation = (value: unknown): value is ExpectedRoot => objectValue(value) && (
  (exactKeys(value, ['absent']) && value.absent === true)
  || (exactKeys(value, ['seq', 'root_sha256']) && positiveInteger(value.seq) && matches(SHA, value.root_sha256))
)
const validCheckpoint = (value: unknown, session: string): value is Checkpoint => {
  if (!objectValue(value) || byteLength(JSON.stringify(value)) > 4096) return false
  const allowed = ['v', 'ok', 'source_session', 'destination_session', 'applied_checksum', 'revision', 'checksum', 'counts', 'reason']
  if (Object.keys(value).some(key => !allowed.includes(key)) || value.v !== 1 || typeof value.ok !== 'boolean'
    || value.source_session !== session || !positiveInteger(value.revision)
    || !(value.checksum === '' || matches(SHA, value.checksum))) return false
  const counts = value.counts
  return objectValue(counts) && exactKeys(counts, ['questions', 'answers', 'steps'])
    && Object.values(counts).every(nonnegativeInteger)
    && (value.destination_session === undefined || matches(UUID, value.destination_session))
    && (value.applied_checksum === undefined || matches(SHA, value.applied_checksum))
    && (value.reason === undefined || (typeof value.reason === 'string' && value.reason.length <= 1024))
}
const validRecent = (value: unknown, seq: number): value is Recent[] => Array.isArray(value) && value.length >= 1 && value.length <= 8
  && value.every((entry, index) => objectValue(entry) && matches(UUID4, entry.request_id)
    && positiveInteger(entry.seq) && entry.seq <= seq && (index === 0 || entry.seq > value[index - 1].seq)
    && ((entry.kind === 'save' && exactKeys(entry, ['kind', 'request_id', 'seq']))
      || (entry.kind === 'fence' && exactKeys(entry, ['kind', 'request_id', 'seq', 'fences']) && matches(UUID4, entry.fences))))
const validRoot = (value: unknown, session: string): value is Root => {
  if (!objectValue(value) || !exactKeys(value, ['v', 'session_id', 'seq', 'generation', 'checkpoint', 'savedAt', 'object', 'request_id', 'recent', 'writer'])
    || value.v !== 3 || value.session_id !== session || !matches(UUID4, session) || !positiveInteger(value.seq)
    || !matches(UUID4, value.request_id) || !validRecent(value.recent, value.seq)) return false
  const writer = value.writer
  if (!objectValue(writer) || !exactKeys(writer, ['module_token', 'owner']) || !matches(/^[A-Za-z0-9-]{1,64}$/, writer.module_token)
    || !objectValue(writer.owner) || byteLength(JSON.stringify(writer.owner)) > 1024) return false
  if ([value.generation, value.checkpoint, value.savedAt, value.object].every(part => part === null)) return true
  const ref = value.object
  return matches(UUID, value.generation) && validCheckpoint(value.checkpoint, session)
    && typeof value.savedAt === 'number' && Number.isFinite(value.savedAt)
    && objectValue(ref) && exactKeys(ref, ['checksum', 'bytes']) && matches(SHA, ref.checksum)
    && nonnegativeInteger(ref.bytes) && ref.bytes <= LEDGER_LIMIT
}
const openGrants = (timeline: readonly string[]) => {
  const open = new Set<string>()
  for (const event of timeline) {
    if (event.startsWith('grant:')) open.add(event.slice(6))
    if (event.startsWith('close:')) open.delete(event.slice(6))
  }
  return open
}
const historyOrderViolations = (timeline: readonly string[]) => {
  const open = new Set<string>()
  const violations: string[] = []
  for (const event of timeline) {
    if (event.startsWith('grant:')) open.add(event.slice(6))
    else if (event.startsWith('close:')) open.delete(event.slice(6))
    else if (event.startsWith('run:history:') && open.size > 0) violations.push(`${event} while ${[...open].join(',')} is open`)
  }
  return violations
}
const readStoredRoot = async (state: ModelState, session: string): Promise<{ root?: Root; rootHash?: string; ledgerText?: string | null; damaged?: string }> => {
  const text = state.roots.get(session)
  if (text === undefined) return {}
  let root: unknown
  try { root = JSON.parse(text) } catch { return { damaged: 'invalid root JSON' } }
  if (byteLength(text) > 65536 || !validRoot(root, session)) return { damaged: 'invalid root schema' }
  const rootHash = await digestText(text)
  if (root.object === null) return { root, rootHash, ledgerText: null }
  const ledgerText = state.objects.get(root.object.checksum)
  if (ledgerText === undefined || byteLength(ledgerText) !== root.object.bytes || await digestText(ledgerText) !== root.object.checksum) return { damaged: 'missing or invalid object' }
  return { root, rootHash, ledgerText }
}
const rootMatches = (expected: ExpectedRoot, root?: Root, rootHash?: string) => 'absent' in expected
  ? root === undefined : root !== undefined && expected.seq === root.seq && expected.root_sha256 === rootHash

// Pure FIXTURE transition: maps and timelines supplied by the caller are never mutated here.
// Lease/OS ownership is deliberately outside this in-memory model; native rows model the wire,
// CAS, bounded objects, semantic revisions, recent requests, fences and nested-grant refusal.
// TRACK-39 A2 contract r2 collect request shape.
const validCollect = (request: Record<string, unknown>): boolean => exactKeys(request, ['v', 'op', 'store', 'protected', 'dry_run', 'limit'])
  && Array.isArray(request.protected) && request.protected.length <= 64 && request.protected.every(session => matches(UUID4, session))
  && typeof request.dry_run === 'boolean' && Number.isSafeInteger(request.limit) && (request.limit as number) >= 1 && (request.limit as number) <= 50
export const historyModel = async (state: ModelState, op: Operation, stdin: string, timeline: readonly string[]): Promise<ModelReply> => {
  let request: Record<string, unknown> = {}
  const reply = (ok: boolean, fields: Record<string, unknown> = {}, next = state, exitCode = ok ? 0 : 1): ModelReply => ({
    state: next, result: resultOf(exitCode, { ok, protocol: 3, op,
      ...((op === 'save' || op === 'resolve') && typeof request.request_id === 'string' ? { request_id: request.request_id } : {}), ...fields }),
  })
  const refuse = (reason: string) => reply(false, { phase: 'precommit', reason })
  if (byteLength(stdin) > RAW_LIMIT) return refuse('request too large')
  let parsed: unknown
  try { parsed = JSON.parse(stdin) } catch { return refuse('request is not JSON') }
  if (!objectValue(parsed)) return refuse('request is not a JSON object')
  request = parsed
  if (request.v !== 3 || request.op !== op) return refuse('request protocol or operation differs')
  if (['bind', 'save', 'resolve', 'collect'].includes(op) && openGrants(timeline).size > 0) return refuse('store writer is busy')
  // TRACK-39 A2: the model keeps no root ages, so a valid collect finds nothing to trash.
  if (op === 'collect') {
    if (!validCollect(request) || request.store !== await namespaceKey()) return refuse('invalid collect request')
    return reply(true, { dry_run: request.dry_run, trashed: [], purged_trash: [], purged_objects: [], kept: [], more: false })
  }
  if (op === 'bind') {
    if (!exactKeys(request, ['v', 'op', 'plugin', 'nonce']) || request.plugin !== 'track' || !matches(SHA, request.nonce)) return refuse('invalid bind request')
    const binding = state.bindValue
    if (!objectValue(binding) || !exactKeys(binding, ['v', 'nonce']) || binding.v !== 1 || binding.nonce !== request.nonce) return refuse('store identity unproven')
    return reply(true, { store: await namespaceKey() })
  }
  if (request.store !== await namespaceKey() || !matches(UUID4, request.session_id)) return refuse('invalid store or session identity')
  const session = request.session_id
  if (op === 'read' && !exactKeys(request, ['v', 'op', 'store', 'session_id'])) return refuse('invalid read request')
  if (op === 'save') {
    if (!exactKeys(request, ['v', 'op', 'store', 'session_id', 'module_token', 'request_id', 'expect', 'generation', 'checkpoint', 'savedAt', 'ledger_text'])
      || !matches(/^[A-Za-z0-9-]{1,64}$/, request.module_token) || !matches(UUID4, request.request_id)
      || !validExpectation(request.expect) || !matches(UUID, request.generation)
      || !validCheckpoint(request.checkpoint, session) || typeof request.savedAt !== 'number' || !Number.isFinite(request.savedAt)
      || typeof request.ledger_text !== 'string') return refuse('invalid save request')
    if (byteLength(request.ledger_text) > LEDGER_LIMIT) return refuse('ledger too large')
    let ledger: unknown
    try { ledger = JSON.parse(request.ledger_text) } catch { return refuse('ledger is not JSON') }
    if (!objectValue(ledger)) return refuse('ledger is not a JSON object')
  }
  if (op === 'resolve' && (!exactKeys(request, ['v', 'op', 'store', 'session_id', 'module_token', 'request_id', 'expect', 'resolve_id'])
    || !matches(/^[A-Za-z0-9-]{1,64}$/, request.module_token) || !matches(UUID4, request.request_id)
    || !matches(UUID4, request.resolve_id) || !validExpectation(request.expect))) return refuse('invalid resolve request')
  const current = await readStoredRoot(state, session)
  if (current.damaged !== undefined) return refuse(`v3 history damaged: ${current.damaged}`)
  if (op === 'read') return current.root === undefined ? reply(true, { state: 'absent' })
    : reply(true, { state: 'valid', root: current.root, root_sha256: current.rootHash, ledger_text: current.ledgerText })
  const expected = request.expect as ExpectedRoot
  if (op === 'save' && !rootMatches(expected, current.root, current.rootHash)) return refuse('stale request')
  if (op === 'resolve') {
    const committed = current.root?.recent.some(entry => entry.kind === 'save' && entry.request_id === request.request_id)
    const fenced = current.root?.recent.some(entry => entry.kind === 'fence' && entry.fences === request.request_id)
    const outcome = committed ? 'committed' : fenced ? 'fenced' : !rootMatches(expected, current.root, current.rootHash) ? 'superseded' : undefined
    if (outcome !== undefined) return reply(true, { outcome, seq: current.root?.seq ?? null, root_sha256: current.rootHash ?? null })
  }
  const seq = (current.root?.seq ?? 0) + 1
  let nextRoot: Root
  let ledgerText: string | undefined
  if (op === 'save') {
    const save = request as SaveRequest
    const prior = current.root?.checkpoint
    const revision = prior === null || prior === undefined ? save.checkpoint.revision
      : prior.checksum === save.checkpoint.checksum ? prior.revision : prior.revision + 1
    if ((current.root?.generation != null && current.root.generation !== save.generation) || save.checkpoint.revision !== revision) return refuse('generation or checkpoint revision differs')
    ledgerText = save.ledger_text
    nextRoot = { v: 3, session_id: session, seq, generation: save.generation, checkpoint: copy(save.checkpoint), savedAt: save.savedAt,
      object: { checksum: await digestText(ledgerText), bytes: byteLength(ledgerText) }, request_id: save.request_id,
      recent: [...(current.root?.recent ?? []).slice(-7), { kind: 'save', request_id: save.request_id, seq }],
      writer: { module_token: save.module_token, owner: { fixture: true } } }
    const readResponse = { ok: true, protocol: 3, op: 'read', state: 'valid', root: nextRoot, root_sha256: await digestText(JSON.stringify(nextRoot)), ledger_text: ledgerText }
    if (byteLength(`${JSON.stringify(readResponse)}\n`) > READ_LIMIT) return refuse('ledger too large')
  } else {
    nextRoot = { v: 3, session_id: session, seq, generation: current.root?.generation ?? null,
      checkpoint: current.root?.checkpoint ?? null, savedAt: current.root?.savedAt ?? null, object: current.root?.object ?? null,
      request_id: request.resolve_id as string,
      recent: [...(current.root?.recent ?? []).slice(-7), { kind: 'fence', request_id: request.resolve_id as string, seq, fences: request.request_id as string }],
      writer: { module_token: request.module_token as string, owner: { fixture: true } } }
  }
  const rootText = JSON.stringify(nextRoot)
  if (byteLength(rootText) > 65536) return refuse('root too large')
  const next = { ...state, roots: new Map(state.roots), objects: new Map(state.objects) }
  next.roots.set(session, rootText)
  if (ledgerText !== undefined && nextRoot.object !== null) next.objects.set(nextRoot.object.checksum, ledgerText)
  return reply(true, { seq, root_sha256: await digestText(rootText), ...(op === 'resolve' ? { outcome: 'fenced' } : {}) }, next)
}

const fixture = (on: On, options: FixtureOptions = {}) => {
  const clock = mock.clock(on)
  const session = options.session ?? SESSION
  const ledger = atomStore<Ledger>(on, 'ledger', copy(options.ledger ?? EMPTY))
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  atomStore(on, 'pane', { isOpen: false, hidden: false, closedByPerson: false, autoOpenDone: true })
  atomStore(on, 'lit', [] as string[])
  atomStore(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  atomStore(on, 'pending', { inputs: [], nextId: 1 })
  atomStore(on, 'pulse', 0)
  atomStore(on, 'scroll', { questions: null, steps: null })
  atomStore(on, 'tick', 0)
  atomStore(on, 'reveal', {})
  const durability = atomStore(on, 'durability', { isUnsaved: false, reason: '' } as {
    isUnsaved: boolean; reason: string; memorySession?: string | null; baseline?: Baseline
  })
  // This atom is deliberately not yet declared in the unchanged pre-P2 PluginState. The cast
  // registers only its test provider; it does not widen or modify the public production type.
  const pending = atomStore<HistoryPending | null>(on, 'historyPending' as never, null)
  // The product root, captured independently from its writer-lock spawns as cwd-spawn.test.tsx does.
  // This proves one root across two product spawn paths, not host-level provenance.
  const product = { root: undefined as string | undefined }
  const store = pluginStore(on, copy(options.records ?? {}), undefined, { locks: options.locks, beforeLockSpawn: request => {
    const helper = String(request.argv[1] ?? '')
    const root = helper.slice(0, -'/hooks/writer-lock.py'.length)
    expect(helper.endsWith('/hooks/writer-lock.py') && root.startsWith('/') && request.cwd === root, 'FIXTURE writer-lock root is absolute and its cwd').toBe(true)
    expect(product.root === undefined || product.root === root, 'FIXTURE one product root across lock spawns').toBe(true)
    product.root = root
  } })
  const pool = blobPool(on, { configDir: CONFIG })
  const files = new Map<string, string>()
  on('fs.write', (_, event) => {
    store.locks.timeline.push(`write:${event.path}`)
    files.set(event.path, String(event.text))
    return { value: undefined }
  })
  on('fs.read', (_, event) => {
    store.locks.timeline.push(`read:${event.path}`)
    const text = files.get(event.path)
    return text === undefined ? { deny: `ENOENT: no such file: ${event.path}` } : { value: text }
  })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__track__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: session }))
  on('session.start', (_, event) => ({ cwd: event.cwd }))
  on('env.get', { name: /^TRACK_HISTORY_V3$/ }, () => ({ value: options.enabled === false ? undefined : '1' }))
  const lines = logs(on)
  const model = { state: emptyModel() }
  const calls: HistoryCall[] = []
  const receipts: ModelReceipt[] = []
  // Ordinals count client process calls for each operation, excluding direct model seed/read calls.
  const ordinals: Record<Operation, number> = { bind: 0, read: 0, save: 0, resolve: 0, collect: 0 }
  on('process.run', { argv: /\/hooks\/history\.py$/ }, async ($, event) => {
    const op = event.argv[2] as Operation
    store.locks.timeline.push(`run:history:${op}`)
    // The product runs from its own plugin root, which differs from this test plugin's root.
    const clientRoot = product.root ?? ''
    expect(clientRoot.startsWith('/'), 'FIXTURE product root was captured from a lock spawn before history').toBe(true)
    expect(event.argv, 'FIXTURE history argv').toEqual(['python3', `${clientRoot}/hooks/history.py`, op])
    expect(['bind', 'read', 'save', 'resolve', 'collect'].includes(op), 'FIXTURE supported history operation').toBe(true)
    expect(typeof event.init?.stdin, 'FIXTURE string stdin').toBe('string')
    expect(event.init?.env, 'FIXTURE isolated config environment').toEqual({ CLAUDE_CONFIG_DIR: CONFIG })
    expect(event.init?.timeoutMs, 'FIXTURE history timeout').toBe(8000)
    const stdin = event.init!.stdin!
    // Raw size is checked by historyModel before parsing. Recording also preserves malformed input.
    let request: Record<string, unknown> = {}
    if (byteLength(stdin) <= RAW_LIMIT) {
      try { const parsed: unknown = JSON.parse(stdin); if (objectValue(parsed)) request = parsed } catch { /* The model returns the malformed-JSON refusal. */ }
    }
    if (op === 'collect') expect(validCollect(request), 'FIXTURE collect request shape').toBe(true)
    const ordinal = ++ordinals[op]
    calls.push({ op, ordinal, argv: [...event.argv], stdin, request: copy(request), pluginRoot: clientRoot })
    if (op === 'bind' && options.dropBindNonce === true) store.held.delete('v3:bind')
    model.state = { ...model.state, bindValue: copy(store.held.get('v3:bind') ?? null) }
    const rejected = options.reject?.(op, ordinal) === true
    if (rejected && !(op === 'save' && options.commitRejectedSave === true)) throw new Error('fixture history receipt lost before commit')
    const transition = await historyModel(model.state, op, stdin, store.locks.timeline)
    model.state = transition.state
    receipts.push({ op, request: copy(request), response: JSON.parse(transition.result.stdout) as Record<string, unknown> })
    if (rejected) throw new Error('fixture history receipt lost after commit')
    return { value: options.respond?.(op, request, ordinal) ?? transition.result }
  })
  const damageHistory = () => {
    if (options.damage === undefined) throw new Error('fixture damage schedule is absent')
    const text = model.state.roots.get(session)
    if (text === undefined) throw new Error('fixture damage requires a seeded root')
    if (options.damage === 'invalid-root') model.state.roots.set(session, '{invalid root')
    else {
      const root = JSON.parse(text) as Root
      if (root.object === null) throw new Error('fixture missing-object damage requires content')
      model.state.objects.delete(root.object.checksum)
    }
  }
  return { clock, session, ledger, durability, pending, store, pool, locks: store.locks, files, lines, model, calls, receipts, damageHistory }
}
type Fixture = ReturnType<typeof fixture>

const drive = async <T,>(fixtureState: Fixture, call: Promise<T>): Promise<T> => {
  let finished = false
  void call.then(() => { finished = true }, () => { finished = true })
  await fixtureState.clock.settle()
  if (!finished) await fixtureState.clock.advance(DRIVE_MS)
  if (!finished) {
    fixtureState.locks.deadman()
    await fixtureState.clock.settle()
  }
  return call
}
const invoke = ($: Engine, tool: string, fields: Record<string, unknown> = {}) => $.tool.call({ tool, ...fields } as never)
const checkpoint = async ($: Engine, fixtureState: Fixture): Promise<Checkpoint & { open_steps?: unknown[] }> => {
  const response = await drive(fixtureState, invoke($, 'mcp__track__checkpoint', { expected_session: fixtureState.session }))
  return JSON.parse(String(response.result ?? '{}')) as Checkpoint & { open_steps?: unknown[] }
}
const trackSteps = ($: Engine, fixtureState: Fixture, steps: string[], after?: string) => drive(fixtureState, invoke($, 'mcp__track__track_steps', { steps, ...(after !== undefined ? { after } : {}) }))
const markStep = ($: Engine, fixtureState: Fixture, fields: { id: string; status: Step['status']; note?: string }) => drive(fixtureState, invoke($, 'mcp__track__mark_step', fields))
const startSession = async ($: Engine, fixtureState: Fixture) => {
  const start = fixtureState.locks.timeline.length
  const result = await drive(fixtureState, $.session.start({ cwd: '/fixture/work', surface: 'terminal', isInteractive: true }))
  const events = fixtureState.locks.timeline.slice(start)
  expect(events.includes(`get:s:${fixtureState.session}`) || events.includes('run:history:read'), 'FIXTURE resume-start: history read was attempted').toBe(true)
  return result
}
// open_steps is a public presentation extension; every other receipt field must match exactly.
const checkpointReceipt = (value: Checkpoint & { open_steps?: unknown[] }) => {
  const receipt = { ...value }
  delete receipt.open_steps
  return receipt
}
const modelRead = async (fixtureState: Fixture, session = fixtureState.session) => {
  const read = await historyModel(fixtureState.model.state, 'read', JSON.stringify({ v: 3, op: 'read', store: KEY, session_id: session }), [])
  const response = JSON.parse(read.result.stdout) as { state?: string; root?: Root; root_sha256?: string; ledger_text?: string | null; reason?: string }
  const ledger = response.ledger_text == null ? undefined : JSON.parse(response.ledger_text) as Ledger
  return { response, root: response.root, ledger }
}
const rootExpectation = (root: Root, rootHash: string): ExpectedRoot => ({ seq: root.seq, root_sha256: rootHash })
const stepLabels = (ledger: Ledger | undefined) => ledger?.steps.map(step => step.subject) ?? []
const stepFixture = (session: string, labels = ['A', 'B'], note?: string): Ledger => identifyLedger({
  ...copy(EMPTY), session_id: session, steps: labels.map((subject, index) => ({
    id: `plan:${index + 1}`, source: 'plan', subject, status: 'pending', sourceId: `${session}:plan:${index + 1}`,
    ...(index === 0 && note !== undefined ? { note } : {}),
  })),
}, session)
const seedSave = async (fixtureState: Fixture, ledger: Ledger, options: { requestId?: string; previous?: Root; rootHash?: string } = {}) => {
  const session = ledger.session_id!
  const identified = identifyLedger(copy(ledger), session)
  const request = clientSaveRequest({ store: KEY, session_id: session, module_token: 'fixture-seed', request_id: options.requestId ?? SEED_REQUEST,
    expect: options.previous === undefined ? { absent: true } : rootExpectation(options.previous, options.rootHash!),
    generation: options.previous?.generation ?? GENERATION, checkpoint: await describeCheckpoint(identified, session, options.previous?.checkpoint ?? undefined),
    savedAt: 1700000000, ledger_text: JSON.stringify(identified) })
  const transition = await historyModel(fixtureState.model.state, 'save', JSON.stringify(request), [])
  expect(transition.result.exitCode, 'FIXTURE seeded save validates the shared builder').toBe(0)
  fixtureState.model.state = transition.state
  return request
}
const assertPending = (fixtureState: Fixture, result: Checkpoint, label: string, ordinal = 2) => {
  expect(result.ok, `${label}: checkpoint refuses an unresolved outcome`).toBe(false)
  expect(result.reason?.startsWith('save outcome pending'), `${label}: pending reason`).toBe(true)
  expect(fixtureState.lines.filter(line => /unsaved/i.test(line)), `${label}: pending is not a definitive unsaved toast`).toEqual([])
  const save = fixtureState.calls.filter(call => call.op === 'save').at(-1)
  expect(save?.ordinal, `${label}: pending fault targets save ${ordinal}`).toBe(ordinal)
  expect(fixtureState.pending.value, `${label}: historyPending names the attempted request and root`).toEqual({
    session_id: fixtureState.session, request_id: save?.request.request_id, expect: save?.request.expect,
  })
  expect(typeof fixtureState.pending.value?.request_id, `${label}: a pending request exists`).toBe('string')
  expect(stepLabels(fixtureState.ledger.value), `${label}: local rows are kept`).toEqual(['A'])
}
const assertResolveBeforeSave = (fixtureState: Fixture, start: number, outcome: string, label: string) => {
  const calls = fixtureState.calls.slice(start)
  expect(calls[0]?.op, `${label}: resolve precedes another history operation`).toBe('resolve')
  const resolved = fixtureState.receipts.filter(receipt => receipt.op === 'resolve').at(-1)
  expect(resolved?.response.outcome, `${label}: terminal resolve outcome`).toBe(outcome)
  expect(fixtureState.pending.value, `${label}: terminal pending record is cleared`).toBeNull()
  return calls.filter(call => call.op === 'save')
}

test('TRACK-39 V3 P1a public calls commit two saves to one root outside all grants', async ($, on) => {
  // Sequence P1a: TS A,B saves 1 => seq 1/rev 1; CP saves 2 => seq 2/rev 1.
  const f = fixture(on)
  await trackSteps($, f, ['A', 'B'])
  const result = await checkpoint($, f)
  const stored = await modelRead(f)
  expect(f.model.state.roots.size, 'P1a: history root count').toBe(1)
  expect(stored.root?.seq, 'P1a: TS and CP each commit one root save').toBe(2)
  expect(f.calls.filter(call => call.op === 'save').length, 'P1a: two public save calls').toBe(2)
  expect(stored.root?.checkpoint?.revision, 'P1a: initial checkpoint revision').toBe(1)
  expect(stepLabels(stored.ledger), 'P1a: model read returns A and B').toEqual(['A', 'B'])
  expect([f.store.held.has(`s:${SESSION}`), f.store.held.has(`h:${SESSION}`)], 'P1a: v3 has no legacy body or head').toEqual([false, false])
  const storeMutations = f.locks.timeline.filter(event => event.startsWith('set:') || event.startsWith('delete:'))
  expect(storeMutations, 'P1a: bind nonce is the only client store mutation').toEqual(['set:v3:bind'])
  const fileWrites = f.locks.timeline.filter(event => event.startsWith('write:')).map(event => event.slice(6))
  expect(fileWrites.filter(path => !TX_REQUEST.test(path)), 'P1a: every client file write is an exact completion request').toEqual([])
  expect([...f.files.keys()].filter(path => !TX_REQUEST.test(path)), 'P1a: no non-completion client file remains').toEqual([])
  expect(f.locks.requests, 'P1a: every completion request matches an issued grant path and nonce exactly once').toEqual(f.locks.grants.map(grant => ({ path: grant.path, text: grant.nonce })))
  expect(historyOrderViolations(f.locks.timeline), 'P1a: every history run follows all prior grant closes').toEqual([])
  const save = f.calls.find(call => call.op === 'save')
  expect(save !== undefined, 'P1a: public save reached history.py').toBe(true)
  expect(Object.keys(save?.request ?? {}).sort(), 'P1a: actual save uses builder key set').toEqual(Object.keys(clientSaveRequest({
    store: KEY, session_id: SESSION, module_token: 'fixture', request_id: SEED_REQUEST, expect: { absent: true }, generation: GENERATION,
    checkpoint: await describeCheckpoint(stepFixture(SESSION), SESSION), savedAt: 1, ledger_text: JSON.stringify(stepFixture(SESSION)),
  })).sort())
  expect(checkpointReceipt(result), 'P1a: full public checkpoint matches the committed root').toEqual(stored.root?.checkpoint)
})

test('TRACK-39 V3 P1b independently seeded public resume reads the v3 root', async ($, on) => {
  // Sequence P1b: seed C1 => seq 1/rev 1; start only reads; checkpoint C2 => seq 2/rev 1.
  const f = fixture(on)
  await seedSave(f, stepFixture(SESSION))
  const seeded = await modelRead(f)
  await startSession($, f)
  expect(stepLabels(f.ledger.value), 'P1b: resumed ledger rows').toEqual(['A', 'B'])
  const ui = await $.ui.mount(pane('dock'))
  const text = (await ui.findAll({ type: 'Text' })).map(element => String(element.text ?? '')).join('\n')
  expect(text.includes('S1. A') && text.includes('S2. B'), 'P1b: pane renders both concrete resumed row labels').toBe(true)
  const result = await checkpoint($, f)
  expect(checkpointReceipt(result), 'P1b: full checkpoint preserves seeded semantic revision').toEqual(seeded.root?.checkpoint)
  const stored = await modelRead(f)
  expect(stored.root?.seq, 'P1b: seed and unchanged checkpoint each commit once').toBe(2)
  expect(stored.root?.checkpoint?.revision, 'P1b: unchanged checksum keeps revision').toBe(1)
  expect(f.locks.timeline.includes(`get:s:${SESSION}`), 'P1b: legacy body is not content').toBe(false)
})

test('TRACK-39 V3 NW1 stale engine-store snapshot cannot replace newer root content', async ($, on) => {
  // Sequence NW1: TS A saves 1 => 1/1; MS completed saves 2 => 2/2;
  // same MS and lookup save nothing; restore only snapshot C1; CP save 3 => 3/2.
  const f = fixture(on)
  await trackSteps($, f, ['A'])
  const snapshot = copy(Object.fromEntries(f.store.held))
  await markStep($, f, { id: 'plan:1', status: 'completed' })
  expect(f.calls.filter(call => call.op === 'save').length, 'NW1: changed TS and MS have each saved').toBe(2)
  await markStep($, f, { id: 'plan:1', status: 'completed' })
  await drive(f, invoke($, 'mcp__track__lookup_rows'))
  expect(f.calls.filter(call => call.op === 'save').length, 'NW1: unchanged MS and lookup add no save').toBe(2)
  f.store.held.clear()
  for (const [key, value] of Object.entries(snapshot)) f.store.held.set(key, value)
  const result = await checkpoint($, f)
  const stored = await modelRead(f)
  expect(stored.ledger?.steps[0]?.status, 'NW1: model read retains rev 2 content').toBe('completed')
  expect(stored.root?.seq, 'NW1: three declared successful root saves').toBe(3)
  expect(stored.root?.checkpoint?.revision, 'NW1: root checkpoint revision remains 2').toBe(2)
  expect(result.revision, 'NW1: checkpoint is from rev 2, not stale store').toBe(2)
})

test('TRACK-39 V3 NW6 namespace proof never uses plugin root in stdin', async ($, on) => {
  // Sequence NW6: TS A saves 1 => seq 1/revision 1; bind changes no root.
  const f = fixture(on)
  await trackSteps($, f, ['A'])
  const bind = f.calls.find(call => call.op === 'bind')
  expect(Object.keys(bind?.request ?? {}).sort(), 'NW6: exact public bind key set').toEqual(['nonce', 'op', 'plugin', 'v'])
  expect(bind?.request.plugin, 'NW6: bind names track').toBe('track')
  expect(f.calls.length > 0, 'NW6: actual history requests exist').toBe(true)
  for (const call of f.calls) {
    expect(call.stdin.includes(call.pluginRoot), `NW6: ${call.op} stdin has no plugin.root-derived identity`).toBe(false)
    expect(call.argv, `NW6: ${call.op} argv uses the ordinary helper path`).toEqual(['python3', `${call.pluginRoot}/hooks/history.py`, call.op])
  }
  expect((await modelRead(f)).root?.seq, 'NW6: exactly one successful save').toBe(1)
})

test('TRACK-39 V3 NW7a missing bind nonce fails closed before a save', async ($, on) => {
  // Sequence NW7a: nonce disappears before scan; bind refuses; zero saves/fences => no root.
  const f = fixture(on, { dropBindNonce: true })
  const result = await trackSteps($, f, ['A'])
  expect(`${result.result ?? ''}\n${f.durability.value.reason}`.includes('store identity'), 'NW7a: TS refusal names unproven store identity').toBe(true)
  expect(f.calls.filter(call => call.op === 'save'), 'NW7a: identity refusal spawns no save').toEqual([])
  expect(f.store.held.has(`s:${SESSION}`), 'NW7a: identity refusal writes no legacy body').toBe(false)
  expect(f.model.state.roots.size, 'NW7a: no root commit').toBe(0)
})

for (const ack of ['wrong-nonce', 'eof'] as const satisfies readonly LockAck[]) {
  test(`TRACK-39 V3 NW7b ${ack} bind completion acknowledgement abandons the bind`, async ($, on) => {
    // Sequence NW7b: track A; bind nonce grant has a wrong/missing B3 ack; no bind process,
    // save or fence runs => no root. kit locks.ack targets B3; GrantFault targets B1 instead.
    const f = fixture(on, { locks: { ack: () => ack } })
    const result = await trackSteps($, f, ['A'])
    const reason = `${result.result ?? ''}\n${f.durability.value.reason}`
    expect(reason.includes('bind') && reason.includes('abandoned'), 'NW7b: TS bind abandoned reason').toBe(true)
    expect(f.calls.filter(call => call.op === 'bind' || call.op === 'save'), 'NW7b: no process after unconfirmed B3').toEqual([])
    expect(f.store.held.has(`s:${SESSION}`), 'NW7b: no legacy fallback body').toBe(false)
    expect(f.model.state.roots.size, 'NW7b: no root commit').toBe(0)
  })
}

test('TRACK-39 V3 NW8-save existing root wins over a legacy shadow and keeps that shadow', async ($, on) => {
  // Sequence NW8-save: seed A => 1/1; ST reads; TS B saves 1 => 2/2; CP saves 2 => 3/2.
  const shadow = { v: 1, session_id: SESSION, generation: GENERATION, savedAt: 1, ledger: stepFixture(SESSION, ['X']) }
  const f = fixture(on, { records: { [`s:${SESSION}`]: shadow } })
  await seedSave(f, stepFixture(SESSION, ['A']))
  await startSession($, f)
  await trackSteps($, f, ['B'], 'plan:1')
  await checkpoint($, f)
  const stored = await modelRead(f)
  expect(stepLabels(stored.ledger), 'NW8-save: root model read shows A and B').toEqual(['A', 'B'])
  expect(stored.root?.seq, 'NW8-save: seed plus TS and CP commits').toBe(3)
  expect(stored.root?.checkpoint?.revision, 'NW8-save: changed steps advance semantic revision').toBe(2)
  expect(f.store.held.get(`s:${SESSION}`), 'NW8-save: legacy shadow is unchanged').toEqual(shadow)
  expect(f.locks.timeline.includes(`get:s:${SESSION}`), 'NW8-save: shadow is never content').toBe(false)
})

for (const damage of ['invalid-root', 'missing-object'] as const) {
  test(`TRACK-39 V3 NW8-damaged ${damage} refuses resume and checkpoint`, async ($, on) => {
    // Sequence NW8-damaged: seed A C1 => 1/1; corrupt fixture bytes; start and checkpoint
    // both refuse, so there is no further successful save or fence.
    const shadow = { v: 1, session_id: SESSION, savedAt: 1, ledger: stepFixture(SESSION, ['X']) }
    const f = fixture(on, { damage, records: { [`s:${SESSION}`]: shadow } })
    await seedSave(f, stepFixture(SESSION, ['A']))
    f.damageHistory()
    const rootBytes = f.model.state.roots.get(SESSION)
    await startSession($, f)
    expect(f.durability.value.reason.includes('v3 history damaged'), 'NW8-damaged: resume reports damaged v3 history').toBe(true)
    const result = await checkpoint($, f)
    expect(result.reason?.includes('v3 history damaged'), 'NW8-damaged: checkpoint reports damaged v3 history').toBe(true)
    expect(result.ok, 'NW8-damaged: checkpoint refuses').toBe(false)
    expect(stepLabels(f.ledger.value), 'NW8-damaged: shadow never becomes rows').toEqual([])
    expect(f.locks.timeline.includes(`get:s:${SESSION}`), 'NW8-damaged: no shadow content read').toBe(false)
    expect(f.model.state.roots.get(SESSION), 'NW8-damaged: refusal preserves damaged root bytes').toBe(rootBytes)
    expect(f.calls.filter(call => call.op === 'save'), 'NW8-damaged: no public save is spawned').toEqual([])
  })
}

test('TRACK-39 V3 NW-nest-model detector refuses open grants and accepts the same save after close', async () => {
  // Sequence NW-nest-model: three nested refusals commit nothing; append close; same save C1
  // succeeds => seq 1/revision 1. This control calls no product code and must pass on baseline.
  const ledger = stepFixture(SESSION, ['A'])
  const save = clientSaveRequest({ store: KEY, session_id: SESSION, module_token: 'fixture', request_id: SEED_REQUEST,
    expect: { absent: true }, generation: GENERATION, checkpoint: await describeCheckpoint(ledger, SESSION), savedAt: 1, ledger_text: JSON.stringify(ledger) })
  const nonce = 'a'.repeat(64)
  const state: ModelState = { ...emptyModel(), bindValue: { v: 1, nonce } }
  const requests: Array<[Operation, Record<string, unknown>]> = [
    ['save', save], ['resolve', { v: 3, op: 'resolve', store: KEY, session_id: SESSION, module_token: 'fixture', request_id: SEED_REQUEST, expect: { absent: true }, resolve_id: RESOLVE_REQUEST }],
    ['bind', { v: 3, op: 'bind', plugin: 'track', nonce }],
  ]
  expect(await namespaceKey(), 'NW-nest-model: computed A3 namespace pin').toBe(KEY)
  for (const [op, request] of requests) {
    const refused = await historyModel(state, op, JSON.stringify(request), ['grant:fixture'])
    expect(refused.result.exitCode, `NW-nest-model: ${op} nested exit`).toBe(1)
    expect(JSON.parse(refused.result.stdout), `NW-nest-model: ${op} nested receipt`).toEqual({ ok: false, protocol: 3, op,
      ...(op === 'save' || op === 'resolve' ? { request_id: SEED_REQUEST } : {}), phase: 'precommit', reason: 'store writer is busy' })
    expect(refused.state.roots.size, `NW-nest-model: ${op} nested refusal commits nothing`).toBe(0)
  }
  const accepted = await historyModel(state, 'save', JSON.stringify(save), ['grant:fixture', 'close:fixture'])
  expect(accepted.result.exitCode, 'NW-nest-model: unchanged save succeeds after grant close').toBe(0)
  expect(JSON.parse(accepted.result.stdout).seq, 'NW-nest-model: first successful commit sequence').toBe(1)
  expect(state.roots.size, 'NW-nest-model: pure transition preserves original input').toBe(0)
})

test('TRACK-39 V3 NW-nest-public refuses a save during an external grant and commits after close', async ($, on) => {
  // Sequence NW-nest-public: TS A commits seq 1; an injected FIXTURE grant makes TS B
  // refuse precommit; after close, CP commits seq 2 with A and B. No OS lock is exercised.
  const f = fixture(on)
  await trackSteps($, f, ['A'])
  expect((await modelRead(f)).root?.seq, 'NW-nest-public: first TS commits seq 1').toBe(1)
  const saveCount = f.receipts.filter(receipt => receipt.op === 'save').length
  f.locks.timeline.push('grant:fixture')
  const result = await trackSteps($, f, ['B'], 'plan:1')
  const saves = f.receipts.filter(receipt => receipt.op === 'save').slice(saveCount)
  expect(saves.length, 'NW-nest-public: busy TS makes exactly one save attempt').toBe(1)
  expect(saves.map(receipt => [receipt.response.phase, receipt.response.reason]), 'NW-nest-public: save refuses busy before commit').toEqual([['precommit', 'store writer is busy']])
  expect(`${result.result ?? ''}\n${f.durability.value.reason}`.includes('store writer is busy'), 'NW-nest-public: public refusal reports busy').toBe(true)
  expect(f.durability.value.isUnsaved, 'NW-nest-public: precommit refusal leaves rows unsaved').toBe(true)
  expect(f.pending.value, 'NW-nest-public: known refusal is not pending').toBeNull()
  expect(f.calls.filter(call => call.op === 'resolve'), 'NW-nest-public: known refusal needs no resolve').toEqual([])
  expect([f.store.held.has(`s:${SESSION}`), f.store.held.has(`h:${SESSION}`)], 'NW-nest-public: busy refusal has no legacy fallback').toEqual([false, false])
  expect((await modelRead(f)).root?.seq, 'NW-nest-public: busy refusal preserves seq 1').toBe(1)
  f.locks.timeline.push('close:fixture')
  await checkpoint($, f)
  const stored = await modelRead(f)
  expect(stored.root?.seq, 'NW-nest-public: checkpoint commits seq 2 after grant close').toBe(2)
  expect(stepLabels(stored.ledger), 'NW-nest-public: successful checkpoint keeps A and B').toEqual(['A', 'B'])
})

test('TRACK-39 V3 NW-pend-commit resolves a committed lost receipt without a duplicate save', async ($, on) => {
  // Sequence NW-pend-commit: TS A saves 1 => 1/1; CP save 2 commits R => 2/1 then
  // loses its receipt. Next CP resolves committed; equal memory causes no save 3 => 2/1.
  const f = fixture(on, { commitRejectedSave: true, reject: (op, ordinal) => op === 'save' && ordinal === 2 })
  await trackSteps($, f, ['A'])
  const pendingResult = await checkpoint($, f)
  assertPending(f, pendingResult, 'NW-pend-commit')
  const start = f.calls.length
  const result = await checkpoint($, f)
  const saves = assertResolveBeforeSave(f, start, 'committed', 'NW-pend-commit')
  expect(saves, 'NW-pend-commit: unchanged memory needs no third save').toEqual([])
  expect(f.calls.filter(call => call.op === 'save').length, 'NW-pend-commit: TS and lost-receipt CP are the only saves').toBe(2)
  const stored = await modelRead(f)
  expect(stored.root?.seq, 'NW-pend-commit: TS and R committed').toBe(2)
  expect(result.revision, 'NW-pend-commit: original semantic revision').toBe(1)
  expect(stepLabels(stored.ledger), 'NW-pend-commit: committed rows remain').toEqual(['A'])
})

test('TRACK-39 V3 NW-pend-edit resolves R before saving new local B against R', async ($, on) => {
  // Sequence NW-pend-edit: TS A save 1 => 1/1; CP save 2 commits R => 2/1, loses receipt;
  // TS B resolves committed then save 3 expects R => 3/2; CP save 4 => 4/2.
  const f = fixture(on, { commitRejectedSave: true, reject: (op, ordinal) => op === 'save' && ordinal === 2 })
  await trackSteps($, f, ['A'])
  assertPending(f, await checkpoint($, f), 'NW-pend-edit')
  const committed = await modelRead(f)
  const start = f.calls.length
  await trackSteps($, f, ['B'], 'plan:1')
  const saves = assertResolveBeforeSave(f, start, 'committed', 'NW-pend-edit')
  expect(saves.length, 'NW-pend-edit: TS B makes exactly one save after resolve').toBe(1)
  expect(saves[0]?.ordinal, 'NW-pend-edit: TS B saves ordinal 3').toBe(3)
  expect(saves[0]?.request.expect, 'NW-pend-edit: new save CAS names committed R').toEqual({ seq: 2, root_sha256: committed.response.root_sha256 })
  expect((await modelRead(f)).root?.seq, 'NW-pend-edit: TS B has already committed before CP').toBe(3)
  const result = await checkpoint($, f)
  const stored = await modelRead(f)
  expect(stepLabels(stored.ledger), 'NW-pend-edit: root retains R rows and local B').toEqual(['A', 'B'])
  expect(stored.root?.seq, 'NW-pend-edit: four successful root commits').toBe(4)
  expect(f.calls.filter(call => call.op === 'save').length, 'NW-pend-edit: both TS calls and both CP calls save').toBe(4)
  expect(result.revision, 'NW-pend-edit: B advances semantic revision').toBe(2)
})

test('TRACK-39 V3 NW-pend-fenced reads the new fence root before retrying a save', async ($, on) => {
  // Sequence NW-pend-fenced: TS A save 1 => 1/1; CP save 2 R rejects before commit;
  // next CP resolves fence => 2/1, reads it, then save 3 expects that fence => 3/1.
  const f = fixture(on, { reject: (op, ordinal) => op === 'save' && ordinal === 2 })
  await trackSteps($, f, ['A'])
  assertPending(f, await checkpoint($, f), 'NW-pend-fenced')
  const start = f.calls.length
  const result = await checkpoint($, f)
  const saves = assertResolveBeforeSave(f, start, 'fenced', 'NW-pend-fenced')
  expect(saves.length, 'NW-pend-fenced: exactly one save follows fence').toBe(1)
  const calls = f.calls.slice(start)
  const resolved = f.receipts.find(receipt => receipt.op === 'resolve')
  const read = f.receipts.find(receipt => receipt.op === 'read' && (receipt.response.root as Root | undefined)?.recent.some(entry => entry.kind === 'fence'))
  expect(calls.findIndex(call => call.op === 'read') > 0 && calls.findIndex(call => call.op === 'read') < calls.findIndex(call => call.op === 'save'), 'NW-pend-fenced: fresh read lies between resolve and save').toBe(true)
  expect(read?.response.root_sha256, 'NW-pend-fenced: fresh read sees fence receipt root').toBe(resolved?.response.root_sha256)
  expect(saves[0]?.ordinal, 'NW-pend-fenced: retry is save ordinal 3').toBe(3)
  expect(saves[0]?.request.expect, 'NW-pend-fenced: retry CAS comes from the fresh fence read').toEqual({ seq: 2, root_sha256: read?.response.root_sha256 })
  const stored = await modelRead(f)
  expect(stored.root?.seq, 'NW-pend-fenced: initial save, one fence and retry save').toBe(3)
  expect(f.calls.filter(call => call.op === 'save').length, 'NW-pend-fenced: one rejected and two committed save calls').toBe(3)
  expect(result.revision, 'NW-pend-fenced: first content has semantic revision 1').toBe(1)
  expect(stepLabels(stored.ledger), 'NW-pend-fenced: final root retains local rows').toEqual(['A'])
})

for (const conflict of [false, true]) {
  test(`TRACK-39 V3 NW-pend-superseded ${conflict ? 'conflict archives local rows' : 'merges foreign note and local B'}`, async ($, on) => {
    // Sequence NW-pend-superseded: TS A save 1 => 1/1; CP save 2 R rejects before commit.
    // Foreign F changes A.note => 2/2. Merge: TS B leaves local A unchanged, resolves
    // superseded then save 3 => 3/3. Conflict: MS pending with note local resolves
    // superseded, archives/adopts F in its own grant and makes no save 3 => 2/2.
    const f = fixture(on, { reject: (op, ordinal) => op === 'save' && ordinal === 2 })
    await trackSteps($, f, ['A'])
    assertPending(f, await checkpoint($, f), 'NW-pend-superseded')
    const prior = await modelRead(f)
    const foreign = copy(prior.ledger!)
    foreign.steps[0]!.note = 'foreign'
    await seedSave(f, foreign, { requestId: FOREIGN_REQUEST, previous: prior.root!, rootHash: prior.response.root_sha256! })
    const durable = await modelRead(f)
    const local = identifyLedger(copy(f.ledger.value), SESSION)
    // MS keeps the initial pending status; only its explicit note changes the local row.
    if (conflict) local.steps[0]!.note = 'local'
    const baseline = copy(f.durability.value.baseline)
    const durableIdentity = { checkpoint: durable.root?.checkpoint, generation: durable.root?.generation }
    const archiveKey = `r:${SESSION}:conflict-${await checksumOf({ durable: durableIdentity, baseline, memory: local })}`
    const start = f.calls.length
    const timelineStart = f.locks.timeline.length
    const result = conflict
      ? await markStep($, f, { id: 'plan:1', status: 'pending', note: 'local' })
      : await trackSteps($, f, ['B'], 'plan:1')
    const saves = assertResolveBeforeSave(f, start, 'superseded', 'NW-pend-superseded')
    const stored = await modelRead(f)
    if (!conflict) {
      expect(saves.length, 'NW-pend-superseded: exactly one reconciled save').toBe(1)
      expect(saves[0]?.ordinal, 'NW-pend-superseded: reconciled TS save is ordinal 3').toBe(3)
      expect(saves[0]?.request.expect, 'NW-pend-superseded: merge CAS uses F').toEqual({ seq: 2, root_sha256: durable.response.root_sha256 })
      expect(stored.root?.seq, 'NW-pend-superseded: initial TS, F and merged TS commit count').toBe(3)
      expect(stored.root?.checkpoint?.revision, 'NW-pend-superseded: merged content revision').toBe(3)
      expect(String(result.result).includes('unsaved'), 'NW-pend-superseded: TS reports its successful merge').toBe(false)
      expect(stepLabels(stored.ledger), 'NW-pend-superseded: root retains F and B').toEqual(['A', 'B'])
      expect(stored.ledger?.steps[0]?.note, 'NW-pend-superseded: foreign note survives merge').toBe('foreign')
      expect(stored.ledger?.steps[0]?.status, 'NW-pend-superseded: A stays unchanged locally before merging F').toBe('pending')
      expect(f.calls.filter(call => call.op === 'save').length, 'NW-pend-superseded: only three client save attempts').toBe(3)
    } else {
      expect(saves, 'NW-pend-superseded conflict: no overwrite of F').toEqual([])
      expect(stored.root?.seq, 'NW-pend-superseded conflict: only initial TS and F committed').toBe(2)
      expect(stored.root?.checkpoint?.revision, 'NW-pend-superseded conflict: durable revision remains 2').toBe(2)
      expect(`${result.result ?? ''}\n${(result.context ?? []).join('\n')}`.includes('stale'), 'NW-pend-superseded conflict: MS reports stale-writer refusal').toBe(true)
      expect(f.calls.filter(call => call.op === 'save').length, 'NW-pend-superseded conflict: rejected R is the last client save attempt').toBe(2)
      expect(f.ledger.value, 'NW-pend-superseded conflict: client keeps durable rows').toEqual(durable.ledger)
      expect(f.store.held.get(archiveKey), 'NW-pend-superseded conflict: exact archive key and content').toEqual({
        v: 1, session_id: SESSION, kind: 'conflict', value: { ledger: local, baseline, durable: durableIdentity },
      })
      const events = f.locks.timeline.slice(timelineStart)
      const archiveIndex = events.indexOf(`set:${archiveKey}`)
      const grants = [...openGrants(events.slice(0, archiveIndex))]
      expect(grants.length, 'NW-pend-superseded conflict: archive has its own single grant').toBe(1)
      expect(archiveIndex >= 0 && events.indexOf(`close:${grants[0]}`, archiveIndex) > archiveIndex, 'NW-pend-superseded conflict: archive grant closes').toBe(true)
      expect(historyOrderViolations(events), 'NW-pend-superseded conflict: archive grant never nests history').toEqual([])
    }
  })
}

test('TRACK-39 V3 NW-pend-warning public TS keeps an uncertain save distinct from unsaved', async ($, on) => {
  // Focused wrapper coverage authorized by E5 correction: TS A save 1 commits => 1/1,
  // then (save,1) loses its receipt. No CP or resolve runs; the public result is pending.
  const f = fixture(on, { commitRejectedSave: true, reject: (op, ordinal) => op === 'save' && ordinal === 1 })
  const result = await trackSteps($, f, ['A'])
  const warning = `${result.result ?? ''}\n${(result.context ?? []).join('\n')}`
  expect(warning.includes('save outcome pending'), 'NW-pend-warning: TS reports the unresolved outcome').toBe(true)
  expect(/unsaved/i.test(warning), 'NW-pend-warning: TS result and context never claim definitive unsaved').toBe(false)
  expect(f.lines.filter(line => /unsaved/i.test(line)), 'NW-pend-warning: TS emits no definitive unsaved toast').toEqual([])
  const save = f.calls.find(call => call.op === 'save')
  expect(save?.ordinal, 'NW-pend-warning: the fault targets the TS save ordinal 1').toBe(1)
  expect(typeof save?.request.request_id, 'NW-pend-warning: TS attempted a real request').toBe('string')
  expect(f.pending.value, 'NW-pend-warning: TS retains the uncertain request').toEqual({
    session_id: SESSION, request_id: save?.request.request_id, expect: save?.request.expect,
  })
  expect(stepLabels(f.ledger.value), 'NW-pend-warning: uncertain TS keeps its local rows').toEqual(['A'])
  expect(f.calls.filter(call => call.op === 'save').length, 'NW-pend-warning: only the targeted TS save runs').toBe(1)
  expect((await modelRead(f)).root?.seq, 'NW-pend-warning: the lost TS receipt follows one committed save').toBe(1)
})

for (const fault of ['postcommit', 'missing-phase', 'truncated'] as const) {
  test(`TRACK-39 V3 NW-postcommit ${fault} remains pending rather than unsaved`, async ($, on) => {
    // Sequence NW-postcommit: TS A save 1 => 1/1; CP save 2 commits R => 2/1, but
    // (save,2)'s receipt is postcommit/unphased/truncated, leaving R pending.
    const f = fixture(on, { respond: (op, request, ordinal) => {
      if (op !== 'save' || ordinal !== 2) return undefined
      const refusal = resultOf(1, { ok: false, protocol: 3, op, request_id: request.request_id,
        ...(fault === 'postcommit' ? { phase: 'postcommit' } : {}), reason: 'fixture lost commit acknowledgement' })
      return fault === 'truncated' ? { ...refusal, isStdoutTruncated: true } : refusal
    } })
    await trackSteps($, f, ['A'])
    assertPending(f, await checkpoint($, f), `NW-postcommit ${fault}`)
    const stored = await modelRead(f)
    expect(stored.root?.seq, 'NW-postcommit: TS and CP both actually committed').toBe(2)
    expect(f.calls.filter(call => call.op === 'save').length, 'NW-postcommit: fault targets CP after the successful TS save').toBe(2)
    expect(stored.root?.checkpoint?.revision, 'NW-postcommit: one semantic content save').toBe(1)
    expect(stepLabels(stored.ledger), 'NW-postcommit: actual root bytes contain local rows').toEqual(['A'])
  })
}

test('TRACK-39 V3 NW-preflight refuses an oversized encoded request before pending or spawn', async ($, on) => {
  // Sequence NW-preflight: oversized in-memory ledger; checkpoint refuses before spawn;
  // zero successful saves/fences => no root and historyPending remains null.
  const ledger = stepFixture(SESSION, ['A'], '"'.repeat(800000))
  const request = clientSaveRequest({ store: KEY, session_id: SESSION, module_token: 'fixture', request_id: SEED_REQUEST,
    expect: { absent: true }, generation: GENERATION, checkpoint: await describeCheckpoint(ledger, SESSION), savedAt: 1, ledger_text: JSON.stringify(ledger) })
  expect(byteLength(JSON.stringify(request)) > RAW_LIMIT, 'FIXTURE preflight encoded request really exceeds 3 MiB').toBe(true)
  const f = fixture(on, { ledger })
  const result = await checkpoint($, f)
  expect(result.reason?.includes('request') && result.reason.includes('too large'), 'NW-preflight: encoded request too large reason').toBe(true)
  expect(f.calls.filter(call => call.op === 'save'), 'NW-preflight: no history save spawn').toEqual([])
  expect(f.pending.value, 'NW-preflight: pending is not set').toBeNull()
  expect(f.pending.writes.some(value => value !== null), 'NW-preflight: pending was never set transiently').toBe(false)
  expect(f.model.state.roots.size, 'NW-preflight: no root commit').toBe(0)
})

test('TRACK-39 V3 NW-restore reads the source v3 root through public restore_tracker', async ($, on) => {
  // Sequence NW-restore: seed source F C1 => F seq 1/rev 1; restore F into D, whose public
  // restore saves D once => D seq 1/rev 1. F is read-only and remains seq 1/rev 1.
  const f = fixture(on)
  await seedSave(f, stepFixture(FOREIGN))
  const source = await modelRead(f, FOREIGN)
  const result = await drive(f, invoke($, 'mcp__track__restore_tracker', { from_session: FOREIGN, expected_checkpoint: source.root?.checkpoint }))
  expect(stepLabels(f.ledger.value), 'NW-restore: destination rows equal A and B').toEqual(['A', 'B'])
  expect(f.locks.timeline.includes(`get:s:${FOREIGN}`), 'NW-restore: legacy source is never content').toBe(false)
  const receipt = JSON.parse(String(result.result ?? '{}')) as Checkpoint & { open_steps?: unknown[] }
  expect(checkpointReceipt(receipt), 'NW-restore: full public source receipt confirms destination and applied values').toEqual({
    ...source.root?.checkpoint, destination_session: SESSION, applied_checksum: source.root?.checkpoint?.checksum,
  })
  const restoredSource = await modelRead(f, FOREIGN)
  expect(restoredSource.root?.seq, 'NW-restore: source keeps its single seed commit').toBe(1)
  expect(restoredSource.root?.checkpoint?.revision, 'NW-restore: source revision is unchanged').toBe(1)
  const destination = await modelRead(f)
  expect(destination.root?.seq, 'NW-restore: destination commits one restoration').toBe(1)
  expect(destination.root?.checkpoint?.revision, 'NW-restore: first destination checkpoint revision').toBe(1)
  expect(stepLabels(destination.ledger), 'NW-restore: wrapper save persists A and B into D').toEqual(['A', 'B'])
  const saves = f.calls.filter(call => call.op === 'save')
  expect(saves.length, 'NW-restore: RT wrapper makes exactly one save').toBe(1)
  expect(saves[0]?.request.session_id, 'NW-restore: the only client save belongs to D').toBe(SESSION)
})

for (const operation of ['export', 'import'] as const) {
  test(`TRACK-39 V3 NW10 flagged ${operation} refuses before writes`, async ($, on) => {
    // Sequence NW10: one flagged command; preflight refusal; zero saves/fences or store writes.
    const f = fixture(on)
    const response = await drive(f, trackCommand($, `${operation} /fixture/backup.json`))
    const result = JSON.parse(response.text ?? '{}') as { ok?: boolean; reason?: string }
    expect(result.ok, `NW10: flagged ${operation} refuses`).toBe(false)
    expect(result.reason?.includes('unavailable while TRACK_HISTORY_V3 is on'), `NW10: ${operation} opt-in limitation reason`).toBe(true)
    expect(f.locks.timeline.filter(event => event.startsWith('write:')), `NW10: ${operation} writes no client file`).toEqual([])
    expect(f.locks.timeline.filter(event => event.startsWith('set:')), `NW10: ${operation} writes no store value`).toEqual([])
    expect(f.model.state.roots.size, `NW10: ${operation} commits no root`).toBe(0)
  })
}

test('TRACK-39 V3 N0 unset flag preserves the existing public save and export flow', async ($, on) => {
  // Sequence N0: TS A,B writes legacy s:S once; CP writes s:S once more; export reads it.
  // No history save or fence is permitted, so v3 root count stays zero. Baseline control.
  const f = fixture(on, { enabled: false })
  await trackSteps($, f, ['A', 'B'])
  expect(f.locks.timeline.filter(event => event === `set:s:${SESSION}`).length, 'N0: TS automatically saves the legacy body once').toBe(1)
  const result = await checkpoint($, f)
  expect(f.locks.timeline.filter(event => event === `set:s:${SESSION}`).length, 'N0: TS plus CP write two legacy bodies').toBe(2)
  const response = await drive(f, trackCommand($, 'export /fixture/legacy-backup.json'))
  expect(result.ok, 'N0: legacy public checkpoint succeeds').toBe(true)
  expect(f.calls, 'N0: unset flag makes zero history calls').toEqual([])
  expect(f.locks.timeline.some(event => event.startsWith('run:history:')), 'N0: no history timeline entries').toBe(false)
  expect(f.store.held.has(`s:${SESSION}`), 'N0: legacy body is still written').toBe(true)
  const saved = await f.pool.logical(f.store, `s:${SESSION}`) as { ledger?: Ledger } | undefined
  expect(stepLabels(saved?.ledger), 'N0: legacy content keeps A and B').toEqual(['A', 'B'])
  expect(JSON.parse(response.text ?? '{}').ok, 'N0: legacy export still succeeds').toBe(true)
  expect(f.files.has('/fixture/legacy-backup.json'), 'N0: export bundle was written').toBe(true)
  expect(f.model.state.roots.size, 'N0: no v3 root commits').toBe(0)
  expect(f.locks.requests.every(request => TX_REQUEST.test(request.path)), 'N0: completion files stay with the kit provider').toBe(true)
})
