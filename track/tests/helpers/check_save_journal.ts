// FIXTURE: save journal (2026-10-30). Fake callbacks record an ordered call log that is compared with
// literal expected traces; the source part pins the moved bodies and the native adapter that calls them.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { commitSave, rollbackSave } from '../../hooks/save-journal'
import type { SaveJournal, SaveRecovery, SaveWrite } from '../../hooks/save-journal'
import type { SessionHead } from '../../hooks/reconcile'

type Fault = { tag: string; nth?: number; fail?: boolean; value?: unknown }

const makeJournal = (seed: Array<[string, unknown]>, faults: Fault[] = []) => {
  const store = new Map<string, unknown>(seed)
  const log: string[] = []
  const blobArgs: unknown[] = []
  const seen = new Map<string, number>()
  const hit = (tag: string): Fault | undefined => {
    log.push(tag)
    const n = (seen.get(tag) ?? 0) + 1
    seen.set(tag, n)
    const fault = faults.find(f => f.tag === tag && (f.nth === undefined || f.nth === n))
    if (fault?.fail === true) throw new Error(`injected ${tag}`)
    return fault
  }
  const journal: SaveJournal = {
    read: async key => {
      const fault = hit(`R:${key}`)
      return fault !== undefined && 'value' in fault ? fault.value : store.get(key)
    },
    keys: async () => { hit('K'); return [...store.keys()] },
    set: async (key, value) => { hit(`G:set:${key}`); store.set(key, value) },
    delete: async key => { hit(`G:del:${key}`); store.delete(key) },
    writeVerified: async (key, value) => { hit(`W:${key}`); store.set(key, value) },
    taint: () => { log.push('T') },
    restoreBlob: async (pointer, text) => { blobArgs.push([pointer, text]); hit('B') },
  }
  return { journal, store, log, blobArgs }
}

const failure = async (p: Promise<unknown>): Promise<string> => {
  try { await p } catch (error) { return error instanceof Error ? error.message : String(error) }
  return '<resolved>'
}

const head = { v: 1, session_id: 'x', generation: 'g2', checkpoint: {} } as unknown as SessionHead
const previousHead = { v: 1, session_id: 'x', generation: 'g1', checkpoint: {} }
const previous = { savedAt: 1 }
const bucket = { savedAt: 5, note: 'attempt' }
const previousIndex = { x: { at: 1, bytes: 30 } }
const index = { x: { at: 5, bytes: 40 } }
const write: SaveWrite = { previous, previousBlobText: undefined, bucket, previousHead, head, index }
const recovery = (overrides: Partial<SaveRecovery> = {}): SaveRecovery => {
  return { previous, previousBlobText: undefined, bucket, previousHead, head, previousIndex, index, ...overrides }
}

// C1 commit success.
{
  const { journal, log } = makeJournal([['saved', previousIndex]])
  const map = new Map<string, SaveRecovery>()
  await commitSave(journal, map, 'x', write)
  assert.deepEqual(log, ['R:saved', 'G:set:s:x', 'R:s:x', 'W:h:x', 'G:set:saved', 'R:saved'], 'C1 commit exact order')
  assert.deepEqual(map.get('x'), {
    previous: { savedAt: 1 }, previousBlobText: undefined, bucket: { savedAt: 5, note: 'attempt' },
    previousHead: { v: 1, session_id: 'x', generation: 'g1', checkpoint: {} },
    head: { v: 1, session_id: 'x', generation: 'g2', checkpoint: {} },
    previousIndex: { x: { at: 1, bytes: 30 } }, index: { x: { at: 5, bytes: 40 } },
  }, 'C1 stored recovery is the exact literal contract')
}

// C2 commit, R:saved throws.
{
  const { journal, log } = makeJournal([['saved', previousIndex]], [{ tag: 'R:saved', fail: true }])
  const map = new Map<string, SaveRecovery>()
  assert.equal(await failure(commitSave(journal, map, 'x', write)), 'injected R:saved', 'C2 error propagates')
  assert.deepEqual(log, ['R:saved'], 'C2 log')
  assert.equal(map.has('x'), false, 'C2 map has no x')
}

// C3 commit, body read-back altered.
{
  const { journal, log } = makeJournal([['saved', previousIndex]], [{ tag: 'R:s:x', value: { savedAt: 99 } }])
  const map = new Map<string, SaveRecovery>()
  assert.equal(await failure(commitSave(journal, map, 'x', write)), 'save read-back did not match the acknowledged ledger', 'C3 exact error text')
  assert.equal(map.has('x'), true, 'C3 map holds x')
  assert.deepEqual(log, ['R:saved', 'G:set:s:x', 'R:s:x'], 'C3 log ends at R:s:x')
}

// C4 commit, index read-back altered.
{
  const { journal, log } = makeJournal([['saved', previousIndex]], [{ tag: 'R:saved', nth: 2, value: { other: 1 } }])
  const map = new Map<string, SaveRecovery>()
  assert.equal(await failure(commitSave(journal, map, 'x', write)), 'save index read-back did not match', 'C4 exact error text')
  assert.deepEqual(log, ['R:saved', 'G:set:s:x', 'R:s:x', 'W:h:x', 'G:set:saved', 'R:saved'], 'C4 log ends at the final R:saved')
}

// C5 rollback with no recovery.
{
  const { journal, log } = makeJournal([])
  await rollbackSave(journal, new Map(), 'x')
  assert.deepEqual(log, [], 'C5 no calls and no taint')
}

// C6 rollback with all values already previous.
{
  const { journal, log } = makeJournal([['s:x', previous], ['h:x', previousHead], ['saved', previousIndex]])
  const map = new Map([['x', recovery()]])
  await rollbackSave(journal, map, 'x')
  assert.deepEqual(log, ['R:s:x', 'R:h:x', 'R:saved'], 'C6 log')
  assert.equal(map.has('x'), false, 'C6 map entry deleted')
}

// C7 rollback where body/head/index equal the attempted values.
{
  const { journal, log, store } = makeJournal([['s:x', bucket], ['h:x', head], ['saved', index]])
  const map = new Map([['x', recovery()]])
  await rollbackSave(journal, map, 'x')
  assert.deepEqual(log, ['R:s:x', 'G:set:s:x', 'R:s:x', 'R:h:x', 'W:h:x', 'R:saved', 'G:set:saved', 'R:saved'], 'C7 log with previous s defined')
  assert.equal(map.has('x'), false, 'C7 map entry deleted')
  assert.deepEqual([store.get('s:x'), store.get('h:x'), store.get('saved')], [previous, previousHead, previousIndex], 'C7 previous values restored')
}
{
  const { journal, log, store } = makeJournal([['s:x', bucket], ['h:x', head], ['saved', index]])
  const map = new Map([['x', recovery({ previous: undefined })]])
  await rollbackSave(journal, map, 'x')
  assert.deepEqual(log, ['R:s:x', 'G:del:s:x', 'R:s:x', 'R:h:x', 'W:h:x', 'R:saved', 'G:set:saved', 'R:saved'], 'C7 log with previous s undefined')
  assert.equal(map.has('x'), false, 'C7 map entry deleted with previous s undefined')
  assert.equal(store.has('s:x'), false, 'C7 body deleted')
}

// C8 body changed by another writer.
{
  const { journal, log } = makeJournal([['s:x', { savedAt: 77 }], ['h:x', head], ['saved', index]])
  const map = new Map([['x', recovery()]])
  const message = await failure(rollbackSave(journal, map, 'x'))
  assert.ok(message.includes('save recovery kept a changed durable ledger; reload this session before writing'), 'C8 error names the changed ledger')
  assert.deepEqual(log, ['R:s:x', 'T', 'R:h:x', 'W:h:x', 'R:saved', 'G:set:saved', 'R:saved'], 'C8 taint then head and index still visited')
  assert.equal(map.has('x'), true, 'C8 map kept')
}

// C9 W:h:x throws.
{
  const { journal, log } = makeJournal([['s:x', previous], ['h:x', head], ['saved', index]], [{ tag: 'W:h:x', fail: true }])
  const map = new Map([['x', recovery()]])
  assert.equal(await failure(rollbackSave(journal, map, 'x')), 'injected W:h:x', 'C9 error')
  assert.deepEqual(log, ['R:s:x', 'R:h:x', 'W:h:x', 'T', 'R:saved', 'G:set:saved', 'R:saved'], 'C9 taint then index block still runs')
  assert.equal(map.has('x'), true, 'C9 map kept')
}

// C10 'saved' differs from both its previous and attempted values.
{
  const foreign = { y: { at: 7, bytes: 10 } }
  const { journal, log, store } = makeJournal([['s:x', previous], ['h:x', previousHead], ['saved', foreign], ['s:y', { savedAt: 7 }], ['s:z', { savedAt: 9 }]])
  const map = new Map([['x', recovery()]])
  await rollbackSave(journal, map, 'x')
  assert.deepEqual(log, ['R:s:x', 'R:h:x', 'R:saved', 'K', 'R:saved', 'R:s:x', 'R:s:z', 'G:set:saved', 'R:saved'], 'C10 savedIndex rebuild')
  assert.deepEqual(store.get('saved'), {
    x: { at: 1, bytes: 22, unfinished: true },
    y: { at: 7, bytes: 10 },
    z: { at: 9, bytes: 22, unfinished: true },
  }, 'C10 foreign index entries kept in the restored value')
  assert.equal(map.has('x'), false, 'C10 map entry deleted')
}

// C11 previous.v === 2.
{
  const v2 = { v: 2, ledger_blob: { checksum: 'c', bytes: 3 } }
  const { journal, log, blobArgs } = makeJournal([['s:x', v2], ['h:x', previousHead], ['saved', previousIndex]])
  const map = new Map([['x', recovery({ previous: v2, previousBlobText: 'abc' })]])
  await rollbackSave(journal, map, 'x')
  assert.deepEqual(log, ['B', 'R:s:x', 'R:h:x', 'R:saved'], 'C11 B comes first')
  assert.deepEqual(blobArgs, [[{ checksum: 'c', bytes: 3 }, 'abc']], 'C11 pointer and text passed through')
}
{
  const v2 = { v: 2, ledger_blob: { checksum: 'c', bytes: 3 } }
  const { journal, log } = makeJournal([['s:x', v2]], [{ tag: 'B', fail: true }])
  const map = new Map([['x', recovery({ previous: v2, previousBlobText: 'abc' })]])
  assert.equal(await failure(rollbackSave(journal, map, 'x')), 'injected B', 'C11 restoreBlob error propagates')
  assert.deepEqual(log, ['B'], 'C11 log is B only, no taint')
  assert.equal(map.has('x'), true, 'C11 map kept')
}

// Source assertions. tests/fixtures/save-journal-origin.txt holds the moved register.tsx bodies byte for
// byte as they stood before the extraction, so later register edits cannot move these anchors.
const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const originText = source('../fixtures/save-journal-origin.txt')
const originLines = originText.split('\n')
const moduleText = source('../../hooks/save-journal.ts')
const moduleLines = moduleText.split('\n')
// TRACK-46 slice 3 (2026-11-09, Ohad's standing approval): the native save adapter moved to
// ledger-store.ts; its $-taking functions are function declarations, bodies unchanged.
const storeText = source('../../hooks/ledger-store.ts')
const storeLines = storeText.split('\n')
const transform = (lines: string[], pairs: Array<[string, string]>): string[] =>
  lines.map(line => pairs.reduce((text, [from, to]) => text.split(from).join(to), line))
const dedent = (lines: string[]): string[] => lines.map(line => line.replace(/^ {2}/, ''))
// From the one line equal to `first` through the next line that `isLast` accepts, both included.
const span = (id: string, lines: string[], first: string, isLast: (line: string) => boolean): string[] => {
  const from = lines.indexOf(first)
  assert.ok(from >= 0 && lines.indexOf(first, from + 1) < 0, `${id} anchor occurs once: ${first}`)
  const to = lines.findIndex((line, i) => i > from && isLast(line))
  assert.ok(to > from, `${id} anchor has an end: ${first}`)
  return lines.slice(from, to + 1)
}
const closes = (line: string): boolean => line === '}'

const T1: Array<[string, string]> = [['$.store.keys()', 'reads.keys()'], ['$.store.get(', 'reads.read(']]
assert.deepEqual(
  span('S1', moduleLines, 'export const savedIndex = async (reads: SavedReads): Promise<SavedIndex> => {', closes).slice(1),
  transform(span('S1', originLines, 'const savedIndex = async ($: EngineInterface): Promise<SavedIndex> => {', closes).slice(1), T1),
  'S1 savedIndex body is the origin body under T1')

const T2: Array<[string, string]> = [
  ['await $.store.get(', 'await journal.read('], ['retentionStore($, context).delete(', 'journal.delete('],
  ['retentionStore($, context).set(', 'journal.set('], ['writeVerified($, context, ', 'journal.writeVerified('],
  ['context.tainted = true', 'journal.taint()'], ['sameValue(', 'sameRecord('], ['savedIndex($)', 'savedIndex(journal)'],
]
const failuresEnd = (line: string): boolean => line.startsWith('  if (failures.length > 0)')
assert.deepEqual(
  span('S2', moduleLines, '  const failures: string[] = []', failuresEnd),
  transform(span('S2', originLines, '  const failures: string[] = []', failuresEnd), T2),
  'S2 rollback blocks are the origin blocks under T2')


for (const banned of ['claude-code', 'EngineInterface', '$.']) {
  assert.equal(moduleText.includes(banned), false, `S4 save-journal.ts has no ${banned}`)
}

const patchFirst = "// A caller's planned index takes a compacted session's new raw size in place."
assert.deepEqual(
  span('S5', moduleLines, patchFirst, closes),
  transform(span('S5', originLines, patchFirst, closes), [['const patchCompacted = ', 'export const patchCompacted = ']]),
  'S5 patchCompacted is the origin declaration, exported')

assert.deepEqual(
  span('S6', moduleLines, 'export const nextIndex = async (reads: SavedReads, id: string, bucket: { savedAt: number }): Promise<SavedIndex> => {', line => line.startsWith('  return ')).slice(1),
  transform(dedent(span('S6', originLines, '    const bytes = utf8Bytes({ [`s:${id}`]: bucket }) + 1', line => line.startsWith('    const index = '))),
    [['savedIndex($)', 'savedIndex(reads)'], ['const index = ', 'return ']]),
  'S6 nextIndex body is the origin index plan, returned')

// The native adapter: the open-writer check precedes the map read, reads stay raw, each write takes
// a new guarded retention store, and the origin blob block keeps its checks under its own name.
assert.deepEqual(span('N1', storeLines, 'export async function recoverSave($: EngineInterface, context: WriteContext, id: string): Promise<void> {', closes), [
  'export async function recoverSave($: EngineInterface, context: WriteContext, id: string): Promise<void> {',
  '  assertWriteOpen(context)',
  '  await rollbackSave(saveJournal($, context), saveRecoveries, id)',
  '}',
], 'N1 recoverSave checks the open writer, then delegates to rollbackSave')

assert.deepEqual(span('N2', storeLines, 'export function storeReads($: EngineInterface): SavedReads {', line => line.startsWith('  restoreBlob: ')), [
  'export function storeReads($: EngineInterface): SavedReads {',
  '  return ({ read: key => $.store.get(key), keys: () => $.store.keys() })',
  '}',
  'export function saveJournal($: EngineInterface, context: WriteContext): SaveJournal {',
  '  return ({ ...storeReads($),',
  '  set: (key, value) => retentionStore($, context).set(key, value), delete: key => retentionStore($, context).delete(key),',
  '  writeVerified: (key, value) => writeVerified($, context, key, value), taint: () => { context.tainted = true },',
  '  restoreBlob: (pointer, text) => restorePreviousBlob($, context, pointer, text) })',
], 'N2 save journal callbacks: raw reads, guarded writes')

assert.deepEqual(
  span('N3', storeLines, 'export async function restorePreviousBlob($: EngineInterface, context: WriteContext, pointer: { checksum?: unknown; bytes?: unknown } | undefined, text: string | undefined): Promise<void> {', closes).slice(1, -1),
  transform(dedent(span('N3', originLines, '    const text = recovery.previousBlobText', line => line === '  const failures: string[] = []').slice(1, -2)),
    [['previous.ledger_blob?.', 'pointer?.']]),
  'N3 restorePreviousBlob is the origin blob block bound to its parameters')

assert.deepEqual(span('N4', storeLines, 'export async function writeVerified($: EngineInterface, context: WriteContext, key: string, value: unknown): Promise<void> {', closes), [
  'export async function writeVerified($: EngineInterface, context: WriteContext, key: string, value: unknown): Promise<void> {',
  '  await transactionOperation(context, () => writeRetentionValue(retentionStore($, context), key, value))',
  '}',
], 'N4 writeVerified keeps its outer transactionOperation')

for (const line of [
  "import { SAVED_INDEX, commitSave, nextIndex, patchCompacted, rollbackSave, savedIndex } from './save-journal'",
  "import type { SaveJournal, SavedIndex, SavedReads } from './save-journal'",
  '      nextIndex: bucket => nextIndex(storeReads($), id, bucket),',
  '      commit: write => commitSave(saveJournal($, context), saveRecoveries, id, write),',
  '      clearRecovery: () => { saveRecoveries.delete(id) },',
  '    const index = await savedIndex(storeReads($))',
]) assert.equal(storeLines.filter(other => other === line).length, 1, `N5 ledger-store has exactly one: ${line.trim()}`)
// P2.1 moved these three statements to the imported flow, retaining the native callbacks above.
const flowLines = readFileSync(new URL('../../hooks/legacy-save-flow.ts', import.meta.url), 'utf8').split('\n')
for (const line of [
  '  const index = await ports.nextIndex(bucket)',
  '  await ports.commit({ previous, previousBlobText, bucket, previousHead, head: nextHead, index })',
  '  ports.clearRecovery()',
]) assert.equal(flowLines.filter(other => other === line).length, 1, `N5 imported flow has exactly one: ${line.trim()}`)

console.log('check_save_journal: C1-C11, S0-S6 and N1-N5 passed')
