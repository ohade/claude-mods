// SOURCE/FIXTURE: required U3 boundaries, explicit values and native retry ownership.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'
import { checkStepCommands } from './step_command_cases'

for (const name of ['step-commands.ts', 'task-sync-commands.ts']) {
  assert.ok(existsSync(new URL(`../../hooks/${name}`, import.meta.url)), `missing step command boundary: ${name}`)
}
const steps = await import('../../hooks/step-commands')
const tasks = await import('../../hooks/task-sync-commands')
checkStepCommands(steps, tasks)
for (const name of ['step-commands.ts', 'task-sync-commands.ts']) {
  const source = readFileSync(new URL(`../../hooks/${name}`, import.meta.url), 'utf8')
  assert.doesNotMatch(source, /claude-code|from ['"]\.\/register|\b(?:Date|crypto|Promise|async|EngineInterface|checksumOf|setTimeout|setInterval)\b|\$(?!\{)/, `${name} accepts explicit data, no native capabilities or samplers`)
}
const native = readFileSync(new URL('../../hooks/register.tsx', import.meta.url), 'utf8')
const tree = (source: string) => ts.createSourceFile('register.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const all = (root: ts.Node): ts.Node[] => { const nodes: ts.Node[] = []; const visit = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, visit) }; visit(root); return nodes }
const current = tree(native)
const nodes = all(current)
const callName = (node: ts.Node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) ? node.expression.text : undefined
const ownedRetry = (node: ts.Node): ts.Node | undefined => {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) if (callName(parent) === 'updateOwnedLedger') return parent
  return undefined
}
for (const name of ['planInsertion', 'insertPlan', 'replacePlan', 'markStep', 'createTask', 'updateTask', 'replaceTodos']) {
  const calls = nodes.filter(node => callName(node) === name)
  assert.ok(calls.length > 0, `native consumes ${name}`)
  for (const call of calls) {
    assert.ok(ownedRetry(call), `${name} decides from CURRENT retry values`)
  }
}
const creations = nodes.filter(node => callName(node) === 'newPlanStep')
assert.equal(creations.length, 2, 'one insertion row factory and one replacement row factory remain native')
const retriedCreation = creations.filter(node => ownedRetry(node) !== undefined)
assert.equal(retriedCreation.length, 1, 'insertion samples identities inside retry; replacement samples before retry')
const insertionPlan = nodes.find(node => callName(node) === 'planInsertion')!
const insertionApply = nodes.find(node => callName(node) === 'insertPlan')!
assert.strictEqual(ownedRetry(insertionPlan), ownedRetry(retriedCreation[0]!))
assert.strictEqual(ownedRetry(insertionApply), ownedRetry(retriedCreation[0]!))
assert.ok(insertionPlan.pos < retriedCreation[0]!.pos && retriedCreation[0]!.pos < insertionApply.pos, 'native identity sampling stays after current insertion planning and before application')
const baseline = spawnSync('git', ['show', '3404abafde36bce38dbd7690ca5008ea137904ce:track/hooks/register.tsx'], { cwd: new URL('../../..', import.meta.url), encoding: 'utf8' })
assert.equal(baseline.status, 0)
const printer = ts.createPrinter({ removeComments: true })
const sampler = (source: ts.SourceFile) => {
  const declarations = all(source).filter(ts.isVariableDeclaration).filter(node => node.name.getText(source) === 'newPlanStep')
  assert.equal(declarations.length, 1, 'one native row-identity sampler')
  return printer.printNode(ts.EmitHint.Unspecified, declarations[0]!, source)
}
assert.equal(sampler(current), sampler(tree(baseline.stdout)), 'native newPlanStep row identity sampling remains unchanged')
console.log('step commands: literal domain cases, native identity sampler and retry ownership pass (SOURCE/FIXTURE)')
