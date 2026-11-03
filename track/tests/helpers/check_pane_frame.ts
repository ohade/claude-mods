// SOURCE/FIXTURE: read-only frame ownership, native pins and pure tree checks.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { W, digest, checkFrame, loadTreeModule, assertNative, assertPaneNative } from './pane_frame_cases'

const owner = resolve(W, 'track/hooks/pane-root-view.tsx')
assert.ok(existsSync(owner), 'missing production frame owner: pane-root-view.tsx')
const native = readFileSync(resolve(W, 'track/hooks/register.tsx'), 'utf8')
// 2026-11-03: U2 changes question initializers, so retain the whole-file frame
// extraction proof on its accepted candidate and check current pane ownership.
const frameCandidate = spawnSync('git', ['show', 'c3d0f3017523dd93091b21fa2fd79982d30cfe55:track/hooks/register.tsx'], { cwd: W, encoding: 'utf8' })
assert.equal(frameCandidate.status, 0, 'accepted frame candidate source must exist')
assertNative(frameCandidate.stdout)
assertPaneNative(native)
assert.equal(digest(native), 'f228eeb0b3cc82b167d1d477757eaa6ad1977c4c022aca2e0b2a573388f37ac3', 'exact accepted native integration bytes')
assert.equal(digest(readFileSync(resolve(W, 'track/architecture/archview.toml'), 'utf8')), '85f0b4052b798af50f26f5414b9ed2362e218483048a1ec7bbb35839acbe63ae', 'exact declared architecture edges')
const source = readFileSync(owner, 'utf8')
assert.ok(source.trimEnd().split('\n').length <= 100, 'frame owner stays within readable 100 lines')
const syntax = ts.createSourceFile('pane-root-view.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const code = ts.createPrinter({ removeComments: true }).printFile(syntax)
assert.doesNotMatch(code, /claude-code|from ['"]\.\/register|\b(?:EngineInterface|Runtime|atom|memberOf|read|update|async|ledger|persistence|clock|process)\b|\$(?!\{)/)
checkFrame(loadTreeModule(source))
console.log('frame tree, original control pins, callbacks and native ownership pass (SOURCE/FIXTURE)')
