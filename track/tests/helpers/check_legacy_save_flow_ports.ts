// FIXTURE: complete workflow without SDK/native host. Stateful ports and literal original contracts.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { saveLegacy } from '../../hooks/legacy-save-flow'
import type { LegacySavePorts } from '../../hooks/legacy-save-flow'
import type { LegacySaveState } from '../../hooks/legacy-save-plan'
import type { Baseline, Ledger } from '../../types'
import { describeCheckpoint } from '../../hooks/checkpoint'
import { LEGACY_SESSION as ID, legacyLedger, legacyLateStep, legacyCommitOrder, missingBodyError, legacyFallback } from './legacy_save_cases'

type Options = { records?: Record<string, unknown>; baseline?: Baseline; memory?: Ledger; revision?: number; late?: boolean; fallback?: boolean; commitError?: Error; adoptError?: Error }
const fixture = (options: Options = {}) => {
  const events: string[] = []
  const store = new Map<string, unknown>(Object.entries(options.records ?? {}))
  const state = { memory: options.memory ?? legacyLedger(), durability: { isUnsaved: false, reason: '', memorySession: ID, baseline: options.baseline } as LegacySaveState,
    revision: options.revision, recovery: false, saved: false, committed: false, tainted: false, publication: '', archive: [] as unknown[] }
  const hit = (event: string) => { events.push(event) }
  const ports: LegacySavePorts = {
    id: ID, emptyLedger: legacyLedger(), intent: () => { hit('intent'); return { closedByPerson: undefined, rewindSession: undefined } },
    recover: async () => { hit('recover') }, recoverCleanup: async () => { hit('recoverCleanup'); return false },
    resume: async () => { hit('resume'); throw new Error('unexpected resume for admitted fixture') }, clearClocks: async () => { hit('clearClocks') }, repairHead: async () => { hit('repairHead') },
    readLedger: async () => { hit('ledger'); return state.memory }, readState: async () => { hit('state'); return state.durability },
    readBody: async () => { hit('body'); return store.get(`s:${ID}`) }, readHead: async () => { hit('head'); return store.get(`h:${ID}`) },
    logicalBody: async raw => { hit('logical'); return raw },
    hasRevision: () => { hit('hasRevision'); return state.revision !== undefined }, readRevision: () => { hit('revision'); return state.revision },
    writePreference: async value => { hit('preference.write'); store.set('closedByPerson', value) }, readPreference: async () => { hit('preference.read'); return store.get('closedByPerson') },
    preserveConflict: async (...args) => { hit('preserve'); state.archive.push(args); return 'archive-42' },
    adoptConflict: async (...args) => { hit('adopt'); assert.equal(state.tainted, true, 'taint precedes adoption'); if (options.adoptError) throw options.adoptError; state.archive.push(args); state.memory = args[2]; return 'archive-42' },
    describe: async (ledger, prior) => { hit('describe'); return describeCheckpoint(ledger, ID, prior) },
    newGeneration: () => { hit('generation'); return 'fresh-generation' }, now: () => { hit('now'); return 5000 },
    hash: async text => { hit('hash'); return createHash('sha256').update(text).digest('hex') },
    publish: async text => { hit('publish'); state.publication = text; return options.fallback ? { unavailable: legacyFallback } : undefined },
    cleanup: async () => { hit('cleanup') }, taint: () => { hit('taint'); state.tainted = true }, deferredCleanup: error => { hit('cleanup.error'); throw error },
    nextIndex: async bucket => { hit('index'); return { [ID]: { at: bucket.savedAt, bytes: new TextEncoder().encode(JSON.stringify({ [`s:${ID}`]: bucket })).length + 1 } } },
    ensureCapacity: async replacements => { hit('capacity'); assert.ok(replacements[`s:${ID}`]); return [] },
    checkCapacity: async replacements => { hit('inline.capacity'); assert.ok(replacements[`s:${ID}`]); return [] },
    commit: async write => {
      hit('commit'); state.recovery = true
      hit(legacyCommitOrder[0]!); store.set(`s:${ID}`, write.bucket)
      if (options.commitError) throw options.commitError
      hit(legacyCommitOrder[1]!); store.set(`h:${ID}`, write.head)
      hit(legacyCommitOrder[2]!); store.set('saved', write.index); state.committed = true
      if (options.late) state.memory = { ...state.memory, steps: [legacyLateStep] }
    },
    updateLedger: async change => { hit('memory'); state.memory = change(state.memory) },
    acknowledgeRevision: revision => { hit('ackRevision'); assert.equal(state.committed, true, 'ack follows durable commit'); state.revision = revision },
    clearRecovery: () => { hit('clearRecovery'); state.recovery = false }, acknowledgeSave: () => { hit('ackSave'); state.saved = true },
    updateState: async change => { hit('durability'); state.durability = change(state.durability) }, fallbackNotice: cause => { hit(`notice:${cause}`) },
  }
  return { ports, events, store, state }
}
const runFailure = async (ports: LegacySavePorts): Promise<unknown> => { try { await saveLegacy(ports) } catch (error) { return error }; throw new Error('expected workflow rejection') }
const successTrace = ['recover', 'recoverCleanup', 'clearClocks', 'repairHead', 'ledger', 'state', 'hasRevision', 'body', 'head', 'state', 'intent', 'ledger', 'body', 'logical', 'head', 'revision', 'generation', 'describe', 'now', 'hash', 'publish', 'cleanup', 'index', 'capacity', 'commit', ...legacyCommitOrder, 'memory', 'ackRevision', 'clearRecovery', 'ackSave', 'durability']

// Same success, missing-body, inline and memory-change inputs/expectations as the frozen native cases.
{
  const f = fixture(); await saveLegacy(f.ports)
  assert.deepEqual(f.events, successTrace)
  const body = f.store.get(`s:${ID}`) as { v: number; generation: string; savedAt: number; ledger?: unknown; checkpoint: { revision: number; checksum: string } }
  assert.deepEqual([body.v, body.generation, body.savedAt, body.ledger, body.checkpoint.revision, body.checkpoint.checksum],
    [2, 'fresh-generation', 5000, undefined, 1, '6ba7124ab3cbae4f59f2dda0f8a486a1034bca18093a93d1d55a903a79b475dd'])
  assert.equal(f.state.publication, JSON.stringify(legacyLedger()))
  assert.deepEqual([f.state.saved, f.state.recovery, f.state.durability.isUnsaved], [true, false, false])
}
const checkpoint = await describeCheckpoint(legacyLedger(), ID)
{
  const head = { v: 1, session_id: ID, generation: 'new-generation', checkpoint: { ...checkpoint, revision: 2 } }
  const f = fixture({ records: { [`h:${ID}`]: head }, baseline: { session_id: ID, ledger: legacyLedger(), checkpoint, generation: 'old-generation' } })
  await assert.rejects(() => saveLegacy(f.ports), { message: missingBodyError }, 'missing-body save must preserve the head and reject')
  assert.equal(f.store.get(`h:${ID}`), head)
  assert.equal(f.store.has(`s:${ID}`), false)
  assert.equal(f.state.archive.length, 1)
  assert.ok(!f.events.includes('commit') && !f.events.includes('generation'))
}
{
  const f = fixture({ fallback: true }); await saveLegacy(f.ports)
  assert.deepEqual((f.store.get(`s:${ID}`) as { ledger: Ledger }).ledger, legacyLedger())
  assert.equal((f.store.get(`s:${ID}`) as { v: number }).v, 1)
  assert.ok(f.events.includes('inline.capacity') && !f.events.includes('cleanup') && !f.events.includes('capacity'))
  assert.equal(f.events.at(-1), `notice:${legacyFallback}`)
}
{
  const f = fixture({ late: true }); await saveLegacy(f.ports)
  assert.deepEqual(f.state.memory.steps, [legacyLateStep])
  assert.deepEqual(f.state.durability.baseline?.ledger.steps, [])
  assert.deepEqual([f.state.durability.isUnsaved, f.state.durability.reason], [true, 'ledger save pending'])
}
// Faulting effects propagate by identity; no acknowledgement is manufactured after a partial commit.
{
  const failure = new Error('actual port commit failure'), f = fixture({ commitError: failure })
  assert.equal(await runFailure(f.ports), failure)
  assert.deepEqual([f.state.saved, f.state.recovery], [false, true])
  assert.ok(!f.events.includes('ackRevision'))
}
// A stale, conflicting update taints BEFORE adoption; its returned archive remains in the error.
const base = { ...legacyLedger(), steps: [{ ...legacyLateStep, id: 'plan:conflict', subject: 'base' }] }
const durable = { ...base, steps: [{ ...base.steps[0]!, subject: 'durable' }] }
const local = { ...base, steps: [{ ...base.steps[0]!, subject: 'local' }] }
const durableCheckpoint = { ...await describeCheckpoint(durable, ID), revision: 2 }
const conflictOptions = { records: { [`s:${ID}`]: { v: 1, session_id: ID, ledger: durable, checkpoint: durableCheckpoint, generation: 'g' }, [`h:${ID}`]: { v: 1, session_id: ID, checkpoint: durableCheckpoint, generation: 'g' } },
  baseline: { session_id: ID, ledger: base, checkpoint, generation: 'g' }, revision: 1, memory: local }
{
  const f = fixture(conflictOptions)
  await assert.rejects(() => saveLegacy(f.ports), { message: `stale writer revision; newer durable ledger was kept; local rows archived in archive-42; reconcile conflict: ${ID}:plan:conflict; both versions were kept` }, 'stale conflicting writer must adopt/archive and reject')
  assert.deepEqual(f.events.slice(-2), ['taint', 'adopt'])
  assert.deepEqual(f.state.memory, durable)
  assert.equal(f.state.saved, false)
}
{
  const failure = new Error('adoption refused'), f = fixture({ ...conflictOptions, adoptError: failure })
  assert.equal(await runFailure(f.ports), failure)
}
// No head/baseline generation also needs a UUID; a missing revision-only body samples twice.
{
  const f = fixture({ revision: 2 }); await saveLegacy(f.ports)
  assert.equal(f.events.filter(e => e === 'describe').length, 2)
  assert.ok(f.events.indexOf('describe') < f.events.indexOf('generation') && f.events.indexOf('generation') < f.events.lastIndexOf('describe'))
  assert.deepEqual(f.store.get(`s:${ID}`), { v: 2, session_id: ID, generation: 'fresh-generation', savedAt: 5000,
    ledger_blob: { checksum: createHash('sha256').update(JSON.stringify(legacyLedger())).digest('hex'), bytes: new TextEncoder().encode(JSON.stringify(legacyLedger())).length },
    checkpoint: { ...checkpoint, revision: 3 }, recovered: true, expected_revision: 2 })
}
console.log('check_legacy_save_flow_ports: 8 stateful cases, exact sequence/value/error/ack contracts; no native host')
