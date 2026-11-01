// SOURCE/FIXTURE: the banner has pure activity and row owners, with native effects retained.
import assert from 'node:assert/strict'
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
const native = readFileSync(hook('register.tsx'), 'utf8')
assert.equal(hash(native), 'd329e7fb1b664385599a5d486643a8bd255e882a01227141e834ba94168f0e93', 'native changes only imports, palette ownership and designated banner span')
const arch = readFileSync(new URL('../../architecture/archview.toml', import.meta.url), 'utf8')
assert.equal(hash(arch), '9d73a2598282c415ba3da2219b530f7ef2b252a80b50dcc8e58cc2701391abba', 'architecture changes only declared banner edges and empty externals')
const { paneBanner } = await import('../../hooks/pane-banner-model')
checkPaneModels(paneBanner)
console.log('banner ownership, native integration and frozen parity cases pass (SOURCE/FIXTURE)')
