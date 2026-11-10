// SOURCE/FIXTURE: read-only frame ownership, native pins and pure tree checks.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { W, checkFrame, loadTreeModule, assertPaneNative } from './pane_frame_cases'

const owner = resolve(W, 'track/hooks/pane-root-view.tsx')
// TRACK-46 slice 11 (2026-11-09, Ohad's standing approval): the pane and transcript UI handler bodies
// moved to ui-render.tsx, a native adapter file; the pane drawing is checked there.
const ui = readFileSync(resolve(W, 'track/hooks/ui-render.tsx'), 'utf8')
// 2026-11-10 (Ohad: no expand control, rows show up to three lines; titles over 90 characters
// are refused; re-pointing with Codex review): earlier bytes stay proven at 2fff299.
assertPaneNative(ui, 'd7d533ce8aff2bd2616fc170b6f4e640016ee144549cf93f6b0ae0817e66327f', '9ed415faf544bf13056903af9c6f85ea3b1591035fd55a299aa4a9b446279f1f')
const source = readFileSync(owner, 'utf8')
const syntax = ts.createSourceFile('pane-root-view.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const code = ts.createPrinter({ removeComments: true }).printFile(syntax)
assert.doesNotMatch(code, /claude-code|from ['"]\.\/register|\b(?:EngineInterface|Runtime|atom|memberOf|read|update|async|ledger|persistence|clock|process)\b|\$(?!\{)/)
checkFrame(loadTreeModule(source))
console.log('frame tree, original control pins, callbacks and native ownership pass (SOURCE/FIXTURE)')
