// SOURCE/FIXTURE: required U2 question command extraction, with no native effects moved.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import ts from 'typescript'
import { checkQuestionCommands } from './question_command_cases'

const file = new URL('../../hooks/question-commands.ts', import.meta.url)
assert.ok(existsSync(file), 'missing question command boundary: question-commands.ts')
const commands = await import('../../hooks/question-commands')
checkQuestionCommands(commands)
const source = readFileSync(file, 'utf8')
assert.doesNotMatch(source, /claude-code|from ['"]\.\/register|\b(?:Date|Promise|async|EngineInterface|checksumOf|setTimeout|setInterval)\b|\$(?!\{)/, 'question commands accept explicit values, never native capabilities or clock/hash samplers')
const native = readFileSync(new URL('../../hooks/register.tsx', import.meta.url), 'utf8')
assert.match(native, /from '\.\/question-commands'/, 'native imports the actual component')
const tree = ts.createSourceFile('register.tsx', native, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const nodes: ts.Node[] = []
const visit = (node: ts.Node): void => { nodes.push(node); ts.forEachChild(node, visit) }
visit(tree)
const callName = (node: ts.Node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) ? node.expression.text : undefined
for (const name of ['questionAdmission', 'questionSource', 'mintQuestion', 'withdrawQuestion', 'clearQuestionRows', 'hideAnsweredQuestions', 'mayMarkAnswer', 'markQuestion', 'bindAnswerResponse', 'markerForQuestion', 'captureMarkerAnswer']) {
  const calls = nodes.filter(node => callName(node) === name)
  assert.ok(calls.length > 0, `native delegates ${name}, not an unused parallel implementation`)
  if (['questionSource', 'mintQuestion', 'clearQuestionRows', 'hideAnsweredQuestions', 'mayMarkAnswer', 'markQuestion', 'bindAnswerResponse', 'markerForQuestion', 'captureMarkerAnswer'].includes(name)) {
    for (const call of calls) {
      const ancestors: ts.Node[] = []
      for (let parent = call.parent; parent !== undefined; parent = parent.parent) ancestors.push(parent)
      assert.ok(ancestors.some(node => callName(node) === 'updateOwnedLedger' || callName(node) === 'updateLedger'), `${name} uses CURRENT values inside the native retry callback`)
    }
  }
}
console.log('question commands: literal decisions and native retry ownership pass (SOURCE/FIXTURE)')
