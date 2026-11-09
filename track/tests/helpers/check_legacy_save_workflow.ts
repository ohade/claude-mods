// SOURCE: P2.1 ownership gate. Runtime ordering is also pinned by independent port/native fixtures.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// TRACK-46 slice 3 (2026-11-09, Ohad's standing approval): saveLedger moved to ledger-store.ts as a
// function declaration (the engine follows $ across an import only into one); body unchanged.
const native = readFileSync(new URL('../../hooks/ledger-store.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('ledger-store.ts', native, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
assert.doesNotMatch(readFileSync(new URL('../../hooks/register.tsx', import.meta.url), 'utf8'), /\bsaveLegacy\b/, 'register.tsx no longer runs the legacy save')
const nodes: ts.Node[] = []
const visit = (node: ts.Node): void => { nodes.push(node); ts.forEachChild(node, visit) }
visit(tree)
const saves = nodes.filter((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.getText(tree) === 'saveLedger')
assert.equal(saves.length, 1, 'one saveLedger declaration')
const save = saves[0]!
const grants: ts.CallExpression[] = []
const findGrant = (n: ts.Node): void => {
  if (ts.isCallExpression(n) && n.expression.getText(tree) === 'inOwnGrant') grants.push(n)
  ts.forEachChild(n, findGrant)
}
findGrant(save)
assert.equal(grants.length, 1, 'P2.1 save keeps exactly one admitted native grant')
const operation = grants[0]!.arguments[2]!.getText(tree)
assert.match(operation, /await saveLegacy\(/, 'P2.1 admitted save operation must await the imported saveLegacy workflow')
assert.match(native, /import \{ saveLegacy \} from '\.\/legacy-save-flow'/, 'the production caller imports the workflow')
for (const name of ['hasRevision', 'readRevision', 'acknowledgeRevision', 'clearRecovery', 'acknowledgeSave', 'taint']) {
  assert.match(operation, new RegExp(`${name}:`), `${name} is supplied by a native closure`)
}
assert.match(operation, /acknowledgeSave: \(\) => \{ persistence\.failure = ''; saved = true \}/, 'saved is set at its original acknowledgement callback, not at flow return')
for (const filename of ['legacy-save-plan.ts', 'legacy-save-flow.ts']) {
  const source = readFileSync(new URL(`../../hooks/${filename}`, import.meta.url), 'utf8')
  const module = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const check = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) assert.ok(!/claude-code|register/.test(n.moduleSpecifier.getText(module)), 'workflow modules cannot import SDK/native composition')
    if (ts.isTypeReferenceNode(n)) assert.ok(!['EngineInterface', 'WriteContext', 'Map', 'Atom'].includes(n.typeName.getText(module)), 'ports cannot carry native capabilities/state bags')
    ts.forEachChild(n, check)
  }
  check(module)
  assert.ok(!source.includes('crypto.randomUUID') && !source.includes('Date.now()'), 'sampling stays behind native callbacks')
}
const flow = readFileSync(new URL('../../hooks/legacy-save-flow.ts', import.meta.url), 'utf8')
const ordered = ['await ports.commit(', 'await ports.updateLedger(', 'ports.acknowledgeRevision(', 'ports.clearRecovery()', 'ports.acknowledgeSave()', 'await ports.updateState(']
let at = -1
for (const text of ordered) {
  const next = flow.indexOf(text)
  assert.ok(next > at, `original commit/acknowledgement position: ${text}`)
  at = next
}
console.log('check_legacy_save_workflow: native grant/state ownership and imported sequencing')
