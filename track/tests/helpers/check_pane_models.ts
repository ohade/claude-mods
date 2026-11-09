// SOURCE/FIXTURE: the banner has pure activity and row owners, with native effects retained.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { checkPaneModels } from './pane_models_cases'

const hook = (name: string) => new URL(`../../hooks/${name}`, import.meta.url)
for (const name of ['pane-banner-model.ts', 'pane-banner-state.ts']) {
  assert.ok(existsSync(hook(name)), `missing production banner owner: ${name}`)
  const source = readFileSync(hook(name), 'utf8')
  assert.ok(source.trimEnd().split('\n').length <= 100, `${name} stays within 100 lines`)
  assert.doesNotMatch(source, /claude-code|from ['"]\.\/register|\b(?:EngineInterface|Runtime|atom|memberOf|update|Date|crypto|process)\b|\$(?!\{)/)
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
// Audit repairs: retain both accepted integrations before pinning the authorized fixes.
for (const [commit, path, expected] of [
  ['1bdd7b52fd4ebcde8db795004183a608c351f499', 'hooks/register.tsx', 'f97a9daba7cae65b753341bba0fdc35a639fc9fc07f50117ee0db2a36fa27ded'],
  ['1bdd7b52fd4ebcde8db795004183a608c351f499', 'architecture/archview.toml', '7195449a856219481f064c702750672471f10223c09c767dd5ed97721bcc1e92'],
  ['94f09966dc47249189e87b8c8b91f90c3c86b6a3', 'hooks/register.tsx', 'a8b7247e922f89dac89bc7f89adff7ce2bf13478760265209782b476c5be53c2'],
  ['94f09966dc47249189e87b8c8b91f90c3c86b6a3', 'architecture/archview.toml', '27d383cf7a8f3be47c1997da2567043b64bd8d56e618e93acaa04adee71cfc79'],
  ['95249cfaca36afe9e9ca3b72ffe4f6dad20ba724', 'hooks/register.tsx', '715775a1b94fa1e0443bfdb34726a9a47405905440fdc1e762a1436701e81889'],
  ['95249cfaca36afe9e9ca3b72ffe4f6dad20ba724', 'architecture/archview.toml', '98bbf008e9384fa1280c2b69beeef51c2e304a85c50797dc35e3b5a767b1a803'],
  ['cec1475e9817c2d7b94babbe2a26b6a24ac43dc7', 'hooks/register.tsx', 'a6a7925ae886aec9deefa56bf0555cd04ad7c2d9c7124ed9746aad9b257db76e'],
  ['cec1475e9817c2d7b94babbe2a26b6a24ac43dc7', 'architecture/archview.toml', '0794df4369145445081976bb5f3ad59feacc2b1b7434b16b0246bfc033a4b35c'],
  ['6f201d77bbe521b3c9b3bfcec3f65206888cd0cb', 'hooks/register.tsx', 'e3f6855f903f51b531544689d4e995f6144a2c5c35bdf6180053c2a1d53ab242'],
  ['202fd1eafba32710401b2efe1c88c12d388dc1f7', 'hooks/register.tsx', 'bbb985c269b2ef4794e503e5b05579b1363b3568fbd3a392e68b1dc781c919ca'],
  ['56499875419239c85f5541af389b932949fb60e4', 'hooks/register.tsx', 'a4ef3c8cb15f95c0cccc1376bb5ef0dbd2e3931d5709dc5404fd2ebb8a82a38b'],
  ['482034d8af849595386964df5b5fde5b4d8ccb42', 'hooks/register.tsx', 'a3787c4d3db84b270dd7b26a69bcb8de1d94d85b7967e822122b41b72ba0b7a6'],
  ['6f201d77bbe521b3c9b3bfcec3f65206888cd0cb', 'architecture/archview.toml', '075c3350887caeb8dca4275e91662aa62b71544d38640a7274353d535148016c'],
  ['7b990c645b3532b932ffdfa387175bab5cd2bd22', 'hooks/register.tsx', '6ddf341f0479ca9aced6e949cf70dce8561a2f958e1e07e9c0127247ec4f49bf'],
  ['ccf959c3d37b6379249dd2dff5a7ebcaf4f587fe', 'hooks/register.tsx', '13e7aec8e44f171eefc6bb7d2fcd4c62c1d5b8fa1e50f44cf07d18e2ac8917a3'],
  ['cbae7eb76a7aef2af67d5b96450cc15ed449ceb0', 'hooks/register.tsx', '8a14b98ed1ee075b328714a77846937fc64efcf2644626f45beabbfeb21570ef'],
  ['6a444b37622025a7f7a1b673fadeb3960ff055ec', 'hooks/register.tsx', '8c65b519e391996e7eb786ffc4ded6c57b319f7c28022752a8062bbf56267e74'],
  ['cfcab31a951a0a29c0fb87faf366e2bc67b04495', 'architecture/archview.toml', '8b1b40df9ae3e5442ae15b0778570e9cd29d43eb626e1164c0e3416543543da3'],
  ['cfcab31a951a0a29c0fb87faf366e2bc67b04495', 'hooks/register.tsx', '7d563c4f072a632d4f56752a2771a47c5f9621a24ff7ccb661e1a3fcdb5fa693'],
] as const) {
  const accepted = spawnSync('git', ['show', `${commit}:track/${path}`], { cwd: new URL('../../..', import.meta.url), encoding: 'utf8' })
  assert.equal(accepted.status, 0, `accepted ${commit} ${path} must exist`)
  assert.equal(hash(accepted.stdout), expected, `accepted ${commit} ${path} proof retained`)
}
const native = readFileSync(hook('register.tsx'), 'utf8')
// 2026-11-09 (approved by Ohad, "approve check"): retain the plan:5 bytes (6a444b3) above; pin the
// Codex-accepted TRACK-46 fix list (S2, A7, A5, S3/C2, A2, A4, A1/C1 i-iv) below.
// TRACK-46 slice 1 (2026-11-09, Ohad's standing approval for reviewed refactor moves): retain the
// fix-list bytes (cfcab31) above; pin the slice-1 register and the track-state.ts it moved code into.
assert.equal(hash(native), 'd2e7def5a2f3ea0aadca533f87dffbb588a5760fe6691d4866aff4bdbc0b11a7', 'exact bulk-clear/P2.1 integration bytes')
assert.equal(hash(readFileSync(hook('track-state.ts'), 'utf8')), 'b71da1704c09321f13d74f617539fe0235cef6710b789a22eb7f3a3bb89061bb', 'exact track-state bytes')
const arch = readFileSync(new URL('../../architecture/archview.toml', import.meta.url), 'utf8')
assert.equal(hash(arch), '524079a66eaad1198c084d190fc23e678a01f720bd834f5182c517a31a5be30d', 'exact declared architecture edges')
const { paneBanner } = await import('../../hooks/pane-banner-model')
checkPaneModels(paneBanner)
console.log('banner ownership, native integration and frozen parity cases pass (SOURCE/FIXTURE)')
