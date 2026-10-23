import { expect, test } from 'claude-code/testing'

import { EMPTY, SESSION, atomStore, blobPool, logs, pluginStore } from './kit'
import type { Engine, On } from './kit'

// Saving and restoring the register: the per-session buckets in the plugin's store.

type Row = { id: number; head: string; status: string; at: number; turnId: string | null; trackedBy?: string }
type Saved = { v: number; savedAt: number; ledger: { questions: Row[]; steps: unknown[]; prompts: unknown[]; nextQuestionId: number; compactedAt?: number } }

const question = (id: number, at: number, trackedBy: string): Row => ({ id, head: `question ${id}`, status: 'open', at, turnId: 't0', trackedBy })

const finishTurn = async ($: Engine, on: On) => {
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.turn.complete({ answer: 'done', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)
}

// The test's stand-ins answer beneath the plugin; all of them are registered before the first call.
const resume = async ($: Engine, on: On, then?: () => Promise<void>) => {
  on('classic.SessionStart', () => ({}))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.classic.SessionStart({ source: 'resume', session_id: SESSION } as never)
  await then?.()
}

const prompt = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as never)

// Compaction removes old tool calls from the transcript. The rewind check judges only work after
// the last compaction, so the compaction time must survive a resume.
test('a compaction is saved with the register', async ($, on) => {
  const pool = blobPool(on)
  atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 2, questions: [question(1, 1000, 'toolu_old')] })
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  const store = pluginStore(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'the summary', toolUses: [] }] }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'an old prompt', toolUses: [] }] } as never)
  await $.turn.complete({ answer: 'done', reason: 'answer', turnId: 't1', durationMs: 1, isAborted: false } as never)

  const rawOwnSave = store.held.get(`s:${SESSION}`) as { v?: number } | undefined
  expect(rawOwnSave?.v).toBe(2)
  expect(Object.hasOwn(rawOwnSave!, 'ledger')).toBe(false)
  const bucket = await pool.logical(store, `s:${SESSION}`) as Saved | undefined
  expect(bucket?.ledger.compactedAt).toBeGreaterThan(0)
})

test('a resumed session keeps the questions asked before its last compaction', async ($, on) => {
  blobPool(on)
  const saved = { v: 1, savedAt: 5000, ledger: { ...EMPTY, nextQuestionId: 2, questions: [question(1, 1000, 'toolu_old')], compactedAt: 2000 } }
  const ledger = atomStore(on, 'ledger', EMPTY as { questions: Row[] })
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  pluginStore(on, { [`s:${SESSION}`]: saved })
  // After the compaction the transcript holds none of the old tool calls.
  on('session.messages', () => ({ value: [] }))

  await resume($, on, async () => {
    await prompt($, 'and the next question?')
  })

  expect(ledger.value.questions.map(q => q.id)).toEqual([1])
})

test('a resumed register keeps only well-formed rows, and the next question id stays ahead', async ($, on) => {
  blobPool(on)
  const ledger = {
    v: 1,
    nextQuestionId: 1,
    prompts: [{ rowKey: 'r1', head: 'a prompt', turnId: 't0', at: 1 }, 5, { head: 7 }],
    questions: [question(3, 10, 'toolu_a'), { id: 'x', head: 'bad' }, null],
    steps: [{ id: 'plan:1', source: 'plan', subject: 'a step', status: 'pending' }, { id: 1 }],
  }
  const held = atomStore(on, 'ledger', EMPTY as { questions: Row[]; prompts: unknown[]; steps: unknown[]; nextQuestionId: number })
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  pluginStore(on, { [`s:${SESSION}`]: { v: 1, savedAt: 1, ledger } })

  await resume($, on)

  expect(held.value.questions.map(q => q.id)).toEqual([3])
  expect(held.value.prompts).toHaveLength(1)
  expect(held.value.steps).toHaveLength(1)
  expect(held.value.nextQuestionId).toBeGreaterThan(3)
})

test('a saved register of another version is not restored', async ($, on) => {
  blobPool(on)
  const held = atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  pluginStore(on, { [`s:${SESSION}`]: { v: 2, savedAt: 1, ledger: { ...EMPTY, questions: [question(1, 1, 'toolu_a')] } } })

  await resume($, on)

  expect(held.writes).toHaveLength(0)
})

test('a resume that fails says so in the debug log, and the session starts', async ($, on) => {
  blobPool(on)
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  const lines = logs(on)
  on('store.get', () => {
    throw new Error('the store cannot be read')
  })

  await resume($, on)

  expect(lines.some(line => line.startsWith('track:') && line.includes('resume'))).toBe(true)
})

// FIXTURE: recent UUID-owned history fills Track's budget but fits the engine's cap.
const capacityHistory = () => {
  const now = Date.now()
  const big = (at: number) => Array.from({ length: 200 }, (_, i) => ({ rowKey: `r${i}`, head: 'é'.repeat(650), turnId: null, at }))
  const initial: Record<string, unknown> = {}
  const ids = Array.from({ length: 15 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)
  ids.forEach((id, i) => {
    const at = now - (ids.length - i) * 1000
    initial[`s:${id}`] = { v: 1, session_id: id, savedAt: at, ledger: { ...EMPTY, session_id: id, prompts: big(at) } }
    initial[`h:${id}`] = { v: 1, session_id: id, retentionOnly: true, closedAt: at }
  })
  initial.sessions = [...ids].reverse()
  return { initial, ids, callerLedger: { ...EMPTY, session_id: SESSION, prompts: big(now).map(row => ({ ...row, session_id: SESSION })) } }
}
const storeBytes = (records: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(records)).byteLength

test('a save over the Track budget compacts CLOSED history without deletion and persists the caller', async ($, on) => {
  const pool = blobPool(on)
  const { initial, ids, callerLedger } = capacityHistory()
  expect(storeBytes(initial)).toBeGreaterThan(3 * 1024 * 1024)
  expect(storeBytes(initial)).toBeLessThan(4 * 1024 * 1024)
  atomStore(on, 'ledger', callerLedger)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  const store = pluginStore(on, initial, 4 * 1024 * 1024, { guardStates: Object.fromEntries(ids.map(id => [id, 'closed' as const])) })
  const lines = logs(on)
  on('session.id', () => ({ value: SESSION }))

  await finishTurn($, on)

  expect({ callerPersisted: store.held.has(`s:${SESSION}`), saveFailures: lines.filter(line => line.includes('save failed:')) })
    .toEqual({ callerPersisted: true, saveFailures: [] })
  const rawOwnSave = store.held.get(`s:${SESSION}`) as { v?: number } | undefined
  expect(rawOwnSave?.v).toBe(2)
  expect(Object.hasOwn(rawOwnSave!, 'ledger')).toBe(false)
  expect((await pool.logical(store, `s:${SESSION}`) as Saved).ledger.prompts).toEqual(callerLedger.prompts)
  for (const id of ids) {
    const raw = store.held.get(`s:${id}`) as { v?: number } | undefined
    expect(raw).toBeDefined()
    expect(store.held.get(`h:${id}`)).toEqual(initial[`h:${id}`])
    expect([1, 2]).toContain(raw?.v)
    expect(await pool.logical(store, `s:${id}`)).toEqual(initial[`s:${id}`])
    if (raw?.v === 1) expect(raw).toEqual(initial[`s:${id}`])
    else expect(Object.hasOwn(raw!, 'ledger')).toBe(false)
  }
  expect(ids.some(id => (store.held.get(`s:${id}`) as { v?: number } | undefined)?.v === 2)).toBe(true)
  expect(lines.filter(line => line.includes('was evicted'))).toEqual([])
  expect(storeBytes(Object.fromEntries(store.held))).toBeLessThan(3 * 1024 * 1024)
})

test('a save over the Track budget refuses and preserves all LIVE history bodies', async ($, on) => {
  blobPool(on)
  const { initial, ids, callerLedger } = capacityHistory()
  const before = ids.map(id => JSON.stringify(initial[`s:${id}`]))
  expect(storeBytes(initial)).toBeGreaterThan(3 * 1024 * 1024)
  expect(storeBytes(initial)).toBeLessThan(4 * 1024 * 1024)
  atomStore(on, 'ledger', callerLedger)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  const store = pluginStore(on, initial, 4 * 1024 * 1024, { guardStates: Object.fromEntries(ids.map(id => [id, 'live' as const])) })
  const lines = logs(on)
  on('session.id', () => ({ value: SESSION }))

  await finishTurn($, on)

  expect(store.held.has(`s:${SESSION}`)).toBe(false)
  expect(ids.map(id => JSON.stringify(store.held.get(`s:${id}`)))).toEqual(before)
  expect(lines.some(line => line.includes('capacity: protected or unexpired history fills the UTF-8 store budget'))).toBe(true)
})

// An incomplete index does not give a caller authority to delete an unexpired bucket.
test('a bucket the index lost is retained along with every other unexpired session', async ($, on) => {
  blobPool(on)
  const initial: Record<string, unknown> = { 's:lost': { v: 1, savedAt: 0, ledger: EMPTY } }
  const ids = Array.from({ length: 20 }, (_, i) => `old-${String(i + 1).padStart(2, '0')}`)
  ids.forEach((id, i) => {
    initial[`s:${id}`] = { v: 1, savedAt: i + 1, ledger: EMPTY }
  })
  initial.sessions = [...ids].reverse()
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  const store = pluginStore(on, initial)
  on('session.id', () => ({ value: SESSION }))

  await finishTurn($, on)

  const buckets = [...store.held.keys()].filter(k => k.startsWith('s:'))
  expect(buckets).toHaveLength(22)
  expect(buckets).toContain(`s:${SESSION}`)
  expect(buckets).toContain('s:lost')
  expect(buckets).toContain('s:old-01')
  for (const id of ids) expect(store.held.get(`s:${id}`)).toEqual(initial[`s:${id}`])
})

test('a save that fails says so in the debug log', async ($, on) => {
  blobPool(on)
  atomStore(on, 'ledger', EMPTY)
  atomStore(on, 'turn', { currentId: null, gatedTurnId: null })
  pluginStore(on, {}, 0)
  const lines = logs(on)
  on('session.id', () => ({ value: SESSION }))

  await finishTurn($, on)

  expect(lines.some(line => line.startsWith('track:') && line.includes('save'))).toBe(true)
})

test('/clear empties the pane even when the save fails', async ($, on) => {
  blobPool(on)
  const ledger = atomStore(on, 'ledger', { ...EMPTY, nextQuestionId: 2, questions: [question(1, 1, 'toolu_a')] })
  atomStore(on, 'turn', { currentId: 't1', gatedTurnId: null })
  pluginStore(on, {}, 0)
  logs(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))

  await $.session.end({ reason: 'clear', sessionId: SESSION } as never)

  expect(ledger.value.questions).toEqual([])
})
