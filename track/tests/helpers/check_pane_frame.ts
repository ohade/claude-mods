// SOURCE/FIXTURE: read-only frame ownership, native pins and pure tree checks.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { W, digest, checkFrame, loadTreeModule, assertNative } from './pane_frame_cases'

const owner = resolve(W, 'track/hooks/pane-root-view.tsx')
assert.ok(existsSync(owner), 'missing production frame owner: pane-root-view.tsx')
const native = readFileSync(resolve(W, 'track/hooks/register.tsx'), 'utf8')
assertNative(native)
assert.equal(digest(native), 'ad6346342dc8d7a684ea992e8bb6c5fea2b93e08a5ee8a39bbd1ae30cbf36a94', 'exact planned native bytes')
assert.equal(digest(readFileSync(resolve(W, 'track/architecture/archview.toml'), 'utf8')), '4491808c8cf5c13a136e8e79d6c13c78f4cd17009d022d337dba4b8101c09359', 'exact named architecture additions only')
const source = readFileSync(owner, 'utf8')
assert.ok(source.trimEnd().split('\n').length <= 100, 'frame owner stays within readable 100 lines')
const syntax = ts.createSourceFile('pane-root-view.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const code = ts.createPrinter({ removeComments: true }).printFile(syntax)
assert.doesNotMatch(code, /claude-code|from ['"]\.\/register|\b(?:EngineInterface|Runtime|atom|memberOf|read|update|async|ledger|persistence|clock|process)\b|\$(?!\{)/)
checkFrame(loadTreeModule(source))
console.log('frame tree, original control pins, callbacks and native ownership pass (SOURCE/FIXTURE)')
