// SOURCE/FIXTURE: durable record ownership, compatibility exports and exact moves.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import ts from 'typescript'
import { checkDurableRecord } from './durable_record_cases'

const owner = new URL('../../hooks/durable-record.ts', import.meta.url)
assert.ok(existsSync(owner), 'missing pure durable record owner: durable-record.ts')
const source = readFileSync(owner, 'utf8')
const native = readFileSync(new URL('../../hooks/register.tsx', import.meta.url), 'utf8')
const records = readFileSync(new URL('../../hooks/retention-records.ts', import.meta.url), 'utf8')
const reconcile = readFileSync(new URL('../../hooks/reconcile.ts', import.meta.url), 'utf8')
const sizes = readFileSync(new URL('../../hooks/size-index.ts', import.meta.url), 'utf8')
assert.ok(source.trimEnd().split('\n').length <= 100)
assert.deepEqual(source.match(/^import .*$/gm), ["import type { Checkpoint } from './checkpoint'"])
assert.doesNotMatch(source, /claude-code|EngineInterface|Runtime|\$\.|atom\(|setTimeout\(/)
assert.ok(native.includes("import { sessionHead, bodyMatchesHead, sameRecord as sameValue } from './durable-record'"))
assert.doesNotMatch(native, /^const (?:sessionHead|bodyMatchesHead|sameValue)\b/m)
assert.ok(records.includes("import { sameRecord } from './durable-record'"))
assert.ok(records.includes("export { sameRecord } from './durable-record'"))
assert.doesNotMatch(records, /^export const sameRecord\b/m)
assert.ok(sizes.includes("import { sameRecord as same } from './durable-record'"))
assert.doesNotMatch(sizes, /^const same\b/m)
assert.ok(reconcile.includes("export type { SessionHead } from './durable-record'"))
assert.doesNotMatch(reconcile, /^export type SessionHead\b/m)
assert.ok(source.includes("export type SessionHead = { v: 1; session_id: string; generation: string; checkpoint: Checkpoint; closedAt?: number }"))
assert.ok(source.includes('// Called after repairHead has validated any generation-less legacy body.'))
const tree = ts.createSourceFile('durable-record.ts', source, ts.ScriptTarget.Latest, true)
const bodies: Record<string, string> = {}
for (const statement of tree.statements) if (ts.isVariableStatement(statement)) {
  for (const d of statement.declarationList.declarations) if (d.initializer && ts.isArrowFunction(d.initializer)) {
    bodies[d.name.getText(tree)] = createHash('sha256').update(d.initializer.body.getText(tree)).digest('hex')
  }
}
assert.equal(bodies.sessionHead, '6c590423287385f1c47025fbf29d7d460017b8cf7f719e32f41624e319c4dc22')
assert.equal(bodies.bodyMatchesHead, '7e403341f1fe3fa772f62ae83a040c5c7dcffb238ab1561685492f4a1196ece4')
assert.ok(source.includes('export const sameRecord = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)'))
const rules = await import('../../hooks/durable-record')
const retention = await import('../../hooks/retention')
const compatibility = await import('../../hooks/retention-records')
assert.equal(retention.sameRecord, rules.sameRecord, 'old retention entry preserves exact function identity')
assert.equal(compatibility.sameRecord, rules.sameRecord, 'old records entry preserves exact function identity')
checkDurableRecord(rules)
console.log('durable record owner, original bodies, compatibility identities and semantic cases pass (FIXTURE)')
