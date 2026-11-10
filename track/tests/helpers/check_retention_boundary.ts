// FIXTURE: retention module boundaries and byte-identical moved bodies; no native/LIVE claim.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

// Body pins come from 2ec5385 hooks/retention.ts: per module, blank and import
// lines dropped, a leading `export ` stripped. Moves keep bytes and order.
const modules = {
  records: { sha: '7e614a22c7636232450584066df247f7505d1be62c8586e2f7b9560f415d6565', imports: ['./durable-record'] },
  expiry: { sha: '2c1404c74c672887292ad5e66a7fa35c63d71ee2979f5dd47c62a05bfe12dda9', imports: ['./checkpoint', './retention-records', './size-index'] },
  eviction: { sha: 'cf3b4b0cf5c40bd0cc79dffc8eb0e31a9325706069476a71af9f1658ad40244d', imports: ['./retention-expiry', './retention-records'] },
  capacity: { sha: 'd161d5f2a56a41b0993f2d3db419d4ceb11f5ad1eb6b74cbecd89fe5828bc9f7', imports: ['./retention-eviction', './retention-expiry', './retention-records', './size-index'] },
  journal: { sha: 'b8ef12dec96ebc63f1d820356ef6c7606f4b6d4244e7b76157a09135fe0cce75', imports: ['./checkpoint', './retention-capacity', './retention-expiry', './retention-records', './size-index'] },
  cleanup: { sha: '9f1c587810c9da4c377e1bbc7b610a2f02959891a082ef7bcbdc529812aebf8d', imports: ['./retention-capacity', './retention-eviction', './retention-expiry', './retention-journal', './retention-records'] },
} as const
const equalityForward = "export { sameRecord } from './durable-record'"

const hook = (name: string) => new URL(`../../hooks/${name}.ts`, import.meta.url)
const read = (name: string) => readFileSync(hook(name), 'utf8')
const specifiers = (source: string) => source.split('\n').filter(line => line.startsWith('import ')).map(line => {
  const match = /^import (?:type )?\{[^}]*\} from '(\.\/[a-z-]+)'$/.exec(line)
  assert.ok(match, `single-line named import from a sibling: ${line}`)
  return match[1]!
}).sort()

const sources = Object.fromEntries(Object.keys(modules).map(name => [name, read(`retention-${name}`)]))
for (const [name, spec] of Object.entries(modules)) {
  const source = sources[name]!
  assert.deepEqual(specifiers(source), [...spec.imports], `retention-${name}.ts imports exactly its dependencies`)
  // records pin is the original body minus ONLY the moved sameRecord declaration.
  // Its exact required forwarding line is wiring, left out of the body.
  const body = source.split('\n').filter(line => line.trim() !== '' && !line.startsWith('import ') && !(name === 'records' && line === equalityForward)).map(line => line.replace(/^export /, '')).join('\n')
  assert.equal(createHash('sha256').update(body).digest('hex'), spec.sha, `retention-${name}.ts moves its baseline bodies, comments and order unchanged`)
}
console.log('retention: six cohesive modules, unchanged moved bodies and baseline exports (FIXTURE)')
