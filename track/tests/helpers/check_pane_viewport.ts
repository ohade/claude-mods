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
  ['8fde8221a613d3c3d325c6d4ee7c361993d3a8a7', 'hooks/register.tsx', '150409c3546a9717d1c74b431a4ae2eced1f5a96eeb7c026efc77e49949a8dd7'],
  ['8fde8221a613d3c3d325c6d4ee7c361993d3a8a7', 'architecture/archview.toml', 'fbe030f32f0a760baff49f1b3160d00cc011127ed712b2ccb1fb98aa2dbb01a4'],
  ['176723737602c08e3d137528594473182138ad20', 'hooks/register.tsx', '5cb78e99746c0f189c4cdec62fd675abf1405504f10b3cfb9ace9c911e441bc3'],
  ['176723737602c08e3d137528594473182138ad20', 'architecture/archview.toml', '20d9f04ae491ead78da545acd91a429c3721c9539733f9cbfcfd412bd6960cad'],
  ['53cf6e4a56acc9293cef9158f40071746200fa37', 'hooks/register.tsx', '3971deece0b7d5d4612fa5f79a365e3349979b186dc9565e4649e1d75d5009fe'],
  ['53cf6e4a56acc9293cef9158f40071746200fa37', 'architecture/archview.toml', 'b9a842c7e97ba9fa2601df086ef724ae9d40facc2e7708de1d137e2dbc72712c'],
  ['c738a09a5059123c179d1005a82f5b262777a476', 'hooks/register.tsx', '239840f3ca0ef36233ef3c24f3feb2ae51a6e41fb24e9d38a677db9a54159b6b'],
  ['c738a09a5059123c179d1005a82f5b262777a476', 'architecture/archview.toml', '545549084074cccb81e80910995f41737907eb1444a58f3732371298c47170e5'],
  ['9b53b9a6b705796aa4fd4555f63a7738dbdcc13a', 'hooks/register.tsx', 'd0b5828da4e2d0583e16e056099f3be8cdf8fa4b0546c8014dc3576165781864'],
  ['9b53b9a6b705796aa4fd4555f63a7738dbdcc13a', 'architecture/archview.toml', '3668aa7811b5b5c6b311ef186656fbc26c09bd60fed58680cae7cf5ba2027b55'],
  ['832dd3fde4ed4328e8f73f672537bc80203a9633', 'hooks/register.tsx', 'fc2c31d5bd583e5fd1f1e79673255e14ca271f56c791e9e9378fdad0a5062173'],
  ['832dd3fde4ed4328e8f73f672537bc80203a9633', 'architecture/archview.toml', '605b1b74b0ad02a69aa21cdb6d8f39340d320e7951839b115dee97cca9759d38'],
  ['26c2183e4495a5d363ccca0e224012a8d156992a', 'hooks/register.tsx', '9db81640dcfe4db3eb02cda92d54bbb1d1094eae82542a677c294b0a932c1e12'],
  ['26c2183e4495a5d363ccca0e224012a8d156992a', 'architecture/archview.toml', '649f6fd4378c155312ca658ee2f32201a7b6b9044c622f35c1b809e2132014f2'],
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
// TRACK-46 slice 5 (Ohad's standing approval for reviewed refactor moves): retained at 8fde822 above.
// TRACK-46 slice 6 (Ohad's standing approval for reviewed refactor moves): retained at 1767237 above.
// TRACK-46 slice 7 (Ohad's standing approval for reviewed refactor moves): retained at 53cf6e4 above.
// TRACK-46 slice 8 (Ohad's standing approval for reviewed refactor moves): retained at c738a09 above.
// TRACK-46 slice 9 (Ohad's standing approval for reviewed refactor moves): retained at 9b53b9a above.
// TRACK-46 slice 10 (Ohad's standing approval for reviewed refactor moves): retained at 832dd3f above.
// TRACK-46 slice 11 (Ohad's standing approval for reviewed refactor moves): retained at 26c2183 above.
// TRACK-46 slice 1 (2026-11-09, Ohad's standing approval for reviewed refactor moves): retain the
// fix-list bytes (cfcab31) above; pin the slice-1 register and the track-state.ts it moved code into.
// 2026-11-09 (Ohad chose re-pointing with Codex review): the number column, bold labels and
// one-line rows change ui-render.tsx; its slice 11 bytes stay proven at 86399dc.
const sliceEleven = spawnSync('git', ['show', '86399dc4938a89019623fe8c90f1e40a90f2b488:track/hooks/ui-render.tsx'], { cwd: new URL('../../..', import.meta.url), encoding: 'utf8' })
assert.equal(sliceEleven.status, 0, 'accepted slice 11 ui-render source must exist')
assert.equal(hash(sliceEleven.stdout), '3b51a3cd844639d4ed08b413dbb0ef9e0a3c0ab414c83f62b4af68756cbbdd7b', 'accepted 86399dc ui-render.tsx proof retained')
for (const [name, expected] of [['register.tsx', 'c4dbe2b648349c41a283027bbede8e5257eec5ee5d23b369fe94e64af5750304'], ['ui-render.tsx', 'd6747322c4fef46f17242e1d554f4c1cb88cd94798ca3ae2fe92b809990a7519'], ['session-events.ts', 'c7bbb24692797af79c60a50fe9436091e975003f367e6b70c5fe79ecaa1a06e5'], ['task-mirror.ts', '07cd1308204266fca1a011bee0e25cc4fcf0900690c124a8424b7fd9e9e86b68'], ['track-tools.ts', '72216c8d0bfbe67a433ddeb799ec5273589887b847f0416a587addfdb0d51a7d'], ['pane-actions.tsx', 'eae9f401e8e9b26c4c056765e3377043eda4387894231f58b3aecb4525c7d4c6'], ['prompt-flow.ts', 'ee1e7f8c21fec548c78cf590e62377de49f951848eca8280811198cbe6018f8d'], ['turn-guidance.ts', 'f41151f7d87f6e846f4b0a58823e89571378d3427bc2979c37f8982a352f2482'], ['session-owner.ts', '4ebaadd3ea362b3fa34aa17ff7f63872b3ce687fdf13c0f9b1c323e313bbb729'], ['ledger-store.ts', 'dc840582aa3f43f767001b7432308d91357ef5cbea82233811391616cb304c25'], ['writer-lock.ts', 'a6d981c2331da2571b7a52802f48541a73737932706617feab5127ca545a1413'], ['track-state.ts', 'b71da1704c09321f13d74f617539fe0235cef6710b789a22eb7f3a3bb89061bb'], ['pane-layout.ts', 'c99c84921d0342a27bdc98c7b4ca55848e8112325d842e29e725709bfd3801a8']] as const) {
  assert.equal(hash(readFileSync(hook(name), 'utf8')), expected, `${name}: exact bulk-clear/P2.1 integration`)
}
assert.equal(hash(readFileSync(new URL('../../architecture/archview.toml', import.meta.url), 'utf8')), 'a3ebeb1b2ab59c5ee59998655aa4ae31c48c57237570cace0b0b927ada40c0f8', 'exact declared architecture edges')
const { paneRowMetrics } = await import('../../hooks/pane-row-metrics')
const { paneViewport } = await import('../../hooks/pane-viewport-model')
checkViewport(input => {
  const metrics = paneRowMetrics(input)
  return project(metrics, paneViewport({ ...input, metrics, questionCount: input.questions.length, stepCount: input.steps.length }), input.steps, input.questions)
})
console.log('viewport literal geometry, original parity, native boundary and scope pass (SOURCE/FIXTURE)')
