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
// Audit repairs: retain both accepted integrations before pinning the authorized fixes.
for (const [commit, path, expected] of [
  ['1bdd7b52fd4ebcde8db795004183a608c351f499', 'hooks/register.tsx', 'f97a9daba7cae65b753341bba0fdc35a639fc9fc07f50117ee0db2a36fa27ded'],
  ['1bdd7b52fd4ebcde8db795004183a608c351f499', 'architecture/archview.toml', '7195449a856219481f064c702750672471f10223c09c767dd5ed97721bcc1e92'],
  ['94f09966dc47249189e87b8c8b91f90c3c86b6a3', 'hooks/register.tsx', 'a8b7247e922f89dac89bc7f89adff7ce2bf13478760265209782b476c5be53c2'],
  ['94f09966dc47249189e87b8c8b91f90c3c86b6a3', 'architecture/archview.toml', '27d383cf7a8f3be47c1997da2567043b64bd8d56e618e93acaa04adee71cfc79'],
] as const) {
  const accepted = spawnSync('git', ['show', `${commit}:track/${path}`], { cwd: W, encoding: 'utf8' })
  assert.equal(accepted.status, 0, `accepted ${commit} ${path} must exist`)
  assert.equal(digest(accepted.stdout), expected, `accepted ${commit} ${path} proof retained`)
}
assert.equal(digest(native), '715775a1b94fa1e0443bfdb34726a9a47405905440fdc1e762a1436701e81889', 'exact reviewed repair integration bytes')
assert.equal(digest(readFileSync(resolve(W, 'track/architecture/archview.toml'), 'utf8')), '98bbf008e9384fa1280c2b69beeef51c2e304a85c50797dc35e3b5a767b1a803', 'exact declared architecture edges')
const source = readFileSync(owner, 'utf8')
assert.ok(source.trimEnd().split('\n').length <= 100, 'frame owner stays within readable 100 lines')
const syntax = ts.createSourceFile('pane-root-view.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const code = ts.createPrinter({ removeComments: true }).printFile(syntax)
assert.doesNotMatch(code, /claude-code|from ['"]\.\/register|\b(?:EngineInterface|Runtime|atom|memberOf|read|update|async|ledger|persistence|clock|process)\b|\$(?!\{)/)
checkFrame(loadTreeModule(source))
console.log('frame tree, original control pins, callbacks and native ownership pass (SOURCE/FIXTURE)')
