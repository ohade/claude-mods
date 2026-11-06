// FIXTURE: TRACK-44 corrective Stage A2 (independent source Refuter, 2026-11-06T14:11Z).
// When the longest pointer matches two titles that normalize alike (`Deploy: production` and
// `Deploy: production!`), the request is ambiguous and names nothing. It must not fall through to a
// shorter pointer (`Deploy`) and credit an unrelated row. Pure matcher only; no native Stop execution.
// Run: bun track/tests/helpers/check_track44_ambiguous_colon_title.ts   (cwd = worktree root)
import assert from 'node:assert/strict'
import { waitingArrowIds } from '../../hooks/turn-policy'
import { visibleSteps } from '../../hooks/steps'
import type { Step } from '../../types'

const A: Step = { id: 'plan:1', source: 'plan', subject: 'Deploy', status: 'waiting' }
const B: Step = { id: 'plan:2', source: 'plan', subject: 'Deploy: production', status: 'waiting' }
const C: Step = { id: 'plan:3', source: 'plan', subject: 'Deploy: production!', status: 'waiting' }
const arrows = (text: string, steps: Step[]): string[] => {
  const inventory = visibleSteps(steps).map(s => ({ id: s.id, subject: s.subject }))
  return waitingArrowIds(text, new Set(inventory.map(s => s.id)), inventory)
}

assert.deepEqual(arrows('👉 Deploy: production: go?', [A, B, C]), [],
  'an ambiguous longest exact title names nothing and does not fall through to `Deploy`')
assert.deepEqual(arrows('👉 Deploy: production: go?', [A, B]), ['plan:2'], 'control: without the duplicate, the colon title is named')
assert.deepEqual(arrows('👉 Deploy: go?', [A, B, C]), ['plan:1'], 'the exact shorter title is still named')
assert.deepEqual(arrows('👉 Deploy: produ: go?', [B, C]), [], 'a prefix shared by two duplicate titles names nothing')
console.log('track44 ambiguous colon-title checks passed')
