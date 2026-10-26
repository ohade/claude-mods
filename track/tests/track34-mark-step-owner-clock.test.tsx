// FIXTURE, TRACK-34 Unit 2 (2026-10-25): an A mark held at clock.now must
// refuse after B takes ownership. Native execution is pending; this is not LIVE proof.
import { expect, mock, test } from 'claude-code/testing'
import type { PluginState } from 'claude-code'
import { describeCheckpoint } from '../hooks/checkpoint'
import type { Activity, Ledger, Pending, Turn } from '../types'
import { EMPTY, atomStore, blobPool, pluginStore } from './kit'
import type { On } from './kit'

const A = 'aaaaaaaa-0000-4000-8000-000000000034'
const B = 'bbbbbbbb-0000-4000-8000-000000000034'
const GENERATION = 'dddddddd-0000-4000-8000-000000000034'
const CONFIG = '/fixture/config'
const NOW = 10000
const MARK_CALL = 'unit2-a-held-mark-clock'
const OWNER_CHANGED = 'track: mcp__track__mark_step was not recorded: session owner changed during the call.'
const encoder = new TextEncoder()
const hash = async (text: string) => Array.from(new Uint8Array(
  await crypto.subtle.digest('SHA-256', encoder.encode(text)),
), byte => byte.toString(16).padStart(2, '0')).join('')

const savedRows = async (id: string, name: string): Promise<Ledger> => ({
  v: 1, session_id: id, nextQuestionId: 2, prompts: [],
  questions: [{ session_id: id, id: 1, head: `${name} open question`, at: 4,
    turnId: `${name}-saved-turn`, status: 'open', trackedBy: `${name}-open-call`, note: `${name} question context` }],
  steps: [{ session_id: id, id: 'plan:1', source: 'plan', subject: `${name} saved step`,
    status: 'completed', note: `${name} step context`, startedAt: 10, endedAt: 20,
    resultText: `${name} complete saved step result.`,
    resultTextHash: await hash(JSON.stringify(`${name} complete saved step result.`)),
    resultRequestId: `${name}-result-call`, resultAt: 20 }],
})

const seed = async (id: string, name: string, files: Map<string, string>) => {
  const rows = await savedRows(id, name)
  const text = JSON.stringify(rows)
  const ref = { checksum: await hash(text), bytes: encoder.encode(text).length }
  const path = `${CONFIG}/state/track/blobs/${ref.checksum}.json`
  files.set(path, text)
  // The accepted helper creates valid durable metadata. Expected bytes are
  // captured before providers can see these objects, never from plugin output.
  const checkpoint = await describeCheckpoint(rows, id)
  const body = { v: 2, session_id: id, generation: GENERATION, savedAt: 1000, ledger_blob: ref, checkpoint }
  const head = { v: 1, session_id: id, generation: GENERATION, checkpoint }
  const entry = { at: 1000, bytes: encoder.encode(JSON.stringify({ [`s:${id}`]: body })).length + 1, unfinished: true }
  return { body, head, entry, path, text, bodyText: JSON.stringify(body), headText: JSON.stringify(head),
    checkpointText: JSON.stringify(checkpoint) }
}
type Seed = Awaited<ReturnType<typeof seed>>
type Durability = PluginState['track']['durability']

const setup = async (on: On) => {
  const files = new Map<string, string>()
  const a = await seed(A, 'A', files)
  const b = await seed(B, 'B', files)
  const saved = { [A]: a.entry, [B]: b.entry }
  const savedText = JSON.stringify(saved)
  const controls = { session: A }
  const starts: string[] = []
  mock.clock(on, { now: NOW })
  mock.session(on)
  const memory = atomStore<Ledger>(on, 'ledger', { ...EMPTY, session_id: A })
  atomStore<Pending>(on, 'pending', { inputs: [], nextId: 1 })
  atomStore<Turn>(on, 'turn', { currentId: null, gatedTurnId: null })
  atomStore<Activity>(on, 'activity', { isWorking: false, agentCalls: [], askCalls: [], background: [], tasks: [] })
  const durability = atomStore<Durability>(on, 'durability', { isUnsaved: false, reason: '', memorySession: A })
  atomStore(on, 'scroll', { questions: null, steps: null })
  on('session.id', () => ({ value: controls.session }))
  const pool = blobPool(on, { files, configDir: CONFIG })
  const store = pluginStore(on, { [`s:${A}`]: a.body, [`h:${A}`]: a.head,
    [`s:${B}`]: b.body, [`h:${B}`]: b.head, saved })
  on('classic.SessionStart', (_, e) => { starts.push(e.session_id); return {} })
  on('session.messages', () => ({ value: [{ role: 'assistant', text: '', toolUses:
    ['A', 'B'].flatMap(name => ['open', 'result'].map(kind => ({
      tool_use_id: `${name}-${kind}-call`, tool: 'fixture_saved_call', input: {},
    }))) }] }))
  return { a, b, savedText, controls, starts, files, pool, store, memory, durability }
}
type Fixture = Awaited<ReturnType<typeof setup>>

const baseline = (saved: Seed, id: string) => ({ session_id: id, ledger: JSON.parse(saved.text),
  checkpoint: JSON.parse(saved.checkpointText), generation: GENERATION })
const history = async (fixture: Fixture, id: string, saved: Seed) => ({
  bodyBytes: JSON.stringify(fixture.store.held.get(`s:${id}`)),
  headBytes: JSON.stringify(fixture.store.held.get(`h:${id}`)),
  blobBytes: fixture.files.get(saved.path),
  ledger: (await fixture.pool.logical(fixture.store, `s:${id}`) as { ledger: Ledger }).ledger,
})
const expectedHistory = (saved: Seed) => ({ bodyBytes: saved.bodyText,
  headBytes: saved.headText, blobBytes: saved.text, ledger: JSON.parse(saved.text) })
const state = async (fixture: Fixture) => ({ memory: fixture.memory.value,
  a: await history(fixture, A, fixture.a), b: await history(fixture, B, fixture.b),
  saved: fixture.store.held.get('saved'),
  archives: [...fixture.store.held.entries()].filter(([key]) => key.startsWith('r:')).map(([, value]) => value),
  ownership: { memorySession: fixture.durability.value.memorySession, baseline: fixture.durability.value.baseline },
  starts: fixture.starts,
})
const expectedState = (fixture: Fixture, selected: 'A' | 'B') => ({
  memory: JSON.parse((selected === 'A' ? fixture.a : fixture.b).text),
  a: expectedHistory(fixture.a), b: expectedHistory(fixture.b), saved: JSON.parse(fixture.savedText),
  archives: selected === 'A' ? [] : [{ v: 1, session_id: B, kind: 'session-switch',
    value: { source_session: A, ledger: JSON.parse(fixture.a.text) } }],
  ownership: { memorySession: selected === 'A' ? A : B,
    baseline: selected === 'A' ? baseline(fixture.a, A) : baseline(fixture.b, B) },
  starts: [A],
})

// The fixed wall-time bound limits fixture orchestration. A deadline is an
// invalid run, never behavioral RED and never a reason to increase the bound.
const fixtureWait = async <T,>(request: Promise<T>, phase: string): Promise<T> => {
  const timers = globalThis as unknown as {
    setTimeout: (run: () => void, ms: number) => unknown; clearTimeout: (timer: unknown) => void
  }
  let timer: unknown
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = timers.setTimeout(() => reject(new Error(`INVALID FIXTURE: deadline during ${phase}`)), 2000)
    })])
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer)
  }
}
const outcome = async <T,>(request: Promise<T>) => {
  try { return { value: await request } }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
}

test('FIXTURE TRACK34 held mark_step clock preserves B and returns an owner-changed error', async ($, on) => {
  let armClock = false
  let clockHeld = false
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  // Register before setup/mock.clock: this terminal provider cannot be bypassed
  // by the later mock. Only A's first post-resume clock call is held.
  on('clock.now', {}, async () => {
    if (armClock) {
      armClock = false
      clockHeld = true
      enter()
      await released
    }
    return { value: NOW }
  })
  const fixture = await setup(on)
  await $.classic.SessionStart({ source: 'resume', session_id: A })
  expect(await state(fixture)).toEqual(expectedState(fixture, 'A'))
  armClock = true
  const request = outcome($.tool.call({ tool: 'mcp__track__mark_step', tool_use_id: MARK_CALL,
    id: 'plan:1', status: 'in_progress', note: 'A held mark must never reach B' } as never))
  try {
    const phase = await fixtureWait(Promise.race([
      entered.then(() => 'held'), request.then(() => 'returned'),
    ]), 'mark clock admission')
    if (phase !== 'held') throw new Error('INVALID FIXTURE: A mark returned before its clock hold')
    expect(clockHeld).toBe(true)
    expect(await state(fixture)).toEqual(expectedState(fixture, 'A'))
    fixture.controls.session = B
    const lookup = await fixtureWait($.tool.call({ tool: 'mcp__track__lookup_rows',
      tool_use_id: 'unit2-b-lookup-held-mark-clock' } as never), 'B selection before mark release')
    expect(lookup.deny).toBeUndefined()
    expect(lookup.isError).not.toBe(true)
    expect(JSON.parse(String(lookup.result))).toEqual({ ok: true, rows: [
      { label: 'S1', id: 'plan:1', kind: 'step', status: 'completed', subject: 'B saved step' },
      { label: 'Q1', id: 'question:1', kind: 'question', status: 'open', subject: 'B open question' },
    ],
    })
    expect(await state(fixture)).toEqual(expectedState(fixture, 'B'))
    release()
    const marked = await fixtureWait(request, 'stale mark completion')
    // Updating by id alone would turn B's completed plan:1 into in_progress
    // and change its note, so it fails this named assertion.
    expect({ heldMarkClockDoesNotChangeB: await state(fixture) }).toEqual({
      heldMarkClockDoesNotChangeB: expectedState(fixture, 'B'),
    })
    expect({ heldMarkClockOwnerChangedReceipt: { error: marked.error, deny: marked.value?.deny,
      isError: marked.value?.isError, result: marked.value?.result } }).toEqual({
      heldMarkClockOwnerChangedReceipt: { error: undefined, deny: undefined, isError: true, result: OWNER_CHANGED },
    })
  } finally {
    release()
    await fixtureWait(request, 'mark cleanup')
  }
})
