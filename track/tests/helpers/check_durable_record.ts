// SOURCE/FIXTURE: durable record ownership, compatibility exports and exact moves.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { checkDurableRecord } from './durable_record_cases'

const owner = new URL('../../hooks/durable-record.ts', import.meta.url)
const source = readFileSync(owner, 'utf8')
assert.deepEqual(source.match(/^import .*$/gm), ["import type { Checkpoint } from './checkpoint'"])
assert.doesNotMatch(source, /claude-code|EngineInterface|Runtime|\$\.|atom\(|setTimeout\(/)
assert.ok(source.includes("export type SessionHead = { v: 1; session_id: string; generation: string; checkpoint: Checkpoint; closedAt?: number }"))
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
checkDurableRecord(rules)
console.log('durable record owner, original bodies, compatibility identities and semantic cases pass (FIXTURE)')
