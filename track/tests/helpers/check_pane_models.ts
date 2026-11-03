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
// U4: retain the original accepted byte assertions before updating current pins.
for (const [path, expected] of [['hooks/register.tsx', 'f97a9daba7cae65b753341bba0fdc35a639fc9fc07f50117ee0db2a36fa27ded'], ['architecture/archview.toml', '7195449a856219481f064c702750672471f10223c09c767dd5ed97721bcc1e92']] as const) {
  const accepted = spawnSync('git', ['show', `1bdd7b52fd4ebcde8db795004183a608c351f499:track/${path}`], { cwd: new URL('../../..', import.meta.url), encoding: 'utf8' })
  assert.equal(accepted.status, 0, `accepted pre-U4 ${path} must exist`)
  assert.equal(hash(accepted.stdout), expected, `accepted pre-U4 ${path} proof retained`)
}
const native = readFileSync(hook('register.tsx'), 'utf8')
assert.equal(hash(native), 'a8b7247e922f89dac89bc7f89adff7ce2bf13478760265209782b476c5be53c2', 'exact accepted native integration bytes')
const arch = readFileSync(new URL('../../architecture/archview.toml', import.meta.url), 'utf8')
assert.equal(hash(arch), '27d383cf7a8f3be47c1997da2567043b64bd8d56e618e93acaa04adee71cfc79', 'exact declared architecture edges')
const { paneBanner } = await import('../../hooks/pane-banner-model')
checkPaneModels(paneBanner)
console.log('banner ownership, native integration and frozen parity cases pass (SOURCE/FIXTURE)')
