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
] as const) {
  const accepted = spawnSync('git', ['show', `${commit}:track/${path}`], { cwd: new URL('../../..', import.meta.url), encoding: 'utf8' })
  assert.equal(accepted.status, 0, `accepted ${commit} ${path} must exist`)
  assert.equal(hash(accepted.stdout), expected, `accepted ${commit} ${path} proof retained`)
}
const native = readFileSync(hook('register.tsx'), 'utf8')
// 2026-11-05: preserve all historical pane pins; freeze the behavior-checked P2.1 wiring too.
assert.equal(hash(native), 'e3f6855f903f51b531544689d4e995f6144a2c5c35bdf6180053c2a1d53ab242', 'exact bulk-clear/P2.1 integration bytes')
const arch = readFileSync(new URL('../../architecture/archview.toml', import.meta.url), 'utf8')
assert.equal(hash(arch), '075c3350887caeb8dca4275e91662aa62b71544d38640a7274353d535148016c', 'exact declared architecture edges')
const { paneBanner } = await import('../../hooks/pane-banner-model')
checkPaneModels(paneBanner)
console.log('banner ownership, native integration and frozen parity cases pass (SOURCE/FIXTURE)')
