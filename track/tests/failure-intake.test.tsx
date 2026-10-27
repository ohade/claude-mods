// Failure-intake pins (contract-intake-r3, errata E-I1..E-I4; ruling Q65): the loaded build identity, the
// memory-only error ring, and the read-only, main-loop-only `mcp__track__diagnose` bundle.
// FIXTURE: atoms, store, git and the claim directory are stand-ins; L1 proves a real session on the landed build.
import { expect, mock, test } from 'claude-code/testing'
import { BUILD_IDENTITY } from '../hooks/build-identity'
import { EMPTY, SESSION, atomStore, pluginStore, trackCommand, trackPrompt } from './kit'
import type { Engine, On } from './kit'

const DIAGNOSE = 'mcp__track__diagnose'
const OTHER = '99999999-8888-4777-8666-555555555555'
const DISK1 = '1'.repeat(40)
const DISK2 = '2'.repeat(40)
const DISK3 = '3'.repeat(40)
const SENTINEL = 'SENTINEL-7f3a-do-not-leak'
const CONFIG = '/cfg'
const HOLDS = `${CONFIG}/state/track/stop-holds`
const FINGERPRINT = String((BUILD_IDENTITY as { source_fingerprint: unknown }).source_fingerprint)

type Git = { head: string | null; calls: number }
const runResult = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'fixture git error', isStdoutTruncated: false, isStderrTruncated: false } })

// An admitted, stable owner: the ledger names this session and no ownership transition runs.
const world = (on: On, options: { owner?: string | null; ledger?: Record<string, unknown>; pending?: unknown; activity?: unknown; head?: string | null; gateFailure?: string } = {}) => {
  const owner = options.owner === undefined ? SESSION : options.owner
  const ledger = atomStore(on, 'ledger', { ...EMPTY, ...(owner !== null && { session_id: owner }), ...options.ledger } as never)
  const turn = atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 } as never)
  const activity = atomStore(on, 'activity', (options.activity ?? { isWorking: false, agentCalls: [], askCalls: [], background: [] }) as never)
  const pending = atomStore(on, 'pending', (options.pending ?? { inputs: [], nextId: 1 }) as never)
  const durability = atomStore(on, 'durability', { isUnsaved: false, reason: '', ...(owner !== null && { memorySession: owner }) } as never)
  const store = pluginStore(on)
  let session: () => string = () => SESSION
  on('session.id', () => ({ value: session() }))
  const git: Git = { head: options.head === undefined ? DISK1 : options.head, calls: 0 }
  on('process.run', (_, e) => {
    if (e.argv[0] !== 'git' || !e.argv.includes('rev-parse')) return { deny: 'unexpected process' }
    git.calls++
    return git.head === null ? runResult(128, '') : runResult(0, `${git.head}\n`)
  })
  on('env.get', { name: 'CLAUDE_CONFIG_DIR' }, () => ({ value: CONFIG }))
  const env: string[] = []
  on('env.set', (_, e) => {
    const name = String((e as { name?: unknown }).name)
    env.push(name)
    return (options.gateFailure !== undefined && name === 'TRACK_GATE_SNAPSHOT' ? { deny: options.gateFailure } : { value: undefined }) as never
  })
  // The test's own classic.Stop hook is the bottom of the chain.
  return { ledger, turn, activity, pending, durability, store, git, env, setSession: (id: string) => { session = () => id }, sessionBy: (f: () => string) => { session = f } }
}

const call = ($: Engine, extra: Record<string, unknown> = {}): Promise<Record<string, any>> =>
  ($.tool.call({ tool: DIAGNOSE, tool_use_id: 'toolu_diag', ...extra } as never) as Promise<Record<string, any>>)
    .catch((error: unknown) => ({ thrown: String(error) }))
const bundleOf = (r: Record<string, unknown>): any => {
  if (typeof r.result !== 'string') return undefined
  try { return JSON.parse(r.result) } catch { return undefined }
}
const refusalOf = (r: Record<string, unknown>): string => String(r.deny ?? (typeof r.result === 'string' ? r.result : r.thrown ?? ''))
const stop = ($: Engine) => $.classic.Stop({ stop_hook_active: false } as never) as Promise<{ block?: string }>
const bytes = (text: string) => new TextEncoder().encode(text).length

// Identity (D1-D4)

test('[I1] diagnose and /track status show the generated module source_fingerprint', async ($, on) => {
  world(on)
  const body = bundleOf(await call($))
  expect(body?.identity?.loaded, 'identity is the bundled source_fingerprint').toBe(FINGERPRINT)
  expect(body?.observed_disk).toBe(DISK1)
  const status = (await trackCommand($, 'status')).text ?? ''
  expect(status).toContain(`track: loaded ${FINGERPRINT.slice(0, 8)} (disk ${DISK1.slice(0, 8)})`)
})

test('[I2] a disk HEAD that moves after load but before session.start leaves identity bundled; observed_disk shows it', async ($, on) => {
  const { git } = world(on)
  git.head = DISK2
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true } as never)
  const body = bundleOf(await call($))
  expect(body?.identity?.loaded).toBe(FINGERPRINT)
  expect(body?.observed_disk).toBe(DISK2)
})

test('[I3] the same module instance survives a later deploy and a second session.start', async ($, on) => {
  const { git } = world(on)
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true } as never)
  const first = bundleOf(await call($))
  git.head = DISK3
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true } as never)
  const second = bundleOf(await call($))
  expect(first?.identity?.loaded).toBe(FINGERPRINT)
  expect(second?.identity).toEqual(first?.identity)
  expect(second?.observed_disk).toBe(DISK3)
})

test('[I4a] a failing or changed git rev-parse never changes identity (no disk fallback)', async ($, on) => {
  const { git } = world(on, { head: null })
  const failed = bundleOf(await call($))
  expect(failed?.identity?.loaded).toBe(FINGERPRINT)
  expect(failed?.observed_disk, 'absent when git fails').toBeUndefined()
  git.head = DISK2
  const changed = bundleOf(await call($))
  expect(changed?.identity?.loaded).toBe(FINGERPRINT)
  expect(JSON.stringify(changed?.identity)).not.toContain(DISK2)
})

// Ring (D5, D6)

test('[R1] a forced Stop snapshot failure appears as stop.snapshot_unavailable with the turn id', async ($, on) => {
  world(on, { gateFailure: 'fixture env refused' })
  await stop($)
  const ring: any[] = bundleOf(await call($))?.ring ?? []
  expect(ring.some(e => e.code === 'stop.snapshot_unavailable' && e.turn_id === 't1'), JSON.stringify(ring)).toBe(true)
})

test('[R2] 60 events keep the newest 50, newest last; each entry at most 512 bytes', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  world(on, { gateFailure: `refused ${'é'.repeat(400)}` })
  for (let i = 0; i < 60; i++) {
    await stop($)
    await clock.advance(1_000)
  }
  const ring: any[] = bundleOf(await call($))?.ring ?? []
  expect(ring).toHaveLength(50)
  const at = ring.map(e => Number(e.at))
  expect(at, 'oldest first, newest last').toEqual([...at].sort((a, b) => a - b))
  expect(at[at.length - 1]).toBeGreaterThan(at[0]! + 40_000)
  for (const entry of ring) expect(bytes(JSON.stringify(entry))).toBeLessThanOrEqual(512)
})

// Bundle (D7-D10, E-I3)

test('[B1] a sentinel in a prompt, a question head, a pending excerpt and an error never enters the bundle', async ($, on) => {
  world(on, {
    gateFailure: `env refused: ${SENTINEL}`,
    ledger: { nextQuestionId: 2, questions: [{ id: 1, head: `${SENTINEL} question`, at: 1, turnId: 't1', status: 'open' }] },
    pending: { inputs: [{ id: 1, head: `${SENTINEL} head`, excerpt: `${SENTINEL} excerpt`, textHash: 'h1', turnId: 't1' }], nextId: 2 },
  })
  await trackPrompt($, `${SENTINEL} at the start of a prompt`)
  await stop($)
  const r = await call($)
  expect(bundleOf(r)?.v, 'a v1 bundle came back').toBe(1)
  expect(String(r.result)).not.toContain(SENTINEL)
  expect(String(r.result)).not.toContain('SENTINEL')
})

test('[B2] multibyte ids and a 10 000-id banner fit 32 KiB UTF-8, flagged as truncated', async ($, on) => {
  const ids = Array.from({ length: 10_000 }, (_, i) => `任务-😀-${i}`)
  world(on, { activity: { isWorking: true, mainTurnId: 't1', agentCalls: [], askCalls: [], background: ids, tasks: ids } })
  const r = await call($)
  const body = bundleOf(r)
  expect(body?.v).toBe(1)
  expect(bytes(String(r.result))).toBeLessThanOrEqual(32 * 1024)
  expect(body?.truncated).toBe(true)
})

test('[B3] 500 pending inputs and 50 open questions still fit, with true counts', async ($, on) => {
  const questions = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, head: `question ${i}`, at: i, turnId: 't1', status: 'open' }))
  const inputs = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, head: `input ${i}`, excerpt: 'x'.repeat(200), textHash: `h${i}`, turnId: 't1', ...(i % 2 === 0 && { held: true }) }))
  world(on, { ledger: { nextQuestionId: 51, questions }, pending: { inputs, nextId: 501 } })
  const r = await call($)
  const body = bundleOf(r)
  expect(bytes(String(r.result))).toBeLessThanOrEqual(32 * 1024)
  expect(body?.ledger?.open).toBe(50)
  expect(body?.pending?.count).toBe(500)
  expect(body?.pending?.held_count).toBe(250)
})

test('[B4] an owner not yet admitted is refused and ownership is untouched (no switchOwner)', async ($, on) => {
  const w = world(on, { owner: null })
  const r = await call($)
  expect(refusalOf(r)).toContain('track: diagnose needs an admitted owner')
  expect(bundleOf(r)).toBeUndefined()
  expect([w.ledger.writes, w.turn.writes, w.activity.writes, w.pending.writes, w.durability.writes].map(x => x.length)).toEqual([0, 0, 0, 0, 0])
})

test('[B4] the session changing during the call is refused, never old rows', async ($, on) => {
  const w = world(on)
  let reads = 0
  w.sessionBy(() => reads++ === 0 ? SESSION : OTHER)
  const r = await call($)
  expect(refusalOf(r)).toContain('track: diagnose needs an admitted owner')
  expect(bundleOf(r)).toBeUndefined()
  expect([w.turn.writes, w.activity.writes, w.pending.writes].map(x => x.length)).toEqual([0, 0, 0])
})

test('[B4/E-I3] a later owner never sees the prior owner\'s cached gate or ring', async ($, on) => {
  const w = world(on, { gateFailure: 'fixture env refused' })
  await stop($)
  w.setSession(OTHER)
  w.ledger.value = { ...EMPTY, session_id: OTHER } as never
  w.durability.value = { isUnsaved: false, reason: '', memorySession: OTHER } as never
  const r = await call($)
  const body = bundleOf(r)
  if (body === undefined) expect(refusalOf(r)).toContain('track: diagnose')
  else expect(JSON.stringify({ ring: body.ring, gate: body.gate })).not.toContain('stop.snapshot_unavailable')
})

test('[B5] read-only: atoms, env and files unchanged; no lease spawn; the gate is not republished', async ($, on) => {
  const w = world(on)
  const fsWrites: string[] = []
  on('fs.write', (_, e) => { fsWrites.push(String((e as { path?: unknown }).path)); return { value: undefined } })
  const spawnsBefore = w.store.locks?.spawns.length ?? 0
  const before = JSON.stringify([w.ledger.value, w.turn.value, w.activity.value, w.pending.value, w.durability.value])
  const envBefore = w.env.length
  const r = await call($)
  expect(bundleOf(r)?.v, 'a v1 bundle came back').toBe(1)
  expect(JSON.stringify([w.ledger.value, w.turn.value, w.activity.value, w.pending.value, w.durability.value])).toBe(before)
  expect([w.ledger.writes, w.turn.writes, w.activity.writes, w.pending.writes, w.durability.writes].map(x => x.length)).toEqual([0, 0, 0, 0, 0])
  expect(w.env.slice(envBefore), 'no env.set, TRACK_GATE_SNAPSHOT included').toEqual([])
  expect(fsWrites).toEqual([])
  expect(w.store.locks?.spawns.length ?? 0, 'no writer lease').toBe(spawnsBefore)
})

test('[B6] claims are stat only, for this session only; a planted other-session claim is not listed', async ($, on) => {
  world(on)
  const listed: string[] = []
  const read: string[] = []
  on('fs.list', (_, e) => { listed.push(String((e as { path?: unknown }).path)); return { value: [] } })
  on('fs.read', (_, e) => {
    const path = String((e as { path?: unknown }).path)
    if (path.startsWith(HOLDS)) read.push(path)
    return { deny: 'fixture: no such file' }
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([OTHER, 't1', 'untracked_edit'])))
  const planted = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
  on('fs.stat', (_, e) => (String((e as { path?: unknown }).path).startsWith(HOLDS) ? { value: { kind: 'file', size: 64 } } : { deny: 'fixture: no such file' }) as never)
  const r = await call($)
  expect(bundleOf(r)?.v, 'a v1 bundle came back').toBe(1)
  expect(listed.filter(path => path.startsWith(HOLDS)), 'no directory listing').toEqual([])
  expect(read, 'contents never read').toEqual([])
  expect(String(r.result)).not.toContain(planted)
  expect(String(r.result)).not.toContain(OTHER)
})

// Exposure (D11)

test('[X1] a subagent call is refused with the documented text', async ($, on) => {
  world(on)
  const r = await call($, { agentId: 'agent-1' })
  expect(refusalOf(r)).toContain('track: diagnose is main-loop only')
  expect(bundleOf(r)).toBeUndefined()
})

test('[X2] an unknown owner identity is refused', async ($, on) => {
  world(on).sessionBy(() => { throw new Error('identity unavailable') })
  const r = await call($)
  expect(refusalOf(r)).toContain('track: diagnose needs an admitted owner')
  expect(bundleOf(r)).toBeUndefined()
})
