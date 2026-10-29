// FIXTURE: diagnose read-port conformance; no native or LIVE claim.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import type { Activity, Ledger, Pending, Turn } from '../../types'
import type { DiagnosePorts } from '../../hooks/diagnose-flow'
import type { Bundle, GateProjection, RingEntry } from '../../hooks/diagnose-bundle'

const source = (name: string) => readFileSync(new URL(`../../hooks/${name}`, import.meta.url), 'utf8')
for (const name of ['diagnose-bundle.ts', 'diagnose-flow.ts']) {
  assert.ok(existsSync(new URL(`../../hooks/${name}`, import.meta.url)), `missing diagnose boundary: ${name}`)
  assert.ok(source(name).trimEnd().split('\n').length <= 100, `${name} stays within 100 readable lines`)
  assert.doesNotMatch(source(name), /claude-code|\batom\(|\bstore\b|\bRuntime\b|\bsetTimeout\b/, `${name} has no native capability`)
}
const composition = source('register.tsx')
for (const symbol of ['diagnose', 'fitBundle', 'utf8Bytes']) assert.doesNotMatch(composition, new RegExp(`^const ${symbol}\\b`, 'm'), `composition imports ${symbol}`)
for (const [file, symbols] of [['diagnose-bundle.ts', ['fitBundle', 'DIAGNOSE_BYTES']], ['diagnose-flow.ts', ['diagnose', 'DIAGNOSE_OWNER', 'DIAGNOSE_MAIN_LOOP']]] as const) {
  for (const symbol of symbols) assert.match(source(file), new RegExp(`^export const ${symbol}\\b`, 'm'), `${file} owns ${symbol}`)
}
assert.match(source('ledger-text.ts'), /^export const utf8Bytes\b/m)
assert.ok(readFileSync(import.meta.filename, 'utf8').trimEnd().split('\n').length <= 180, 'conformance check stays within 180 readable lines')
const { diagnose, DIAGNOSE_OWNER, DIAGNOSE_MAIN_LOOP } = await import('../../hooks/diagnose-flow')
const { fitBundle, DIAGNOSE_BYTES } = await import('../../hooks/diagnose-bundle')
const { utf8Bytes } = await import('../../hooks/ledger-text')
assert.equal(DIAGNOSE_BYTES, 32768)
assert.equal(DIAGNOSE_OWNER, 'track: diagnose needs an admitted owner')
assert.equal(DIAGNOSE_MAIN_LOOP, 'track: diagnose is main-loop only')
const fixture = () => {
  const trace: string[] = []
  let epoch = 7; let running = false; let sessions = 0; let admissions = 0
  const ledger: Ledger = { v: 1, session_id: 'owner', nextQuestionId: 4, prompts: [], questions: [
    { id: 1, head: 'SECRET', at: 1, turnId: 'turn', status: 'open' },
    { id: 2, head: 'SECRET', at: 2, turnId: 'turn', status: 'answered' },
    { id: 3, head: 'SECRET', at: 3, turnId: 'turn', status: 'open', cleared: true }], steps: [
    { id: 'one', subject: 'SECRET', source: 'plan', status: 'waiting' },
    { id: 'two', subject: 'SECRET', source: 'plan', status: 'completed' },
    { id: 'old', subject: 'SECRET', source: 'plan', status: 'pending', cleared: true }] }
  const turn: Turn = { currentId: 'turn', gatedTurnId: 'turn', freshness: { turnId: 'turn', edits: ['SECRET'], bash: [], steps: ['one'], completed: [{ id: 'two' }], waiting: ['one'], held: ['untracked_edit'], nudged: [] } }
  const activity: Activity = { isWorking: true, agentCalls: [], askCalls: [], background: ['bg'], tasks: ['task'], launchSeq: 3 }
  const pending: Pending = { nextId: 3, inputs: [{ id: 1, head: 'SECRET', excerpt: 'SECRET', textHash: 'SECRET', turnId: 'turn', held: true }, { id: 2, head: 'SECRET', excerpt: 'SECRET', textHash: 'SECRET', turnId: 'turn', covered: 'steps' }] }
  const gate: GateProjection = { session_id: 'owner', gate: { open_count: 1, input_count: 2, inputs_complete: false, candidate_kinds: [], held: [], truncated: false } }
  const entry: RingEntry = { at: 1, code: 'code', meta: { count: 2 } }
  const ports: DiagnosePorts = {
    epoch: () => { trace.push('epoch'); return epoch },
    sessionId: async () => { trace.push(`session:${++sessions}`); return 'owner' },
    isAdmitted: async (captured, id) => { trace.push(`admit:${++admissions}`); return !running && epoch === captured && id === ledger.session_id },
    readLedger: async () => { trace.push('ledger'); return ledger },
    readTurn: async () => { trace.push('turn'); return turn },
    readActivity: async () => { trace.push('activity'); return activity },
    readPending: async () => { trace.push('pending'); return pending },
    observedDisk: async () => { trace.push('disk'); return 'disk-sha' },
    claimStats: async (id, turnId, held) => { trace.push('claims'); assert.deepEqual([id, turnId, held], ['owner', 'turn', [1]]); return [{ name: 'claim', kind: 'untracked_edit', present: true }] },
    cachedGate: () => { trace.push('cache'); return gate },
    events: () => { trace.push('events'); return [{ owner: 'other', entry: { ...entry, code: 'FOREIGN' } }, { owner: 'owner', entry }] },
    identity: { loaded: 'fixture' },
  }
  return { ports, trace, ledger, turn, gate, entry, changeEpoch: () => { epoch++ }, changeRunning: () => { running = true } }
}
const result = async (ports: DiagnosePorts) => {
  const response = await diagnose(ports, {})
  assert.ok('result' in response, 'admitted owner gets a bundle')
  assert.ok(!response.result.includes('SECRET') && !response.result.includes('FOREIGN'), 'private text and foreign rows excluded')
  return JSON.parse(response.result)
}
const f = fixture(); const bundle = await result(f.ports)
assert.deepEqual(f.trace, ['epoch', 'session:1', 'admit:1', 'ledger', 'turn', 'activity', 'pending', 'disk', 'claims', 'cache', 'events', 'session:2', 'admit:2'], 'snapshot and final admission order')
assert.deepEqual(bundle.ledger, { questions: 2, open: 1, steps: 2, by_status: { waiting: 1, completed: 1 } })
assert.deepEqual(bundle.pending, { count: 2, held_count: 1, covered_count: 1 })
assert.deepEqual(bundle.turn.freshness, { turn_id: 'turn', edits: 1, bash: 0, steps: 1, completed_ids: ['two'], waiting_ids: ['one'], held: ['untracked_edit'], nudged: [] })
assert.equal(bundle.observed_disk, 'disk-sha'); assert.deepEqual(bundle.gate, f.gate.gate)
assert.deepEqual(bundle.ring, [f.entry]); assert.equal(bundle.truncated, false)
for (const mode of ['agent', 'initial-session', 'not-admitted', 'final-session', 'final-session-error', 'epoch', 'running'] as const) {
  const f = fixture(); let calls = 0
  if (mode === 'initial-session') f.ports.sessionId = async () => { f.trace.push('failed-session'); throw Error('fixture') }
  if (mode === 'not-admitted') f.ports.isAdmitted = async () => { f.trace.push('denied'); return false }
  if (mode.startsWith('final-session')) f.ports.sessionId = async () => { if (++calls === 1) return 'owner'; if (mode.endsWith('error')) throw Error('fixture'); return 'other' }
  if (mode === 'epoch' || mode === 'running') f.ports.claimStats = async () => { mode === 'epoch' ? f.changeEpoch() : f.changeRunning(); return [] }
  assert.deepEqual(await diagnose(f.ports, mode === 'agent' ? { agentId: 'child' } : {}), { deny: mode === 'agent' ? DIAGNOSE_MAIN_LOOP : DIAGNOSE_OWNER }, `${mode} must deny`)
  if (mode === 'agent') assert.deepEqual(f.trace, [], 'agent denial precedes every read')
  if (mode === 'initial-session' || mode === 'not-admitted') assert.ok(!f.trace.includes('ledger'), 'failed admission reads no snapshots')
}
const exceptional = fixture()
exceptional.ports.claimStats = async () => { throw Error('fixture') }
exceptional.ports.observedDisk = async () => undefined
exceptional.turn.freshness!.turnId = 'stale'; exceptional.gate.session_id = 'other'
const sparse = await result(exceptional.ports)
assert.equal(sparse.claims, null); assert.equal(sparse.turn.freshness, null); assert.equal(sparse.gate, null)
assert.ok(!('observed_disk' in sparse), 'missing disk is omitted')
const synchronous = fixture()
synchronous.ports.cachedGate = () => { synchronous.trace.push('cache'); queueMicrotask(() => { synchronous.entry.at = 99; synchronous.entry.meta.count = 99 }); return synchronous.gate }
const snap = await result(synchronous.ports)
assert.equal(snap.ring[0].at, 1, 'cache/events/fit has no await after claims')
assert.equal(snap.ring[0].meta.count, 2, 'entry/meta copied before asynchronous restamp')
const base = (): Bundle => ({ v: 1, identity: { loaded: 'fixture' }, session_id: 'owner', ring: [], activity: { background_ids: [], task_ids: [] }, turn: { freshness: { completed_ids: [], waiting_ids: [] } }, claims: [], truncated: false })
const oversized = base(); oversized.ring = [{ at: 1, code: 'old', meta: { text: '界'.repeat(12000) } }, { at: 2, code: 'new', meta: {} }]
const trimmed = JSON.parse(fitBundle(oversized))
assert.equal(utf8Bytes(trimmed) <= DIAGNOSE_BYTES, true)
assert.deepEqual(trimmed.ring.map((row: RingEntry) => row.code), ['new'], 'oldest event removed first')
assert.equal(trimmed.ring_truncated, true); assert.equal(trimmed.truncated, true)
const priority = base(); priority.activity.background_ids = ['界'.repeat(12000)]; priority.activity.task_ids = ['kept']
priority.turn.freshness.completed_ids = ['completed']; priority.turn.freshness.waiting_ids = ['waiting']; priority.claims = ['claim']
const ordered = JSON.parse(fitBundle(priority))
assert.deepEqual(ordered.activity.background_ids, []); assert.equal(ordered.activity.background_ids_truncated, true)
assert.deepEqual(ordered.activity.task_ids, ['kept']); assert.deepEqual(ordered.turn.freshness.completed_ids, ['completed'])
for (const [holder, key] of [['activity', 'task_ids'], ['freshness', 'completed_ids'], ['freshness', 'waiting_ids'], ['root', 'claims']]) {
  const input = base(); const target = holder === 'root' ? input : holder === 'activity' ? input.activity : input.turn.freshness
  const full = Array.from({ length: 80 }, (_, i) => `${i}界${'界'.repeat(200)}`); target[key!] = full
  const fitted = JSON.parse(fitBundle(input)); const kept = holder === 'root' ? fitted : holder === 'activity' ? fitted.activity : fitted.turn.freshness
  assert.ok(utf8Bytes(fitted) <= DIAGNOSE_BYTES); assert.equal(kept[`${key}_truncated`], true)
  assert.deepEqual(kept[key!], full.slice(0, kept[key!].length), `${key} keeps a prefix`)
  kept[key!].push(full[kept[key!].length]); assert.ok(utf8Bytes(fitted) > DIAGNOSE_BYTES, `${key} keeps the longest fitting prefix`)
}
const impossible = base(); impossible.extra = '界'.repeat(12000)
assert.equal(fitBundle(impossible), JSON.stringify({ v: 1, identity: impossible.identity, session_id: impossible.session_id, truncated: true }), 'minimal fallback bytes unchanged')
console.log('diagnose-boundary: privacy, denial, read order and UTF-8 caps satisfied (FIXTURE)')
