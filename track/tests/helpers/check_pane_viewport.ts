// SOURCE/FIXTURE: row measurements and fitting are pure; native retains its frame and effects.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkViewport, project } from './pane_viewport_cases'

const hook = (name: string) => new URL(`../../hooks/${name}`, import.meta.url)
for (const name of ['pane-row-metrics.ts', 'pane-viewport-model.ts']) {
  const source = readFileSync(hook(name), 'utf8')
  assert.doesNotMatch(source, /claude-code|from ['"]\.\/register|\b(?:EngineInterface|Runtime|atom|memberOf|update|Date|crypto|process)\b|\$(?!\{)/)
}
const { paneRowMetrics } = await import('../../hooks/pane-row-metrics')
const { paneViewport } = await import('../../hooks/pane-viewport-model')
checkViewport(input => {
  const metrics = paneRowMetrics(input)
  return project(metrics, paneViewport({ ...input, metrics, questionCount: input.questions.length, stepCount: input.steps.length }), input.steps, input.questions)
})
console.log('viewport literal geometry, original parity, native boundary and scope pass (SOURCE/FIXTURE)')
