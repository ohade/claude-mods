// FIXTURE: actual registered import command; lock streams model flock ownership.
import { expect, mock, test } from 'claude-code/testing'
import { checksumOf, describeCheckpoint } from '../hooks/checkpoint'
import { EMPTY, SESSION, atomStore, pluginStore, trackCommand } from './kit'
import type { On } from './kit'

const VICTIM = '00000000-0000-4000-8000-000000000011'
const TARGET = '00000000-0000-4000-8000-000000000012'
const LIVE = '00000000-0000-4000-8000-000000000013'
const OTHER_LIVE = '00000000-0000-4000-8000-000000000014'
const BUNDLE = '/import-held-guards.json'
const body = (session: string, padding: number, savedAt: number) => ({
  v: 1, session_id: session, savedAt, ledger: { ...EMPTY, session_id: session }, padding: 'p'.repeat(padding),
})

const fixture = async (on: On, liveArchiveSource = false) => {
  const target = {
    ...body(TARGET, 800000, 4), generation: '11111111-2222-4333-8444-555555555555',
    checkpoint: await describeCheckpoint({ ...EMPTY, session_id: TARGET }, TARGET),
  }
  const records = [{ key: `s:${TARGET}`, value: target }]
  const source = JSON.stringify({ v: 1, source_identity: '/fixture-held-source', checksum: await checksumOf(records), records })
  const initial: Record<string, unknown> = {
    cleanup: { v: 1, lastAttempt: Date.now(), cursor: '' },
    [`s:${VICTIM}`]: body(VICTIM, 1600000, 1),
    [`r:${VICTIM}:switch`]: { v: 1, session_id: VICTIM, kind: 'session-switch', value: { source_session: liveArchiveSource ? LIVE : TARGET } },
    [`s:${LIVE}`]: body(LIVE, 800000, 2),
    [`s:${OTHER_LIVE}`]: body(OTHER_LIVE, 800000, 3),
  }
  initial.saved = Object.fromEntries([VICTIM, LIVE, OTHER_LIVE].map(session => [session, { at: 1, bytes: 800100, unfinished: false }]))
  const active = new Set<string>()
  const probes: string[] = []
  const releases: string[] = []
  const violations: string[] = []
  const writes: string[] = []
  const reads: string[] = []
  // Registered before pluginStore, so this stream owns the lock receipt and cleanup.
  // The kit's lock stream answers legacy or protocol 2, including the completion handshake.
  on('process.spawn', { argv: /writer-lock\.py$/ }, async function* (_, e, next) {
    const mode = e.argv[2]!
    const session = e.argv[3]!
    const state = active.has(session) || session === LIVE || session === OTHER_LIVE ? 'live' : 'closed'
    if (mode === 'guard') {
      probes.push(session)
      if (state === 'closed') active.add(session)
    }
    try {
      return yield* store.locks.serve(e, next.signal, mode === 'guard' ? { state } : {})
    } finally {
      if (mode === 'guard') {
        releases.push(`${session}:${state}`)
        if (state === 'closed' && !active.delete(session)) violations.push(`double release: ${session}`)
      }
    }
  })
  // Observe and perform target writes before the generic store hook handles them.
  let store: ReturnType<typeof pluginStore>
  on('store.set', { key: new RegExp(`^[sh]:${TARGET}$`) }, (_, e) => {
    writes.push(e.key)
    if (!active.has(TARGET)) violations.push(`target guard missing during write: ${e.key}`)
    store.held.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  atomStore(on, 'ledger', EMPTY)
  mock.env(on, { CLAUDE_CONFIG_DIR: '/fixture/config' })
  store = pluginStore(on, initial, undefined, { beforeGet: key => {
    if (writes.length > 0 && (key === `s:${TARGET}` || key === `h:${TARGET}`)) {
      reads.push(key)
      if (!active.has(TARGET)) violations.push(`target guard missing during read-back: ${key}`)
    }
  } })
  const history = Object.entries(initial).filter(([key]) => /^[shr]:/.test(key)).map(([key, value]) => [key, JSON.stringify(value)] as const)
  const files = new Map([[BUNDLE, source]])
  on('session.id', () => ({ value: SESSION }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  return { store, target, source, files, history, probes, releases, active, violations, writes, reads }
}

test('TRACK-31 import reuses its held CLOSED target through eviction, writes and read-back', async ($, on) => {
  const f = await fixture(on)
  const receipt = JSON.parse((await trackCommand($, `import ${BUNDLE}`)).text!)
  // Assert after command completion: production catches callback exceptions.
  expect(receipt.reason ?? 'import success').toBe('import success')
  expect(receipt.ok).toBe(true)
  expect(receipt.imported).toEqual([TARGET])
  expect(receipt.verified).toEqual([TARGET])
  expect(receipt.evicted).toEqual([VICTIM])
  expect(f.store.held.has(`s:${VICTIM}`)).toBe(false)
  expect(f.store.held.has(`r:${VICTIM}:switch`)).toBe(false)
  for (const [key, bytes] of f.history.filter(([key]) => !key.includes(VICTIM))) expect(JSON.stringify(f.store.held.get(key))).toBe(bytes)
  const installed = f.store.held.get(`s:${TARGET}`) as typeof f.target
  expect(installed.ledger).toEqual(f.target.ledger)
  expect(installed.generation).toBe(f.target.generation)
  expect(installed.checkpoint).toEqual(f.target.checkpoint)
  expect(f.store.held.get(`h:${TARGET}`)).toEqual({ v: 1, session_id: TARGET, generation: f.target.generation, checkpoint: f.target.checkpoint })
  expect(f.files.get(BUNDLE)).toBe(f.source)
  expect(f.probes.filter(session => session === TARGET)).toEqual([TARGET])
  expect(f.releases.filter(session => session.startsWith(TARGET))).toEqual([`${TARGET}:closed`])
  expect(f.releases.filter(session => session.startsWith(VICTIM))).toEqual([`${VICTIM}:closed`])
  expect(f.writes).toEqual([`s:${TARGET}`, `h:${TARGET}`])
  expect(f.reads.filter(key => key === `s:${TARGET}`).length >= 2).toBe(true)
  expect(f.reads.filter(key => key === `h:${TARGET}`).length >= 2).toBe(true)
  expect(f.violations).toEqual([])
  expect([...f.active]).toEqual([])
})

test('TRACK-31 import refuses a genuinely LIVE archive source and preserves source and history', async ($, on) => {
  const f = await fixture(on, true)
  const receipt = JSON.parse((await trackCommand($, `import ${BUNDLE}`)).text!)
  expect(receipt.ok).toBe(false)
  expect(receipt.reason).toContain('capacity:')
  expect(receipt.evicted).toEqual([])
  for (const [key, bytes] of f.history) expect(JSON.stringify(f.store.held.get(key))).toBe(bytes)
  expect(f.store.held.has(`s:${TARGET}`)).toBe(false)
  expect(f.store.held.has(`h:${TARGET}`)).toBe(false)
  expect(f.files.get(BUNDLE)).toBe(f.source)
  expect(f.writes).toEqual([])
  expect(f.probes.includes(LIVE)).toBe(true)
  expect(f.releases.filter(session => session.startsWith(TARGET))).toEqual([`${TARGET}:closed`])
  expect(f.releases.filter(session => session.startsWith(VICTIM))).toEqual([`${VICTIM}:closed`])
  expect(f.violations).toEqual([])
  expect([...f.active]).toEqual([])
})
