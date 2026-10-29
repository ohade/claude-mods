// FIXTURE: retention module boundaries and byte-identical moved bodies; no native/LIVE claim.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

// Body pins come from 2ec5385 hooks/retention.ts: per module, blank and import
// lines dropped, a leading `export ` stripped. Moves keep bytes and order.
const modules = {
  records: { cap: 100, sha: '2cf84e74860a7eb05472e6295702d57b28b814ca6220f365b9bdcc1548f992e2', imports: [],
    owns: ['RetentionStore', 'HOUR', 'CLOSED_TTL', 'BATCH', 'WORK_MS', 'CLEANUP', 'SESSION_ID', 'Guard', 'Probe', 'Value', 'RecoveryEntry', 'CleanupRecovery', 'ExpiryIntent',
      'recoveryAfter', 'recoveryKey', 'sameRecord', 'writeVerified', 'ownedKeys', 'validClock', 'RECORD_KEY', 'sessionOf', 'hasAmbiguousIdentity', 'isInlineV1Body', 'isImported', 'expiryClockOf'] },
  expiry: { cap: 100, sha: '2c1404c74c672887292ad5e66a7fa35c63d71ee2979f5dd47c62a05bfe12dda9', imports: ['./checkpoint', './retention-records', './size-index'],
    owns: ['deletionIntent', 'SwitchArchive', 'switchSource', 'holdArchiveSources', 'finishExpiry'] },
  eviction: { cap: 100, sha: 'cf3b4b0cf5c40bd0cc79dffc8eb0e31a9325706069476a71af9f1658ad40244d', imports: ['./retention-expiry', './retention-records'],
    owns: ['Compaction', 'Eviction', 'CONFLICT_RECORD', 'evictionOrder', 'holdClosed', 'releaseRejectedGuards', 'confirmEviction'] },
  capacity: { cap: 120, sha: 'd161d5f2a56a41b0993f2d3db419d4ceb11f5ad1eb6b74cbecd89fe5828bc9f7', imports: ['./retention-eviction', './retention-expiry', './retention-records', './size-index'],
    owns: ['readSizes', 'fitsSizes', 'checkSizes', 'evictSession', 'ensureCapacity'] },
  journal: { cap: 120, sha: 'b8ef12dec96ebc63f1d820356ef6c7606f4b6d4244e7b76157a09135fe0cce75', imports: ['./checkpoint', './retention-capacity', './retention-expiry', './retention-records', './size-index'],
    owns: ['recoverCleanup', 'clearOwnedClocks', 'changeRecord'] },
  cleanup: { cap: 145, sha: '9f1c587810c9da4c377e1bbc7b610a2f02959891a082ef7bcbdc529812aebf8d', imports: ['./retention-capacity', './retention-eviction', './retention-expiry', './retention-journal', './retention-records'],
    owns: ['stampMissingClock', 'migrateInline', 'cleanupRecords'] },
} as const
const compatImports = ['./retention-capacity', './retention-cleanup', './retention-eviction', './retention-journal', './retention-records']
const compatValues = ['CLOSED_TTL', 'cleanupRecords', 'clearOwnedClocks', 'ensureCapacity', 'isInlineV1Body', 'recoverCleanup', 'sameRecord', 'writeVerified']
const compatNames = [...compatValues, 'Compaction', 'Guard', 'RetentionStore'].sort()

const hook = (name: string) => new URL(`../../hooks/${name}.ts`, import.meta.url)
for (const name of Object.keys(modules)) assert.ok(existsSync(hook(`retention-${name}`)), `missing retention module: retention-${name}.ts`)
const read = (name: string) => readFileSync(hook(name), 'utf8')
const declares = (source: string, symbol: string) => new RegExp(`^(?:export )?(?:const|type) ${symbol}\\b`, 'm').test(source)
const specifiers = (source: string) => source.split('\n').filter(line => line.startsWith('import ')).map(line => {
  const match = /^import (?:type )?\{[^}]*\} from '(\.\/[a-z-]+)'$/.exec(line)
  assert.ok(match, `single-line named import from a sibling: ${line}`)
  return match[1]!
}).sort()

const sources = Object.fromEntries(Object.keys(modules).map(name => [name, read(`retention-${name}`)]))
const compat = read('retention')
for (const [name, spec] of Object.entries(modules)) {
  const source = sources[name]!
  assert.ok(source.trimEnd().split('\n').length <= spec.cap, `retention-${name}.ts stays within ${spec.cap} lines`)
  assert.deepEqual(specifiers(source), [...spec.imports], `retention-${name}.ts imports exactly its dependencies`)
  for (const symbol of spec.owns) {
    assert.ok(declares(source, symbol), `retention-${name}.ts owns ${symbol}`)
    for (const [other, text] of Object.entries(sources)) if (other !== name) assert.ok(!declares(text, symbol), `${symbol} is declared only in retention-${name}.ts`)
    assert.ok(!declares(compat, symbol), `retention.ts does not declare ${symbol}`)
  }
  const body = source.split('\n').filter(line => line.trim() !== '' && !line.startsWith('import ')).map(line => line.replace(/^export /, '')).join('\n')
  assert.equal(createHash('sha256').update(body).digest('hex'), spec.sha, `retention-${name}.ts moves its baseline bodies, comments and order unchanged`)
}

// The compatibility entry only re-exports the baseline surface.
const compatLines = compat.split('\n').filter(line => line.trim() !== '')
assert.ok(compatLines.length <= 15, 'retention.ts stays a thin compatibility entry')
for (const line of compatLines) assert.match(line, /^export (?:type )?\{[^}]*\} from '\.\/retention-[a-z]+'$/, `retention.ts only re-exports: ${line}`)
assert.deepEqual([...new Set(compatLines.map(line => /from '(.+)'$/.exec(line)![1]!))].sort(), compatImports, 'retention.ts re-exports from its siblings')
const exported = compatLines.flatMap(line => /\{([^}]*)\}/.exec(line)![1]!.split(',').map(name => name.trim().replace(/^type /, ''))).filter(Boolean).sort()
assert.deepEqual(exported, compatNames, 'retention.ts exports exactly the baseline names')

// Imports follow the named boundary assertions so a missing module yields assertion-red.
const entry = await import('../../hooks/retention')
assert.deepEqual(Object.keys(entry).sort(), compatValues, 'runtime export set is unchanged')
const owners: Record<string, keyof typeof modules> = { CLOSED_TTL: 'records', sameRecord: 'records', writeVerified: 'records', isInlineV1Body: 'records',
  recoverCleanup: 'journal', clearOwnedClocks: 'journal', ensureCapacity: 'capacity', cleanupRecords: 'cleanup' }
for (const [symbol, owner] of Object.entries(owners)) {
  const sibling = await import(`../../hooks/retention-${owner}`) as Record<string, unknown>
  assert.equal((entry as Record<string, unknown>)[symbol], sibling[symbol], `retention.ts re-exports ${symbol} from retention-${owner}.ts`)
}
console.log('retention: six cohesive modules, unchanged moved bodies and baseline exports (FIXTURE)')
