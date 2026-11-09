// SOURCE/FIXTURE: row measurements and fitting are pure; native retains its frame and effects.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { checkViewport, project } from './pane_viewport_cases'

const hook = (name: string) => new URL(`../../hooks/${name}`, import.meta.url)
for (const name of ['pane-row-metrics.ts', 'pane-viewport-model.ts']) {
  assert.ok(existsSync(hook(name)), `missing production viewport owner: ${name}`)
  const source = readFileSync(hook(name), 'utf8')
  assert.ok(source.trimEnd().split('\n').length <= 100, `${name} stays within 100 lines`)
  assert.doesNotMatch(source, /claude-code|from ['"]\.\/register|\b(?:EngineInterface|Runtime|atom|memberOf|update|Date|crypto|process)\b|\$(?!\{)/)
}
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
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
  ['bd7a0be8449a90c1d2719a3a5d690abced013ce5', 'hooks/register.tsx', 'd2e7def5a2f3ea0aadca533f87dffbb588a5760fe6691d4866aff4bdbc0b11a7'],
  ['bd7a0be8449a90c1d2719a3a5d690abced013ce5', 'architecture/archview.toml', '524079a66eaad1198c084d190fc23e678a01f720bd834f5182c517a31a5be30d'],
  ['b3f2af88a78ae41a63323a9e3967d58f96ac82c7', 'hooks/register.tsx', '5b38218f34f4ed53d22c24d5dd5ccd27f1cee7188dc88a90377d1f63f2d566a3'],
  ['b3f2af88a78ae41a63323a9e3967d58f96ac82c7', 'architecture/archview.toml', 'e18bfc81a16c29c332a353c467f6e8e199e1b0dd27cc27f31cb0c05709c33449'],
  ['34e7478b26e2f482a1533dd421e7967279754c17', 'hooks/register.tsx', '1eba503559b018e9aeb1024bd94036cae93944c7b9bb6ec1deab18e0f41df6ac'],
  ['34e7478b26e2f482a1533dd421e7967279754c17', 'architecture/archview.toml', '6a924648cfcbaffa81096c8db001228cff7f8d08422a43afb4ce6b84e0fd0abc'],
] as const) {
  const accepted = spawnSync('git', ['show', `${commit}:track/${path}`], { cwd: new URL('../../..', import.meta.url), encoding: 'utf8' })
  assert.equal(accepted.status, 0, `accepted ${commit} ${path} must exist`)
  assert.equal(hash(accepted.stdout), expected, `accepted ${commit} ${path} proof retained`)
}
// 2026-11-09 (approved by Ohad, "approve check"): retain the plan:5 bytes (6a444b3) above; pin the
// Codex-accepted TRACK-46 fix list (S2, A7, A5, S3/C2, A2, A4, A1/C1 i-iv) below.
// TRACK-46 slice 2 (Ohad's standing approval for reviewed refactor moves): retained at bd7a0be above.
// TRACK-46 slice 3 (Ohad's standing approval for reviewed refactor moves): retained at b3f2af8 above.
// TRACK-46 slice 4 (Ohad's standing approval for reviewed refactor moves): retained at 34e7478 above.
// TRACK-46 slice 1 (2026-11-09, Ohad's standing approval for reviewed refactor moves): retain the
// fix-list bytes (cfcab31) above; pin the slice-1 register and the track-state.ts it moved code into.
for (const [name, expected] of [['register.tsx', '150409c3546a9717d1c74b431a4ae2eced1f5a96eeb7c026efc77e49949a8dd7'], ['session-owner.ts', '4ebaadd3ea362b3fa34aa17ff7f63872b3ce687fdf13c0f9b1c323e313bbb729'], ['ledger-store.ts', 'dc840582aa3f43f767001b7432308d91357ef5cbea82233811391616cb304c25'], ['writer-lock.ts', 'a6d981c2331da2571b7a52802f48541a73737932706617feab5127ca545a1413'], ['track-state.ts', 'b71da1704c09321f13d74f617539fe0235cef6710b789a22eb7f3a3bb89061bb'], ['pane-layout.ts', 'c99c84921d0342a27bdc98c7b4ca55848e8112325d842e29e725709bfd3801a8']] as const) {
  assert.equal(hash(readFileSync(hook(name), 'utf8')), expected, `${name}: exact bulk-clear/P2.1 integration`)
}
assert.equal(hash(readFileSync(new URL('../../architecture/archview.toml', import.meta.url), 'utf8')), 'fbe030f32f0a760baff49f1b3160d00cc011127ed712b2ccb1fb98aa2dbb01a4', 'exact declared architecture edges')
const { paneRowMetrics } = await import('../../hooks/pane-row-metrics')
const { paneViewport } = await import('../../hooks/pane-viewport-model')
checkViewport(input => {
  const metrics = paneRowMetrics(input)
  return project(metrics, paneViewport({ ...input, metrics, questionCount: input.questions.length, stepCount: input.steps.length }), input.steps)
})
console.log('viewport literal geometry, original parity, native boundary and scope pass (SOURCE/FIXTURE)')
