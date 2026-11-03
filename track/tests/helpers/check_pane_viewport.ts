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
// U4: the previous integration proof stays pinned to its accepted commit.
for (const [path, expected] of [['hooks/register.tsx', 'f97a9daba7cae65b753341bba0fdc35a639fc9fc07f50117ee0db2a36fa27ded'], ['architecture/archview.toml', '7195449a856219481f064c702750672471f10223c09c767dd5ed97721bcc1e92']] as const) {
  const accepted = spawnSync('git', ['show', `1bdd7b52fd4ebcde8db795004183a608c351f499:track/${path}`], { cwd: new URL('../../..', import.meta.url), encoding: 'utf8' })
  assert.equal(accepted.status, 0, `accepted pre-U4 ${path} must exist`)
  assert.equal(hash(accepted.stdout), expected, `accepted pre-U4 ${path} proof retained`)
}
for (const [name, expected] of [['register.tsx', 'a8b7247e922f89dac89bc7f89adff7ce2bf13478760265209782b476c5be53c2'], ['pane-layout.ts', 'c99c84921d0342a27bdc98c7b4ca55848e8112325d842e29e725709bfd3801a8']] as const) {
  assert.equal(hash(readFileSync(hook(name), 'utf8')), expected, `${name}: exact planned extraction, all native effects unchanged`)
}
assert.equal(hash(readFileSync(new URL('../../architecture/archview.toml', import.meta.url), 'utf8')), '27d383cf7a8f3be47c1997da2567043b64bd8d56e618e93acaa04adee71cfc79', 'exact declared architecture edges')
const { paneRowMetrics } = await import('../../hooks/pane-row-metrics')
const { paneViewport } = await import('../../hooks/pane-viewport-model')
checkViewport(input => {
  const metrics = paneRowMetrics(input)
  return project(metrics, paneViewport({ ...input, metrics, questionCount: input.questions.length, stepCount: input.steps.length }), input.steps)
})
console.log('viewport literal geometry, original parity, native boundary and scope pass (SOURCE/FIXTURE)')
