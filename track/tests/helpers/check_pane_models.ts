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
assert.equal(hash(native), 'f228eeb0b3cc82b167d1d477757eaa6ad1977c4c022aca2e0b2a573388f37ac3', 'exact accepted native integration bytes')
const arch = readFileSync(new URL('../../architecture/archview.toml', import.meta.url), 'utf8')
assert.equal(hash(arch), '85f0b4052b798af50f26f5414b9ed2362e218483048a1ec7bbb35839acbe63ae', 'exact declared architecture edges')
const { paneBanner } = await import('../../hooks/pane-banner-model')
checkPaneModels(paneBanner)
console.log('banner ownership, native integration and frozen parity cases pass (SOURCE/FIXTURE)')
