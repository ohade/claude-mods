// SOURCE/FIXTURE: row measurements and fitting are pure; native retains its frame and effects.
import assert from 'node:assert/strict'
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
for (const [name, expected] of [['register.tsx', 'ad6346342dc8d7a684ea992e8bb6c5fea2b93e08a5ee8a39bbd1ae30cbf36a94'], ['pane-layout.ts', 'c99c84921d0342a27bdc98c7b4ca55848e8112325d842e29e725709bfd3801a8']] as const) {
  assert.equal(hash(readFileSync(hook(name), 'utf8')), expected, `${name}: exact planned extraction, all native effects unchanged`)
}
assert.equal(hash(readFileSync(new URL('../../architecture/archview.toml', import.meta.url), 'utf8')), '4491808c8cf5c13a136e8e79d6c13c78f4cd17009d022d337dba4b8101c09359', 'exact architecture additions only')
const { paneRowMetrics } = await import('../../hooks/pane-row-metrics')
const { paneViewport } = await import('../../hooks/pane-viewport-model')
checkViewport(input => {
  const metrics = paneRowMetrics(input)
  return project(metrics, paneViewport({ ...input, metrics, questionCount: input.questions.length, stepCount: input.steps.length }), input.steps)
})
console.log('viewport literal geometry, original parity, native boundary and scope pass (SOURCE/FIXTURE)')
