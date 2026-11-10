// SOURCE/FIXTURE: required U3 boundaries, explicit values and native retry ownership.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'
import { checkStepCommands } from './step_command_cases'

const steps = await import('../../hooks/step-commands')
const tasks = await import('../../hooks/task-sync-commands')
checkStepCommands(steps, tasks)
for (const name of ['step-commands.ts', 'task-sync-commands.ts']) {
  const source = readFileSync(new URL(`../../hooks/${name}`, import.meta.url), 'utf8')
  assert.doesNotMatch(source, /claude-code|from ['"]\.\/register|\b(?:Date|crypto|Promise|async|EngineInterface|checksumOf|setTimeout|setInterval)\b|\$(?!\{)/, `${name} accepts explicit data, no native capabilities or samplers`)
}
// newPlanStep's owner is track-tools.ts (TRACK-46 slice 8: the Track tool handler bodies moved there).
const tools = readFileSync(new URL('../../hooks/track-tools.ts', import.meta.url), 'utf8')
const tree = (source: string) => ts.createSourceFile('register.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const all = (root: ts.Node): ts.Node[] => { const nodes: ts.Node[] = []; const visit = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, visit) }; visit(root); return nodes }
const current = tree(tools)
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
