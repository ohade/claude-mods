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
// TRACK-46 slice 11 (2026-11-09, Ohad's standing approval): the pane and transcript UI handler bodies
// moved to ui-render.tsx, a native adapter file; the pane drawing is checked there.
const ui = readFileSync(resolve(W, 'track/hooks/ui-render.tsx'), 'utf8')
// 2026-11-03: U2 changes question initializers, so retain the whole-file frame
// extraction proof on its accepted candidate and check current pane ownership.
const frameCandidate = spawnSync('git', ['show', 'c3d0f3017523dd93091b21fa2fd79982d30cfe55:track/hooks/register.tsx'], { cwd: W, encoding: 'utf8' })
assert.equal(frameCandidate.status, 0, 'accepted frame candidate source must exist')
assertNative(frameCandidate.stdout)
// 2026-11-07: the reviewed cold-resume fix adds one same-session saved answerInstance fallback to
// the questions row map; that arrow stays proven on its accepted source, 6a444b3.
const coldResume = spawnSync('git', ['show', '6a444b37622025a7f7a1b673fadeb3960ff055ec:track/hooks/register.tsx'], { cwd: W, encoding: 'utf8' })
assert.equal(coldResume.status, 0, 'accepted cold-resume source must exist')
assertPaneNative(coldResume.stdout, '2a8e69dc1142bf6baef536724495b4e8ca376510dcf0c614be0d49b529f43a27')
// 2026-11-09 (approved by Ohad): the Codex-accepted TRACK-46 A1/C1 fix passes the drawn ledger's
// session to a question's ✕ (4a68cb9); that arrow stays proven on its accepted source, 86399dc.
const sliceEleven = spawnSync('git', ['show', '86399dc4938a89019623fe8c90f1e40a90f2b488:track/hooks/ui-render.tsx'], { cwd: W, encoding: 'utf8' })
assert.equal(sliceEleven.status, 0, 'accepted slice 11 ui-render source must exist')
assertPaneNative(sliceEleven.stdout, '4ef12b69b0e77739f0deb7d5714abb13eada99cbe950241a563cd2ac96f428cd')
// 2026-11-09 (Ohad chose re-pointing with Codex review): the number column, bold labels and
// one-line rows change both row maps; pin those exact arrows on the live file.
const oneLine = spawnSync('git', ['show', 'd97373db885ca75fc49e6ce38c2ec74f098229f7:track/hooks/ui-render.tsx'], { cwd: W, encoding: 'utf8' })
assert.equal(oneLine.status, 0, 'accepted one-line rows ui-render source must exist')
assertPaneNative(oneLine.stdout, 'c10684b004e2dbe3a1e2d688252573919613034159fecc41735ea039f10da346', '72f6f5a1a025116204c945fe89874e1a3d8aeea5f414da32ac27b9671ee3f2d8')
// 2026-11-09 (Ohad: rows may take a second line before the fold control; re-pointing with Codex
// review): two-line folded rows change ui-render.tsx; its one-line bytes stay proven at d97373d.
const twoLine = spawnSync('git', ['show', 'adec4e764c65213ec3044e984c0de42cf26021dc:track/hooks/ui-render.tsx'], { cwd: W, encoding: 'utf8' })
assert.equal(twoLine.status, 0, 'accepted two-line rows ui-render source must exist')
assertPaneNative(twoLine.stdout, 'de2ae670749c89681a757e89316a3b43dc60c7e4faf1d5253704f28127e33aae', 'c091924f2b6ce7579438cc0b9871b16fd725d940a3a8d3ed5bbb9f5000234a5b')
// 2026-11-09 (Ohad: the fold control follows the clock and results start under the row text;
// re-pointing with Codex review): ui-render.tsx changes; its two-line bytes stay proven at adec4e7.
const placed = spawnSync('git', ['show', '2fff299bc6e2e242cd4dbd6000d03b3f3144c39a:track/hooks/ui-render.tsx'], { cwd: W, encoding: 'utf8' })
assert.equal(placed.status, 0, 'accepted placement ui-render source must exist')
assertPaneNative(placed.stdout, 'de2ae670749c89681a757e89316a3b43dc60c7e4faf1d5253704f28127e33aae', 'eef58ce4815f6980b5e6eb65e7f029632afb67ea4d5cc2ee3250eefe2cf9538d')
// 2026-11-10 (Ohad: no expand control, rows show up to three lines; titles over 90 characters
// are refused; re-pointing with Codex review): earlier bytes stay proven at 2fff299.
assertPaneNative(ui, 'd7d533ce8aff2bd2616fc170b6f4e640016ee144549cf93f6b0ae0817e66327f', '9ed415faf544bf13056903af9c6f85ea3b1591035fd55a299aa4a9b446279f1f')
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
  ['86399dc4938a89019623fe8c90f1e40a90f2b488', 'hooks/ui-render.tsx', '3b51a3cd844639d4ed08b413dbb0ef9e0a3c0ab414c83f62b4af68756cbbdd7b'],
  ['d97373db885ca75fc49e6ce38c2ec74f098229f7', 'hooks/ui-render.tsx', 'd6747322c4fef46f17242e1d554f4c1cb88cd94798ca3ae2fe92b809990a7519'],
  ['adec4e764c65213ec3044e984c0de42cf26021dc', 'hooks/ui-render.tsx', 'b386d376f8afeacf4789596490f3bb338fc9f27feb9f6f1af1f13982abdb2f79'],
  ['2fff299bc6e2e242cd4dbd6000d03b3f3144c39a', 'hooks/ui-render.tsx', '3f56d49e76d56ef3febfe54f839258569f5c6daf40da3ef407dad3179a9f7756'],
  ['2fff299bc6e2e242cd4dbd6000d03b3f3144c39a', 'hooks/track-tools.ts', '852e869f9d404c9b9d9a970584174f7efc592d9f87a22e238eeed142ccd1aa3e'],
  ['b4e98dd928a9b95c25f0472dd22a4be747d02faf', 'hooks/track-tools.ts', '72216c8d0bfbe67a433ddeb799ec5273589887b847f0416a587addfdb0d51a7d'],
] as const) {
  const accepted = spawnSync('git', ['show', `${commit}:track/${path}`], { cwd: W, encoding: 'utf8' })
  assert.equal(accepted.status, 0, `accepted ${commit} ${path} must exist`)
  assert.equal(digest(accepted.stdout), expected, `accepted ${commit} ${path} proof retained`)
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
assert.equal(digest(native), 'c4dbe2b648349c41a283027bbede8e5257eec5ee5d23b369fe94e64af5750304', 'exact bulk-clear/P2.1 integration bytes')
assert.equal(digest(readFileSync(resolve(W, 'track/hooks/track-state.ts'), 'utf8')), 'b71da1704c09321f13d74f617539fe0235cef6710b789a22eb7f3a3bb89061bb', 'exact track-state bytes')
// 2026-11-09 (Ohad chose re-pointing with Codex review): the number column, bold labels and
// one-line rows change ui-render.tsx; its slice 11 bytes stay proven at 86399dc above.
// 2026-11-09 (Ohad: rows may take a second line before the fold control; re-pointing with Codex
// review): two-line folded rows change ui-render.tsx; its one-line bytes stay proven at d97373d.
// 2026-11-09 (Ohad: the fold control follows the clock and results start under the row text;
// re-pointing with Codex review): ui-render.tsx changes; its two-line bytes stay proven at adec4e7.
assert.equal(digest(readFileSync(resolve(W, 'track/hooks/ui-render.tsx'), 'utf8')), 'e7dfee0ba514a6d223e0a885a9447197e1536fc4bcfe6b290bb483e7c3430d15', 'exact ui-renderx bytes')
assert.equal(digest(readFileSync(resolve(W, 'track/hooks/session-events.ts'), 'utf8')), 'c7bbb24692797af79c60a50fe9436091e975003f367e6b70c5fe79ecaa1a06e5', 'exact session-events bytes')
assert.equal(digest(readFileSync(resolve(W, 'track/hooks/task-mirror.ts'), 'utf8')), '07cd1308204266fca1a011bee0e25cc4fcf0900690c124a8424b7fd9e9e86b68', 'exact task-mirror bytes')
// 2026-11-09 (Ohad: titles over 90 characters get a shorten-it note; re-pointing with Codex
// review): track-tools.ts changes; its earlier bytes stay proven at b4e98dd.
assert.equal(digest(readFileSync(resolve(W, 'track/hooks/track-tools.ts'), 'utf8')), 'ef7b8088fd8f41b7e78a9810be77588a68498e9f7b2cffdba1a6365ce3f3c894', 'exact track-tools bytes')
assert.equal(digest(readFileSync(resolve(W, 'track/hooks/pane-actions.tsx'), 'utf8')), 'eae9f401e8e9b26c4c056765e3377043eda4387894231f58b3aecb4525c7d4c6', 'exact pane-actionsx bytes')
assert.equal(digest(readFileSync(resolve(W, 'track/hooks/prompt-flow.ts'), 'utf8')), 'ee1e7f8c21fec548c78cf590e62377de49f951848eca8280811198cbe6018f8d', 'exact prompt-flow bytes')
assert.equal(digest(readFileSync(resolve(W, 'track/hooks/turn-guidance.ts'), 'utf8')), 'f41151f7d87f6e846f4b0a58823e89571378d3427bc2979c37f8982a352f2482', 'exact turn-guidance bytes')
assert.equal(digest(readFileSync(resolve(W, 'track/hooks/session-owner.ts'), 'utf8')), '4ebaadd3ea362b3fa34aa17ff7f63872b3ce687fdf13c0f9b1c323e313bbb729', 'exact session-owner bytes')
assert.equal(digest(readFileSync(resolve(W, 'track/hooks/ledger-store.ts'), 'utf8')), 'dc840582aa3f43f767001b7432308d91357ef5cbea82233811391616cb304c25', 'exact ledger-store bytes')
assert.equal(digest(readFileSync(resolve(W, 'track/hooks/writer-lock.ts'), 'utf8')), 'a6d981c2331da2571b7a52802f48541a73737932706617feab5127ca545a1413', 'exact writer-lock bytes')
assert.equal(digest(readFileSync(resolve(W, 'track/architecture/archview.toml'), 'utf8')), 'a3ebeb1b2ab59c5ee59998655aa4ae31c48c57237570cace0b0b927ada40c0f8', 'exact declared architecture edges')
const source = readFileSync(owner, 'utf8')
assert.ok(source.trimEnd().split('\n').length <= 100, 'frame owner stays within readable 100 lines')
const syntax = ts.createSourceFile('pane-root-view.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const code = ts.createPrinter({ removeComments: true }).printFile(syntax)
assert.doesNotMatch(code, /claude-code|from ['"]\.\/register|\b(?:EngineInterface|Runtime|atom|memberOf|read|update|async|ledger|persistence|clock|process)\b|\$(?!\{)/)
checkFrame(loadTreeModule(source))
console.log('frame tree, original control pins, callbacks and native ownership pass (SOURCE/FIXTURE)')
