// FIXTURE/SOURCE: Phase1 Stop guidance ownership; no native/LIVE claim.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { PendingInput } from '../../types'

const path = new URL('../../hooks/stop-guidance.ts', import.meta.url)
const source = readFileSync(path, 'utf8')
assert.deepEqual(source.match(/^import .*$/gm), ["import type { PendingInput } from '../types'", "import { truncate, utf8Bytes } from './ledger-text'"])
assert.doesNotMatch(source, /claude-code|EngineInterface|Runtime|\$\.|atom\(|setTimeout\(/, 'guidance is value-only')
// TRACK-46 slices 3 and 5 (2026-11-09, Ohad's standing approval): publishGate and fitInputReason moved
// to ledger-store.ts with two of the three call sites; the third moved with the Stop claim code to
// turn-guidance.ts and was deleted with it in unit 3 step C (the command hook is the only Stop decider).
const store = readFileSync(new URL('../../hooks/ledger-store.ts', import.meta.url), 'utf8')
assert.ok(store.includes('reason: minimalInputReason(i, TRACK_QUESTION)'))
assert.ok(store.includes('uncoveredBlock([inputs[index]!], ANSWER)'))
const tree = ts.createSourceFile('stop-guidance.ts', source, ts.ScriptTarget.Latest, true)
const bodies: Record<string, string> = {}
for (const statement of tree.statements) if (ts.isVariableStatement(statement)) {
  for (const declaration of statement.declarationList.declarations) if (declaration.initializer && ts.isArrowFunction(declaration.initializer)) {
    bodies[declaration.name.getText(tree)] = createHash('sha256').update(declaration.initializer.body.getText(tree)).digest('hex')
  }
}
// Captured from the original native bodies before any production edit; only the
// two explicit instruction bindings were substituted with their parameter names.
assert.equal(bodies.minimalInputReason, '877d7fb49f60e14c16cd521a94f7ded2b2e2979599210a92c3362b56101b6732')
assert.equal(bodies.uncoveredBlock, 'a0a7d7e23f38f31bcf9d08f918cd7b6e8d71da764d1c8b6100c5484b72c4ab86')
const { minimalInputReason, uncoveredBlock } = await import('../../hooks/stop-guidance')
const input = (id: number, excerpt: string, label?: PendingInput['label']): PendingInput => ({ id, excerpt, head: excerpt, textHash: 'fixture', turnId: null, ...(label && { label }) })
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length
const tool = 'mcp__track__track_question'
for (const excerpt of ['Why now?', `Why ${'😀'.repeat(35)}?`, '"\\\n'.repeat(25)]) {
  const row = input(1, excerpt)
  const reason = minimalInputReason(row, tool)
  assert.ok(bytes({ id: row.id, reason }) < 100, 'serialized UTF8 reason row stays strictly below 100 bytes')
  assert.ok(reason.endsWith(` needs ${tool}.`))
}
const empty = input(1, '')
const exactTool = 'x'.repeat(100 - bytes({ id: 1, reason: 'track: "" needs .' }))
assert.equal(bytes({ id: 1, reason: `track: "" needs ${exactTool}.` }), 100)
assert.throws(() => minimalInputReason(empty, exactTool), /bounded Stop input reason exceeded/, 'exactly 100 bytes must be refused')
const w1 = input(1, 'worded-one'), q1 = input(2, 'labelled-one', 'question')
const w2 = input(3, 'worded-two', 'unknown'), q2 = input(4, 'labelled-two', 'question')
assert.equal(uncoveredBlock([], 'ANSWER'), '')
assert.ok(uncoveredBlock([w1], 'ANSWER').startsWith('track: a prompt looks like a question ("worded-one")'))
const labelled = uncoveredBlock([q1], 'ANSWER')
assert.ok(labelled.startsWith('track: the classifier labelled a prompt a question ("labelled-one")'))
assert.ok(!labelled.includes('mcp__track__track_steps'), 'labelled questions never receive step advice')
const mixed = uncoveredBlock([q1, w1, q2, w2], 'ANSWER')
assert.ok(mixed.startsWith('track: these prompts look like questions ("worded-one"; "worded-two")'), 'worded group precedes labelled group and keeps its input order')
assert.ok(mixed.includes('Then finish. track: the classifier labelled these prompts questions ("labelled-one"; "labelled-two")'), 'groups join with one space; labelled group keeps input order')
assert.ok(mixed.includes('ANSWER; for a request instead, reuse a matching open step'))
assert.ok(mixed.includes('ANSWER. If it is a request already tracked as steps'))
console.log('check_stop_guidance: exact original bodies, plain dependencies and Stop message invariants (FIXTURE)')
