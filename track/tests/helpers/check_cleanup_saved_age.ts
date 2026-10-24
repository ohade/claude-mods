// FIXTURE, TRACK-43 unit 1 (2026-10-24): cleanup expires a CLOSED session whose
// last save is CLOSED_TTL old, and migrates recent v1 sessions through an
// injected compaction. Controlled time, in-memory store, scripted probes.
import assert from 'node:assert/strict'
import { CLOSED_TTL, cleanupRecords, recoverCleanup } from '../../hooks/retention'
import type { Compaction, Guard, RetentionStore } from '../../hooks/retention'

const DAY = 24 * 3600000
const caller = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
let now = 100 * CLOSED_TTL
const originalNow = Date.now
Date.now = () => now
const logs: string[] = []
const makeStore = (initial: Record<string, unknown>, failDelete?: string) => {
  const values = new Map(Object.entries(initial))
  let failing = failDelete
  const store: RetentionStore = {
    keys: async () => [...values.keys()], get: async key => values.get(key),
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    delete: async key => {
      if (key === failing) { failing = undefined; throw new Error(`delete refused: ${key}`) }
      values.delete(key)
    },
    log: message => { logs.push(message) },
  }
  return { store, values }
}
const closed = async (): Promise<Guard> => ({ state: 'closed', release: async () => {} })
const v1 = (n: number, savedAt: unknown, extra: Record<string, unknown> = {}) => ({ v: 1, session_id: id(n), savedAt, ledger: { question: `keep ${n}` }, ...extra })
const v2 = (n: number, savedAt: unknown) => ({ v: 2, session_id: id(n), savedAt, ledger_blob: { checksum: 'a'.repeat(64), bytes: 10 } })
const records = (n: number, body: unknown) => ({ [`s:${id(n)}`]: body, [`h:${id(n)}`]: { v: 1, session_id: id(n) }, [`r:${id(n)}:old`]: { v: 1, session_id: id(n), value: 'archive' } })
const keysOf = (values: Map<string, unknown>, n: number) => [...values.keys()].filter(key => key.includes(id(n)))
const cases: Array<[string, () => Promise<void>]> = []
const check = (name: string, run: () => Promise<void>) => cases.push([name, run])

for (const [label, body] of [['v1', v1(1, now - CLOSED_TTL)], ['v2', v2(1, now - CLOSED_TTL)]] as const) {
  check(`${label}: savedAt exactly CLOSED_TTL old expires every key and leaves no journal`, async () => {
    const { store, values } = makeStore({ ...records(1, body), other: { keep: true } })
    await cleanupRecords(store, caller, closed)
    assert.deepEqual(keysOf(values, 1), [])
    assert.equal(values.has(`cleanup:${id(1)}`), false)
    assert.deepEqual(values.get('other'), { keep: true })
  })
  check(`${label}: savedAt one millisecond younger is stamped and kept`, async () => {
    const young = { ...body, savedAt: now - CLOSED_TTL + 1 }
    const { store, values } = makeStore(records(1, young))
    await cleanupRecords(store, caller, closed)
    assert.deepEqual(values.get(`s:${id(1)}`), young)
    assert.equal((values.get(`h:${id(1)}`) as any).closedAt, now)
    assert.equal(values.has(`r:${id(1)}:old`), true)
  })
}
check('live, throwing probe stay untouched, however old the save', async () => {
  const old = now - 30 * DAY
  const initial: Record<string, unknown> = { ...records(1, v1(1, old)), ...records(2, v1(2, old)) }
  for (const mode of ['live', 'throw'] as const) {
    const { store, values } = makeStore(initial)
    const before = structuredClone([...values.entries()])
    const probe = async (): Promise<Guard> => {
      if (mode === 'throw') throw new Error('probe refused')
      return { state: 'live', release: async () => {} }
    }
    await cleanupRecords(store, caller, probe)
    for (const [key, value] of before) assert.deepEqual(values.get(key), value, `${mode}: ${key}`)
    assert.equal(values.has(`cleanup:${id(1)}`), false)
  }
})
check('the caller itself stays byte-identical even when its record names it, the probe says closed and the save is 30 days old', async () => {
  const body = { v: 1, session_id: caller, savedAt: now - 30 * DAY, ledger: { question: 'caller' } }
  const initial = { [`s:${caller}`]: body, [`h:${caller}`]: { v: 1, session_id: caller }, [`r:${caller}:old`]: { v: 1, session_id: caller, value: 'archive' } }
  const { store, values } = makeStore(initial)
  const calls: Call[] = []
  await cleanupRecords(store, caller, closed, { compact: async session => { calls.push({ session, confirm: async () => false }); return 'kept' } })
  for (const [key, value] of Object.entries(initial)) assert.deepEqual(values.get(key), value, key)
  assert.deepEqual([...values.keys()].filter(key => key.includes(caller)).sort(), Object.keys(initial).sort())
  assert.equal(values.has(`cleanup:${caller}`), false)
  assert.equal(calls.length, 0)
})
// An imported savedAt comes from the source store, so it is not a save in this one (TRACK-31 T31-1).
const provenance = { source_identity: '/legacy', bundle_checksum: 'fixture', source_session: id(1) }
const imported = (savedAt: number, extra: Record<string, unknown> = {}) => v1(1, savedAt, { import_provenance: provenance, ...extra })
const withHead = (body: unknown, closedAt?: number) => ({ ...records(1, body), [`h:${id(1)}`]: { v: 1, session_id: id(1), ...(closedAt !== undefined && { closedAt }) } })
check('an import with a 30-day-old savedAt and no closedAt is stamped and kept', async () => {
  const body = imported(now - 30 * DAY)
  const { store, values } = makeStore(withHead(body))
  await cleanupRecords(store, caller, closed)
  assert.deepEqual(values.get(`s:${id(1)}`), body)
  assert.equal((values.get(`h:${id(1)}`) as any).closedAt, now)
  assert.equal(values.has(`r:${id(1)}:old`), true)
})
check('an import whose closedAt is 8 days old expires', async () => {
  const { store, values } = makeStore(withHead(imported(now - DAY), now - 8 * DAY))
  await cleanupRecords(store, caller, closed)
  assert.deepEqual(keysOf(values, 1), [])
})
check('an import with closedAt 1 day old and savedAt 30 days old is kept untouched', async () => {
  const body = imported(now - 30 * DAY)
  const initial = withHead(body, now - DAY)
  const { store, values } = makeStore(initial)
  await cleanupRecords(store, caller, closed)
  for (const [key, value] of Object.entries(initial)) assert.deepEqual(values.get(key), value, key)
})
check('an old-save import is neither compacted by the hourly path nor expired by savedAt', async () => {
  const initial = withHead(imported(now - 30 * DAY), now - DAY)
  const handle = makeStore(initial)
  const calls: Call[] = []
  await cleanupRecords(handle.store, caller, closed, { compact: converting(calls, 'compacted', handle) })
  assert.deepEqual(calls, [])
  for (const [key, value] of Object.entries(initial)) assert.deepEqual(handle.values.get(key), value, key)
  assert.deepEqual(keysOf(handle.values, 1).sort(), Object.keys(initial).sort())
  assert.equal((handle.values.get(`s:${id(1)}`) as any).v, 1)
  assert.deepEqual((handle.values.get(`s:${id(1)}`) as any).import_provenance, provenance)
})
for (const [label, savedAt] of [['future', now + 1], ['string', 'yesterday'], ['null', null], ['NaN', Number.NaN], ['negative', -5]] as const) {
  check(`${label} savedAt falls back to the closedAt behaviour (stamp, keep)`, async () => {
    const body = v1(1, savedAt)
    const { store, values } = makeStore(records(1, body))
    await cleanupRecords(store, caller, closed)
    assert.deepEqual(keysOf(values, 1).sort(), [`h:${id(1)}`, `r:${id(1)}:old`, `s:${id(1)}`])
    assert.equal((values.get(`h:${id(1)}`) as any).closedAt, now)
  })
}
check('an old closedAt still expires when savedAt is recent, future or missing', async () => {
  for (const body of [v1(1, now - DAY), v1(1, now + 5), { v: 1, session_id: id(1), ledger: {} }]) {
    const { store, values } = makeStore({ ...records(1, body), [`h:${id(1)}`]: { v: 1, session_id: id(1), closedAt: now - CLOSED_TTL } })
    await cleanupRecords(store, caller, closed)
    assert.deepEqual(keysOf(values, 1), [])
  }
})
check('the intent clock is closedAt when that rule fired, otherwise savedAt; recovery finishes both as a non-owner', async () => {
  for (const [rule, headClock, expected] of [['savedAt', undefined, now - CLOSED_TTL - 7], ['savedAt with a recent closedAt', now - DAY, now - CLOSED_TTL - 7], ['closedAt', now - CLOSED_TTL - 3, now - CLOSED_TTL - 3]] as const) {
    const head = { v: 1, session_id: id(1), ...(headClock !== undefined && { closedAt: headClock }) }
    const { store, values } = makeStore({ ...records(1, v1(1, now - CLOSED_TTL - 7)), [`h:${id(1)}`]: head }, `h:${id(1)}`)
    await assert.rejects(cleanupRecords(store, caller, closed), /delete refused: h:/)
    const intent = values.get(`cleanup:${id(1)}`) as any
    assert.equal(intent.mode, 'expiry', rule)
    assert.equal(intent.closedAt, expected, rule)
    assert.equal(values.has(`r:${id(1)}:old`), false)
    assert.equal(await recoverCleanup(store, id(1), { owner: false }), true)
    assert.deepEqual(keysOf(values, 1), [], rule)
  }
})
check('recovery still refuses a non-owner expiry intent whose clock is younger than CLOSED_TTL', async () => {
  const { store, values } = makeStore({ ...records(1, v1(1, now - CLOSED_TTL + 1)), [`cleanup:${id(1)}`]: { v: 2, mode: 'expiry', session_id: id(1), closedAt: now - CLOSED_TTL + 1, entries: [{ key: `s:${id(1)}`, checksum: 'b'.repeat(64), bytes: 1 }] } })
  await assert.rejects(recoverCleanup(store, id(1), { owner: false }), /ambiguous durable intent/)
  assert.equal(values.has(`s:${id(1)}`), true)
})

// Migration through an injected compaction.
type Call = { session: string; confirm: () => Promise<boolean> }
const converting = (calls: Call[], outcome: 'compacted' | 'kept' | 'stop' = 'compacted', store?: { values: Map<string, unknown> }): Compaction => async (session, confirm) => {
  calls.push({ session, confirm })
  if (outcome === 'compacted') {
    assert.equal(await confirm(), true)
    const { ledger, ...rest } = store!.values.get(`s:${session}`) as any
    store!.values.set(`s:${session}`, { ...rest, v: 2, ledger_blob: { checksum: 'c'.repeat(64), bytes: 5 } })
  }
  return outcome
}
check('a CLOSED recent v1 session is converted through compact, once, with its id', async () => {
  const handle = makeStore(records(1, v1(1, now - DAY)))
  const calls: Call[] = []
  await cleanupRecords(handle.store, caller, closed, { compact: converting(calls, 'compacted', handle) })
  assert.deepEqual(calls.map(call => call.session), [id(1)])
  assert.equal((handle.values.get(`s:${id(1)}`) as any).v, 2)
  assert.equal(Object.hasOwn(handle.values.get(`s:${id(1)}`) as object, 'ledger'), false)
})
check('v2, expired, live, ambiguous, caller and non-v1 shapes never reach compact; no options means no call', async () => {
  const calls: Call[] = []
  const compact = converting(calls, 'kept')
  const initial = { ...records(1, v2(1, now - DAY)), ...records(2, v1(2, now - CLOSED_TTL)), ...records(3, v1(3, now - DAY)),
    ...records(4, { ...v1(4, now - DAY), session_id: id(99) }), ...records(5, { v: 1, session_id: id(5), savedAt: now - DAY }),
    ...records(6, v1(6, now - DAY, { ledger_blob: { checksum: 'd'.repeat(64), bytes: 1 } })), [`s:${caller}`]: v1(9, now - DAY) }
  const probe = async (session: string): Promise<Guard> => session === id(3) ? { state: 'live', release: async () => {} } : closed()
  await cleanupRecords(makeStore(initial).store, caller, probe, { compact })
  assert.deepEqual(calls.map(call => call.session), [], 'nothing eligible')
  for (const options of [undefined, {}] as const) {
    const initial = records(7, v1(7, now - DAY))
    const eligible = makeStore(initial)
    await cleanupRecords(eligible.store, caller, closed, options)
    assert.equal(calls.length, 0, 'no compact function was passed')
    const expected = new Map(Object.entries({ ...initial, [`h:${id(7)}`]: { v: 1, session_id: id(7), closedAt: now },
      cleanup: { v: 1, cursor: id(7), recoveryCursor: '', blocked: [], lastAttempt: now, lastCleanup: now } }))
    assert.deepEqual(eligible.values, expected)
  }
})
check("'kept' moves on; 'stop' ends migration for the run while expiry continues", async () => {
  const initial = { ...records(1, v1(1, now - DAY)), ...records(2, v1(2, now - DAY)), ...records(3, v1(3, now - CLOSED_TTL)) }
  const seen: string[] = []
  const keptThenStop: Compaction = async session => { seen.push(session); return seen.length === 1 ? 'kept' : 'stop' }
  const { store, values } = makeStore(initial)
  await cleanupRecords(store, caller, closed, { compact: keptThenStop })
  assert.deepEqual(seen, [id(1), id(2)])
  assert.deepEqual(keysOf(values, 3), [])
  const again = makeStore({ ...records(4, v1(4, now - DAY)), ...records(5, v1(5, now - DAY)), ...records(6, v1(6, now - CLOSED_TTL)) })
  const stopped: string[] = []
  await cleanupRecords(again.store, caller, closed, { compact: async session => { stopped.push(session); return 'stop' } })
  assert.deepEqual(stopped, [id(4)], 'no compact call after stop')
  assert.deepEqual(keysOf(again.values, 6), [], 'expiry visits continue after stop')
})
check('confirm holds only while the guard is held, the budget remains and the s: value is unchanged; it takes no new guard', async () => {
  let held = 0
  let probes = 0
  const probe = async (): Promise<Guard> => { probes++; held++; return { state: 'closed', release: async () => { held-- } } }
  const outcomes: boolean[] = []
  const late: Call[] = []
  const handle = makeStore({ ...records(1, v1(1, now - DAY)), ...records(2, v1(2, now - DAY)), ...records(3, v1(3, now - DAY)), ...records(4, v1(4, now - DAY)) })
  const compact: Compaction = async (session, confirm) => {
    const probesBefore = probes
    if (session === id(1)) outcomes.push(await confirm())
    if (session === id(2)) { handle.values.set(`s:${session}`, v1(2, now - DAY, { ledger: { question: 'changed' } })); outcomes.push(await confirm()) }
    if (session === id(3)) { assert.equal(held, 1, 'guard held during compact'); now += 300; outcomes.push(await confirm()); now -= 300 }
    if (session === id(4)) late.push({ session, confirm })
    assert.equal(probes, probesBefore, 'confirm and compact take no new guard')
    return 'kept'
  }
  await cleanupRecords(handle.store, caller, probe, { compact })
  assert.deepEqual(outcomes, [true, false, false])
  assert.equal(held, 0)
  assert.equal(await late[0]!.confirm(), false, 'confirm after the visit released its guard')
})
check('a throwing compact keeps the v1 record, records the failure, advances the cursor and continues', async () => {
  const handle = makeStore({ ...records(1, v1(1, now - DAY)), ...records(2, v1(2, now - DAY)) })
  const seen: string[] = []
  const compact: Compaction = async session => { seen.push(session); if (session === id(1)) throw new Error('compaction exploded'); return 'kept' }
  await assert.rejects(cleanupRecords(handle.store, caller, closed, { compact }), /compaction exploded/)
  assert.deepEqual(seen, [id(1), id(2)])
  assert.deepEqual(handle.values.get(`s:${id(1)}`), v1(1, now - DAY))
  assert.equal((handle.values.get('cleanup') as any).cursor, id(2))
  assert.equal(logs.some(line => line.includes('deferred') && line.includes('compaction exploded')), true)
})
check('the hourly due rule still gates migration', async () => {
  const handle = makeStore({ ...records(1, v1(1, now - DAY)), cleanup: { v: 1, lastAttempt: now - 3600000 + 1 } })
  const calls: Call[] = []
  await cleanupRecords(handle.store, caller, closed, { compact: converting(calls, 'kept') })
  assert.equal(calls.length, 0)
})

// TRACK-43 wiring cases (2026-10-24): F1 refused expiry, F2 shape, F3 lastCleanup, F5 clocks.
const HOUR_MS = 3600000
const switchArchive = (n: number, source: unknown) => ({ [`r:${id(n)}:switch`]: { v: 1, session_id: id(n), kind: 'session-switch', value: { source_session: source, ledger: { session_id: source } } } })
// Counts guards taken and released, so a refusal that leaks one shows up.
const counting = (states: Record<string, 'live' | 'closed'> = {}) => {
  const tally = { taken: 0, released: 0 }
  const probe = async (session: string): Promise<Guard> => {
    tally.taken++
    return { state: states[session] ?? 'closed', release: async () => { tally.released++ } }
  }
  return { tally, probe }
}
for (const [label, source, states] of [
  ['a LIVE switch source', id(2), { [id(2)]: 'live' as const }],
  ['an ambiguous switch source', 'not-a-session-id', {}],
] as const) {
  check(`F1: a savedAt expiry refused by ${label} stamps the missing clock, keeps every row and does not compact`, async () => {
    const initial = { ...records(1, v1(1, now - 30 * DAY)), ...switchArchive(1, source) }
    const handle = makeStore(initial)
    const { tally, probe } = counting(states)
    const calls: Call[] = []
    await cleanupRecords(handle.store, caller, probe, { compact: converting(calls, 'compacted', handle) })
    assert.equal(logs.some(line => line.includes(`expiry keeps ${id(1)}`)), true, 'the refusal was reached')
    for (const [key, value] of Object.entries(initial)) {
      if (key === `h:${id(1)}`) assert.deepEqual(handle.values.get(key), { ...(value as object), closedAt: now }, 'only the missing closing clock is added')
      else assert.deepEqual(handle.values.get(key), value, key)
    }
    assert.equal(handle.values.has(`cleanup:${id(1)}`), false, 'no journal remains')
    assert.deepEqual(calls.map(call => call.session).filter(session => session === id(1)), [], 'that candidate is not compacted in the same visit')
    assert.equal(tally.released, tally.taken, 'every guard is released')
    assert.equal((handle.values.get('cleanup') as any).lastCleanup, now)
  })
}
check('F1: a refused expiry whose closing clock already exists adds no stamp', async () => {
  const initial = { ...withHead(v1(1, now - 30 * DAY), now - DAY), ...switchArchive(1, id(2)) }
  const handle = makeStore(initial)
  const { tally, probe } = counting({ [id(2)]: 'live' })
  await cleanupRecords(handle.store, caller, probe)
  for (const [key, value] of Object.entries(initial)) assert.deepEqual(handle.values.get(key), value, key)
  assert.equal(tally.released, tally.taken)
})
check('F1: a refused expiry is retried and succeeds once the source is CLOSED', async () => {
  const initial = { ...records(1, v1(1, now - 30 * DAY)), ...switchArchive(1, id(2)) }
  const handle = makeStore(initial)
  await cleanupRecords(handle.store, caller, counting({ [id(2)]: 'live' }).probe)
  assert.equal(handle.values.has(`s:${id(1)}`), true)
  now += HOUR_MS
  try { await cleanupRecords(handle.store, caller, counting().probe) } finally { now -= HOUR_MS }
  assert.deepEqual(keysOf(handle.values, 1), [], 'the session is deleted once nothing blocks it')
})
check('F2: a v:2 body with an inline ledger and no ledger_blob is never compacted', async () => {
  const calls: Call[] = []
  const body = { v: 2, session_id: id(1), savedAt: now - DAY, ledger: { question: 'inline under v2' } }
  const handle = makeStore(withHead(body, now - DAY))
  await cleanupRecords(handle.store, caller, closed, { compact: converting(calls, 'compacted', handle) })
  assert.deepEqual(calls, [])
  assert.deepEqual(handle.values.get(`s:${id(1)}`), body)
})
for (const [label, ledger] of [['null', null], ['an array', [1, 2]], ['a string', 'text'], ['a number', 7]] as const) {
  check(`F6: a v:1 body whose ledger is ${label} is never compacted`, async () => {
    const calls: Call[] = []
    const body = { v: 1, session_id: id(1), savedAt: now - DAY, ledger }
    const handle = makeStore(withHead(body, now - DAY))
    await cleanupRecords(handle.store, caller, closed, { compact: converting(calls, 'compacted', handle) })
    assert.deepEqual(calls, [])
    assert.deepEqual(handle.values.get(`s:${id(1)}`), body)
  })
}
check('F3: a compaction-only run with an existing closing clock records lastCleanup; a kept one does not', async () => {
  for (const [outcome, completed] of [['compacted', true], ['kept', false]] as const) {
    const handle = makeStore(withHead(v1(1, now - DAY), now - DAY))
    await cleanupRecords(handle.store, caller, closed, { compact: converting([], outcome, handle) })
    const state = handle.values.get('cleanup') as any
    assert.equal(state.lastAttempt, now, outcome)
    assert.equal(state.lastCleanup, completed ? now : undefined, outcome)
    assert.deepEqual(handle.values.get(`h:${id(1)}`), { v: 1, session_id: id(1), closedAt: now - DAY }, 'no stamp supplied the count')
  }
})
// F5: each clock case is one head closedAt, one body savedAt, an import flag and whether the session is deleted.
const CLOCK_CASES: Array<[string, unknown, unknown, boolean, 'deleted' | 'kept']> = [
  ['NaN closedAt is unusable, an expired savedAt decides', Number.NaN, now - 30 * DAY, false, 'deleted'],
  ['future closedAt is unusable, an expired savedAt decides', now + 1, now - 30 * DAY, false, 'deleted'],
  ['string closedAt is unusable, an expired savedAt decides', 'yesterday', now - 30 * DAY, false, 'deleted'],
  ['NaN closedAt with a recent savedAt is stamped and kept', Number.NaN, now - DAY, false, 'kept'],
  ['future closedAt with a recent savedAt is stamped and kept', now + 1, now - DAY, false, 'kept'],
  ['string closedAt with a recent savedAt is stamped and kept', 'yesterday', now - DAY, false, 'kept'],
  ['zero closedAt is a valid, expired clock', 0, now - DAY, false, 'deleted'],
  ['zero closedAt expires an import', 0, now - DAY, true, 'deleted'],
  ['zero savedAt is a valid, expired save', now - DAY, 0, false, 'deleted'],
  ['zero savedAt never expires an import', now - DAY, 0, true, 'kept'],
  ['NaN savedAt with a recent closedAt is kept', now - DAY, Number.NaN, false, 'kept'],
  ['future savedAt with a recent closedAt is kept', now - DAY, now + 1, false, 'kept'],
  ['string savedAt with a recent closedAt is kept', now - DAY, 'yesterday', false, 'kept'],
  ['NaN savedAt with an expired closedAt is deleted', now - 30 * DAY, Number.NaN, false, 'deleted'],
  ['future savedAt with an expired closedAt is deleted', now - 30 * DAY, now + 1, false, 'deleted'],
  ['string savedAt with an expired closedAt is deleted', now - 30 * DAY, 'yesterday', false, 'deleted'],
]
for (const [label, closedAt, savedAt, isImport, expected] of CLOCK_CASES) {
  check(`F5: ${label}`, async () => {
    const body = v1(1, savedAt, isImport ? { import_provenance: provenance } : {})
    const handle = makeStore({ ...records(1, body), [`h:${id(1)}`]: { v: 1, session_id: id(1), closedAt } })
    await cleanupRecords(handle.store, caller, closed)
    if (expected === 'deleted') assert.deepEqual(keysOf(handle.values, 1), [])
    else {
      assert.deepEqual(keysOf(handle.values, 1).sort(), [`h:${id(1)}`, `r:${id(1)}:old`, `s:${id(1)}`])
      assert.deepEqual(handle.values.get(`s:${id(1)}`), body)
    }
  })
}

let failures = 0
try {
  for (const [name, run] of cases) {
    logs.length = 0
    try { await run(); console.log(`PASS ${name}`) }
    catch (error) { failures++; console.error(`FAIL ${name}: ${String(error)}`) }
  }
} finally { Date.now = originalNow }
if (failures) process.exitCode = 1
