// SOURCE/FIXTURE: structural RED is separate from original/candidate behavior parity.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import ts from 'typescript'
import { checkIntake, checkContext } from './prompt_intake_cases'

for (const name of ['prompt-intake.ts', 'prompt-context.ts']) {
  const file = new URL(`../../hooks/${name}`, import.meta.url)
  assert.ok(existsSync(file), `missing production prompt owner: ${name}`)
  const source = readFileSync(file, 'utf8')
  assert.ok(source.trimEnd().split('\n').length <= 100, `${name}: cohesive owner stays within 100 lines`)
  assert.doesNotMatch(source, /claude-code|from ['"]\.\/register|\b(?:EngineInterface|Runtime|atom|memberOf|update|Date|crypto|process|async|Promise)\b|\$(?!\{)/)
}
checkIntake(await import('../../hooks/prompt-intake'))
checkContext(await import('../../hooks/prompt-context'))
// TRACK-46 slice 10 (2026-11-09, Ohad's standing approval): the session/turn/prompt/Stop event handler
// bodies moved to session-events.ts, a native adapter file.
const native = readFileSync(new URL('../../hooks/session-events.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('session-events.ts', native, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const nodes: ts.Node[] = []
const visit = (node: ts.Node): void => { nodes.push(node); ts.forEachChild(node, visit) }
visit(tree)
const callbacks = nodes.filter(ts.isArrowFunction).filter(node => node.parameters.length === 1 && node.parameters[0]!.name.getText(tree) === 'p' && node.body.getText(tree).includes('admitInput('))
assert.equal(callbacks.length, 1, 'native pending retry delegates the actual admission component once')
const callback = callbacks[0]!
assert.ok(ts.isBlock(callback.body))
assert.equal(callback.body.statements[0]!.getText(tree), 'assertAdmitted()', 'owner fencing stays first inside the pending retry')
assert.match(callback.body.getText(tree), /added = admission\.added/)
assert.match(callback.body.getText(tree), /full = admission\.full/)
assert.match(native, /from '\.\/prompt-context'/)
assert.match(native, /unregisteredContext\(unresolved\)/)
assert.match(native, /promptContext\(l, e\.text, ANSWER\)/)
console.log('prompt intake/context: literal policies, immutable inputs and native retry ownership pass (SOURCE/FIXTURE)')
