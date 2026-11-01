// SOURCE/FIXTURE: history read routing has a capability-free production owner.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import ts from 'typescript'
import { checkHistoryView } from './history_view_cases'
const path = new URL('../../hooks/history-view.ts', import.meta.url)
assert.ok(existsSync(path), 'missing history read component: history-view.ts')
const source = readFileSync(path, 'utf8')
const native = readFileSync(new URL('../../hooks/register.tsx', import.meta.url), 'utf8')
assert.ok(source.trimEnd().split('\n').length <= 100)
assert.doesNotMatch(source, /claude-code|EngineInterface|\$\.|atom\(|crypto\.|Date\.now|process\.run/)
assert.match(native, /import { readHistoryView } from '\.\/history-view'/)
assert.doesNotMatch(native, /^type History(?:Root|View) =/m)
const tree = ts.createSourceFile('history-view.ts', source, ts.ScriptTarget.Latest, true)
const arrows = tree.statements.flatMap(s => ts.isVariableStatement(s) ? [...s.declarationList.declarations] : [])
const fn = arrows.find(d => d.name.getText(tree) === 'readHistoryView')?.initializer
assert.ok(fn && ts.isArrowFunction(fn))
assert.equal(createHash('sha256').update(fn.body.getText(tree)).digest('hex'), '757a6fa00bdf3aaa99c97010f8715501e20ca425c82c6039bf473c78f0a36eb8', 'original read body changes only its two capability calls')
assert.ok(native.includes("readHistoryView({ read: (store, id) => runHistory($, 'read', { v: 3, op: 'read', store, session_id: id }), legacy: key => $.store.get(key) }, store, id)"), 'native adapter preserves exact read request and store lookup')
const { readHistoryView } = await import('../../hooks/history-view')
await checkHistoryView(readHistoryView)
console.log('history read ownership, exact body and routing cases pass (FIXTURE)')
