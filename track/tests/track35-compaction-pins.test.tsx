// FIXTURE: TRACK-35 U2b refuter pins. Compaction's fail-closed rules each get a test: the
// guarded re-read and its ordering (item 3c), a re-read that throws after a failed pointer write (item 3e), and
// the stored saved-index patch for callers that publish no planned index (item 4).
import { expect, test } from 'claude-code/testing'
import { atomStore, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'
import { describeCheckpoint } from '../hooks/checkpoint'

const CONFIG = '/fixture/config'
const BLOBS = `${CONFIG}/state/track/blobs`
const GENERATION = '99999999-8888-4777-8666-555555555555'
const encoder = new TextEncoder()
const utf8 = (text: string) => encoder.encode(text).length
// Families 50+ so no id is shared with track35-compaction.test.tsx.
const idOf = (family: number, n: number) => `cccccccc-0000-4000-8000-${String(family * 100 + n).padStart(12, '0')}`
const callerOf = (family: number) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(family).padStart(12, '0')}`
const sha256 = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))), b => b.toString(16).padStart(2, '0')).join('')

const durable = async (session: string, pad: number, savedAt: number) => {
  const ledger = {
    v: 1, nextQuestionId: 2, prompts: [],
    questions: [{ id: 1, head: 'Closed question', at: 1, turnId: 'old', status: 'deferred', note: 'n'.repeat(pad), session_id: session }],
    steps: [{ id: 'plan:1', subject: 'Closed step', source: 'plan', status: 'in_progress', session_id: session }],
    session_id: session,
  }
  const checkpointRecord = await describeCheckpoint(ledger as never, session)
  return {
    body: { v: 1, session_id: session, generation: GENERATION, savedAt, ledger, checkpoint: checkpointRecord } as Record<string, unknown>,
    head: { v: 1, session_id: session, generation: GENERATION, checkpoint: checkpointRecord },
  }
}
const pointerOf = async (body: Record<string, unknown>) => {
  const text = JSON.stringify(body.ledger)
  const blob = { checksum: await sha256(text), bytes: utf8(text) }
  return { blob, pointer: Object.fromEntries(Object.entries(body).map(([key, value]) =>
    key === 'v' ? [key, 2] : key === 'ledger' ? ['ledger_blob', blob] : [key, value])) }
}
// Big values compare by length and SHA-256, so a failure report stays small.
const print = async (value: unknown) => value === undefined ? 'absent' : `${JSON.stringify(value).length}:${await sha256(JSON.stringify(value))}`
const rawBytes = (key: string, value: unknown) => utf8(JSON.stringify({ [key]: value })) + 1

// Four CLOSED sessions, 3.2 MB of ledger text against the 3 MiB budget; compacting `big`
// alone makes the caller's save fit.
const PADS = [950000, 800000, 750000, 700000]
const AGES = [3000, 4000, 2000, 1000]
const prefill = async (family: number) => {
  const sessions = PADS.map((_, n) => idOf(family, n + 1))
  const records: Record<string, unknown> = { cleanup: { v: 1, lastAttempt: Date.now(), cursor: '' } }
  const saved: Record<string, unknown> = {}
  const bodies: Record<string, Record<string, unknown>> = {}
  const states: Record<string, 'live' | 'closed'> = {}
  for (const [n, session] of sessions.entries()) {
    const { body, head } = await durable(session, PADS[n]!, AGES[n]!)
    bodies[session] = body
    records[`s:${session}`] = body
    records[`h:${session}`] = head
    saved[session] = { at: AGES[n]!, bytes: rawBytes(`s:${session}`, body), unfinished: true }
    states[session] = 'closed'
  }
  records.saved = saved
  return { sessions, records, bodies, states, big: sessions[0]! }
}

type Options = {
  states: Record<string, 'live' | 'closed'>
  refuseSet?: (key: string, value: unknown) => string | undefined
  beforeGet?: (key: string) => void
  beforeLockSpawn?: (request: { argv: readonly string[]; cwd?: string }) => void
  afterPublish?: (checksum: string) => void
}
// The blob-fs.py stub publishes into `files` the way the real helper does on success.
const setup = (on: On, caller: string, records: Record<string, unknown>, files: Map<string, string>, options: Options) => {
  atomStore<any>(on, 'ledger', { v: 1, nextQuestionId: 1, prompts: [], questions: [], steps: [] })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null, eventOrder: 0 })
  const store = pluginStore(on, records, undefined, { guardStates: options.states, refuseSet: options.refuseSet, beforeGet: options.beforeGet, beforeLockSpawn: options.beforeLockSpawn })
  const lines = logs(on)
  on('session.id', () => ({ value: caller }))
  on('env.get', (_, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? CONFIG : undefined }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT: no such file: ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => { files.set(e.path, String(e.text)); return { value: undefined } })
  on('process.run', { argv: /blob-fs\.py$/ }, async (_, e) => {
    expect(e.argv.slice(2, 4)).toEqual(['publish', BLOBS])
    const text = String(e.init?.stdin ?? '')
    const checksum = e.argv[4]!
    expect(await sha256(text)).toBe(checksum)
    files.set(`${BLOBS}/${checksum}.json`, text)
    options.afterPublish?.(checksum)
    return { value: { exitCode: 0, stdout: `${JSON.stringify({ ok: true, checksum, bytes: utf8(text) })}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { store, lines }
}

const checkpoint = async ($: Engine, id: string) =>
  JSON.parse(String((await $.tool.call({ tool: 'mcp__track__checkpoint', expected_session: id } as never)).result ?? '{}'))

test('TRACK-35 U2b pin 3c: a body the owner rewrites after publication survives unchanged', async ($, on) => {
  const caller = callerOf(50)
  const { sessions, records, bodies, states, big } = await prefill(50)
  const files = new Map<string, string>()
  const target = (await pointerOf(bodies[big]!)).blob.checksum
  // Same byte size as the original, so the capacity index stays exact.
  const newer = { ...bodies[big]!, savedAt: AGES[0]! + 1 }
  let rewritten = false
  const { store, lines } = setup(on, caller, records, files, { states, afterPublish: checksum => {
    if (checksum !== target) return
    store.held.set(`s:${big}`, newer)
    rewritten = true
  } })
  const result = await checkpoint($, caller)
  expect(rewritten).toBe(true)
  expect(result.reason).toBeUndefined()
  expect(result.ok).toBe(true)
  expect(await print(store.held.get(`s:${big}`))).toBe(await print(newer))
  expect(lines.some(line => line.startsWith(`track: compaction keeps ${big}: body changed`))).toBe(true)
  expect(lines.filter(line => line.includes('was evicted'))).toEqual([])
  for (const session of sessions) expect(store.held.has(`s:${session}`)).toBe(true)
})

test('TRACK-35 U2b pin 3c order: a body the owner rewrites during guard confirmation survives unchanged', async ($, on) => {
  const caller = callerOf(54)
  const { sessions, records, bodies, states, big } = await prefill(54)
  const files = new Map<string, string>()
  const target = (await pointerOf(bodies[big]!)).blob.checksum
  // Same byte size as the original, so the capacity index stays exact.
  const newer = { ...bodies[big]!, savedAt: AGES[0]! + 1 }
  let armed = false
  let rewritten = false
  const { store, lines } = setup(on, caller, records, files, {
    states,
    afterPublish: checksum => { if (checksum === target) armed = true },
    beforeLockSpawn: request => {
      if (!armed || request.argv[2] !== 'guard' || request.argv[3] !== big) return
      armed = false
      store.held.set(`s:${big}`, newer)
      rewritten = true
    },
  })
  const result = await checkpoint($, caller)
  expect(rewritten).toBe(true)
  expect(result.reason).toBeUndefined()
  expect(result.ok).toBe(true)
  expect(await print(store.held.get(`s:${big}`))).toBe(await print(newer))
  expect(lines.some(line => line.startsWith(`track: compaction keeps ${big}: body changed`))).toBe(true)
  expect(lines.filter(line => line.includes('was evicted'))).toEqual([])
  for (const session of sessions) expect(store.held.has(`s:${session}`)).toBe(true)
})

test('TRACK-35 U2b pin 3e: a re-read that throws after a failed pointer write fails the save closed', async ($, on) => {
  const caller = callerOf(51)
  const { sessions, records, bodies, states, big } = await prefill(51)
  const files = new Map<string, string>()
  let armed = false
  let thrown = false
  const refuseSet = (key: string, value: unknown) => {
    if (key !== `s:${big}` || (value as { v?: unknown }).v !== 2) return undefined
    armed = true
    return 'pointer write refused'
  }
  const beforeGet = (key: string) => {
    if (!armed || key !== `s:${big}`) return
    armed = false
    thrown = true
    throw new Error('store read failed once')
  }
  const { store, lines } = setup(on, caller, records, files, { states, refuseSet, beforeGet })
  const result = await checkpoint($, caller)
  expect(thrown).toBe(true)
  expect(result.ok).toBe(false)
  expect(String(result.reason)).toContain(`compaction left ${big} in an uncertain state`)
  expect(lines.filter(line => line.includes('was evicted'))).toEqual([])
  for (const session of sessions) expect(store.held.has(`s:${session}`)).toBe(true)
  for (const session of [...sessions, caller]) expect(store.held.has(`cleanup:${session}`)).toBe(false)
  expect(await print(store.held.get(`s:${big}`))).toBe(await print(bodies[big]))
  for (const session of sessions.slice(1)) expect(await print(store.held.get(`s:${session}`))).toBe(await print(bodies[session]))
})

test('TRACK-35 U2b pin 4a: a save that fails after compaction leaves the stored index at the raw v:2 size', async ($, on) => {
  const caller = callerOf(52)
  const { records, bodies, states, big } = await prefill(52)
  const files = new Map<string, string>()
  // The caller's own body write is refused, so the save never publishes its planned index.
  const refuseSet = (key: string) => key === `s:${caller}` ? 'caller write refused' : undefined
  const { store } = setup(on, caller, records, files, { states, refuseSet })
  const result = await checkpoint($, caller)
  expect(result.ok).toBe(false)
  expect(store.held.has(`s:${caller}`)).toBe(false)
  const { pointer } = await pointerOf(bodies[big]!)
  expect(await print(store.held.get(`s:${big}`))).toBe(await print(pointer))
  const index = store.held.get('saved') as Record<string, unknown>
  expect(index[big]).toEqual({ at: AGES[0], bytes: rawBytes(`s:${big}`, pointer), unfinished: true })
})

test('TRACK-35 U2b pin 4b: a refused stored-index patch after a committed conversion fails the save', async ($, on) => {
  const caller = callerOf(53)
  const { sessions, records, bodies, states, big } = await prefill(53)
  const files = new Map<string, string>()
  const { pointer } = await pointerOf(bodies[big]!)
  const compactedBytes = rawBytes(`s:${big}`, pointer)
  // Only compaction's own patch of the stored index: the caller's planned index names the caller.
  let refused = false
  const refuseSet = (key: string, value: unknown) => {
    const index = value as Record<string, { bytes?: unknown }>
    if (key !== 'saved' || Object.hasOwn(index, caller) || index[big]?.bytes !== compactedBytes) return undefined
    refused = true
    return 'saved index write refused'
  }
  const { store, lines } = setup(on, caller, records, files, { states, refuseSet })
  const result = await checkpoint($, caller)
  expect(refused).toBe(true)
  expect(result.ok).toBe(false)
  expect(store.held.has(`s:${caller}`)).toBe(false)
  // The conversion stays committed; nothing is evicted.
  expect(await print(store.held.get(`s:${big}`))).toBe(await print(pointer))
  expect(lines.filter(line => line.includes('was evicted'))).toEqual([])
  for (const session of sessions) expect(store.held.has(`s:${session}`)).toBe(true)
})
