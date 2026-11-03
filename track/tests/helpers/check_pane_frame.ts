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
// U4: retain the accepted integration bytes while pinning the new pure prompt wiring.
for (const [path, expected] of [['hooks/register.tsx', 'f97a9daba7cae65b753341bba0fdc35a639fc9fc07f50117ee0db2a36fa27ded'], ['architecture/archview.toml', '7195449a856219481f064c702750672471f10223c09c767dd5ed97721bcc1e92']] as const) {
  const accepted = spawnSync('git', ['show', `1bdd7b52fd4ebcde8db795004183a608c351f499:track/${path}`], { cwd: W, encoding: 'utf8' })
  assert.equal(accepted.status, 0, `accepted pre-U4 ${path} must exist`)
  assert.equal(digest(accepted.stdout), expected, `accepted pre-U4 ${path} proof retained`)
}
assert.equal(digest(native), 'a8b7247e922f89dac89bc7f89adff7ce2bf13478760265209782b476c5be53c2', 'exact accepted native integration bytes')
assert.equal(digest(readFileSync(resolve(W, 'track/architecture/archview.toml'), 'utf8')), '27d383cf7a8f3be47c1997da2567043b64bd8d56e618e93acaa04adee71cfc79', 'exact declared architecture edges')
const source = readFileSync(owner, 'utf8')
assert.ok(source.trimEnd().split('\n').length <= 100, 'frame owner stays within readable 100 lines')
const syntax = ts.createSourceFile('pane-root-view.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const code = ts.createPrinter({ removeComments: true }).printFile(syntax)
assert.doesNotMatch(code, /claude-code|from ['"]\.\/register|\b(?:EngineInterface|Runtime|atom|memberOf|read|update|async|ledger|persistence|clock|process)\b|\$(?!\{)/)
checkFrame(loadTreeModule(source))
console.log('frame tree, original control pins, callbacks and native ownership pass (SOURCE/FIXTURE)')
